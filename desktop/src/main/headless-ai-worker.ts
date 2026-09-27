import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { localRuntimeConfigSchema, type LocalRuntimeConfig } from '@voidr/capture-contracts';
import { aiRunSchema } from '../shared/ai-tester';
import { runHeadlessAiTest, type HeadlessAiTesterOptions } from './headless-ai-tester';

const reference = z.object({ loopId: z.string().min(1).max(200), runId: z.string().uuid() });
const dispatch = reference.extend({ state: z.enum(['pending', 'done']), uploadPending: z.boolean().optional() });
type Dispatch = z.infer<typeof dispatch>;
export type HeadlessWorkerOptions = HeadlessAiTesterOptions & {
  runtime: LocalRuntimeConfig;
  /** Stable identity of this authorized worker; use a separate journal root per identity. */
  actorId: string;
  pollIntervalMs?: number;
};

/** Durable, actor-scoped queue consumer; runs the normal Service-authorized lifecycle. */
export async function runHeadlessAiWorker(options: HeadlessWorkerOptions,
  execute: typeof runHeadlessAiTest = runHeadlessAiTest): Promise<void> {
  const runtime = localRuntimeConfigSchema.parse(options.runtime);
  const actorId = z.string().min(1).max(200).parse(options.actorId);
  const pollMs = z.number().int().min(500).max(60_000).parse(options.pollIntervalMs ?? 3000);
  if (!path.isAbsolute(options.root)) throw new Error('O diretório do worker deve ser absoluto.');
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('Configure TYPESAFE_API_KEY no worker antes de consumir execuções.');
  options.signal?.throwIfAborted();
  const scope = createHash('sha256').update(JSON.stringify([runtime.serviceUrl, runtime.organizationId, actorId])).digest('hex');
  const root = path.join(options.root, scope);
  const queue = path.join(root, 'dispatch');
  await mkdir(queue, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'worker-lock');
  await mkdir(lock, { mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Worker já ativo ou recuperação pendente. Verifique o processo antes de remover o lock.');
    throw error;
  });
  const save = async (job: Dispatch) => {
    const file = path.join(queue, `${job.runId}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  try {
    while (!options.signal?.aborted) {
      const session = await options.session(runtime);
      // Read only this authenticated actor's headless queue; desktop requests are separate.
      const refs = z.array(reference).max(20).parse(await session.client.aiTesterPendingLaunches(session.accessToken, 'headless'));
      const jobs = new Map<string, Dispatch>();
      for (const file of await readdir(queue)) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(file)) continue;
        const job = dispatch.parse(JSON.parse(await readFile(path.join(queue, file), 'utf8')));
        if (file !== `${job.runId}.json`) throw new Error('Identidade do journal de despacho inválida.');
        jobs.set(job.runId, job);
      }
      for (const ref of refs) {
        const previous = jobs.get(ref.runId);
        if (previous && previous.loopId !== ref.loopId) throw new Error('Run associado a outro Loop.');
        if (!previous) {
          const job: Dispatch = { ...ref, state: 'pending' };
          await save(job); jobs.set(job.runId, job);
        }
      }
      for (const job of jobs.values()) {
        if (job.state === 'done' || options.signal?.aborted) continue;
        const current = aiRunSchema.parse(await session.client.aiTesterRequest({ loopId: job.loopId, path: `/${job.runId}`, accessToken: session.accessToken }));
        if (current.runId !== job.runId || current.loopId !== job.loopId) throw new Error('Resposta de execução com identidade divergente.');
        // Once claimed, recover only saved evidence; never repeat uncertain browser actions.
        const mode = current.status === 'ready' ? 'execute' : 'retry-evidence';
        const result = await execute({ runtime, loopId: job.loopId, runId: job.runId }, { ...options, root, mode });
        job.uploadPending = result.uploadPending;
        if (result.uploadPending) {
          await save(job);
          throw new Error('Evidências pendentes preservadas. Reinicie o worker para retomar somente o envio.');
        }
        job.state = 'done'; await save(job);
      }
      await delay(pollMs, undefined, { signal: options.signal });
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error;
  } finally {
    await rmdir(lock);
  }
}
