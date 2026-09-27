import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import { z } from 'zod';
import { localRuntimeConfigSchema } from '@voidr/capture-contracts';
import type { AiRequest, AiState } from '../shared/ai-tester';
import { AiTesterController } from './ai-tester-controller';
import { HeadlessJourneyExecutor } from './headless-journey-executor';

type ControllerDependencies = ConstructorParameters<typeof AiTesterController>[0];
export type HeadlessAiTesterOptions = {
  root: string;
  session: ControllerDependencies['session'];
  publish?: ControllerDependencies['publish'];
  signal?: AbortSignal;
  timeoutMs?: number;
  mode?: 'execute' | 'retry-evidence';
};

/** Execute only a run already requested through Service, with its normal claim and authorization. */
export async function runHeadlessAiTest(input: AiRequest & { runId: string }, options: HeadlessAiTesterOptions): Promise<AiState> {
  const runId = z.string().uuid().parse(input.runId);
  const runtime = localRuntimeConfigSchema.parse(input.runtime);
  if (!path.isAbsolute(options.root)) throw new Error('O diretório do executor deve ser absoluto.');
  const timeoutMs = z.number().int().min(1000).max(3_600_000).parse(options.timeoutMs ?? 600_000);
  options.signal?.throwIfAborted();
  // A journal from another service/workspace must never replace a previous run's journal.
  const scope = createHash('sha256').update(JSON.stringify([runtime.serviceUrl, runtime.organizationId])).digest('hex');
  const root = path.join(options.root, scope);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, `${runId}.worker-lock`);
  await mkdir(lock, { mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Este run já tem um executor local. Confirme que ele terminou antes de recuperar o lock.');
    throw error;
  });
  let finish!: (state: AiState) => void;
  const completed = new Promise<AiState>(resolve => { finish = resolve; });
  const controller = new AiTesterController({
    root, loops: new HeadlessJourneyExecutor(), session: options.session,
    openExternal: async () => { throw new Error('Evidências devem ser abertas pela interface do Assistant.'); },
    publish: state => {
      if (!state.busy) finish(state);
      // Observer failures must not interrupt browser cleanup or evidence persistence.
      try { options.publish?.(state); } catch { /* The durable journal remains authoritative. */ }
    },
  });
  let cancellation: Promise<unknown> | undefined;
  let cancelRequested = false;
  const cancel = () => {
    cancelRequested = true;
    // start() may still be authenticating; repeat after it installs the current run.
    cancellation = controller.cancel().catch(() => undefined);
  };
  const timer = setTimeout(cancel, timeoutMs);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) cancel();
    if (options.mode === 'retry-evidence') {
      options.signal?.throwIfAborted();
      return await controller.retry({ ...input, runtime, runId });
    }
    await controller.start({ ...input, runtime, runId });
    if (cancelRequested) cancel();
    // Cancellation waits for the engine to close Chromium and preserve partial evidence.
    return await completed;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    await cancellation;
    await rmdir(lock);
  }
}
