import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import { collectorStopReceiptSchema } from '@voidr/capture-contracts';
import type { AiRun } from '../shared/ai-tester';
import { parseLoopLaunch } from './deep-link';
import { VoidrServiceClient } from './service-client';

export type AiCaptureRecord = { journeyId: string; generation: string; sessionId: string; cycleId?: string; output?: string; synced?: boolean };
type Api = <T>(path?: string, body?: unknown) => Promise<T>;
type CaptureInput = { runtime: LocalRuntimeConfig; api: Api; run: AiRun; executorId: string; capture: AiCaptureRecord };
export const newAiCapture = (journeyId: string): AiCaptureRecord => ({ journeyId, generation: randomUUID(), sessionId: randomUUID() });

export async function prepareAiCapture(input: CaptureInput) {
  const launch = await input.api<{ recordingUrl: string; cycleId: string }>(`/${input.run.runId}/capture`, { executorId: input.executorId, journeyId: input.capture.journeyId, sessionId: input.capture.sessionId });
  input.capture.cycleId = launch.cycleId;
  const client = new VoidrServiceClient(input.runtime);
  const authorization = await client.validateWebLaunch(parseLoopLaunch(launch.recordingUrl), input.capture.generation);
  const context = authorization.safeContext;
  const loopTest = { scenarioId: context.scenarioId, cycleId: context.cycleId, cycleNumber: context.cycleNumber };
  const verification = { version: 'HIL/1', verificationId: context.verificationId, generation: context.verificationGeneration, loopId: context.scenarioId, cycleNumber: context.cycleNumber };
  return { client, authorization, collector: { scriptUrl: input.runtime.collectorScriptUrl, collectorUrl: input.runtime.collectorUrl, targetUrl: input.run.targetUrl, options: {
    apiKey: authorization.collectorApiKey, collectorUrl: input.runtime.collectorUrl, forcedSessionId: input.capture.sessionId,
    user: { id: `ai-tester:${input.run.runId}`, name: 'Voidr AI' }, system: true, samplingRate: 1,
    applicationId: context.applicationId, environment: input.run.environment, sessionRotation: false,
    captureEnvironmentBundle: true, networkCapture: false, captureResources: false, captureConsole: false,
    privacyLevel: 'mask-user-input', loopTest, verification,
    dataMasking: { text: false, inputs: true, blockSelectors: ['[data-voidr-secret]', '[data-sensitivity="block"]', '[data-voidr-verification-overlay]'] },
    meta: { mode: 'loop-test', host: 'ai-tester', testCase: authorization.mission, loopTest, verification, aiTester: { runId: input.run.runId, journeyId: input.capture.journeyId } },
  } } };
}

export async function syncAiCapture(input: CaptureInput & { persist: () => Promise<void> }) {
  if (input.capture.synced) return;
  if (!input.capture.output) throw new Error('Captura interrompida: evidências locais ainda indisponíveis.');
  const receipt = collectorStopReceiptSchema.parse(JSON.parse(await readFile(join(input.capture.output, 'collector-receipt.json'), 'utf8')));
  if (receipt.sessionId !== input.capture.sessionId) throw new Error('Receipt de outra sessão.');
  await input.api(`/${input.run.runId}/capture/complete`, { executorId: input.executorId, journeyId: input.capture.journeyId, sessionId: receipt.sessionId });
  input.capture.synced = true;
  await input.persist();
}
