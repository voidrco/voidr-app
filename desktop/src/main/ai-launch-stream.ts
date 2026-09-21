import type { WebContents } from 'electron';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import { pendingAiLaunchesSchema, type AiLaunchEvent } from '../shared/ai-launch';
import type { VoidrServiceClient } from './service-client';

type Workspace = { client: VoidrServiceClient; accessToken?: string };
type Subscription = { id: string; controller: AbortController };

function streamEvent(frame: string): AiLaunchEvent | undefined {
  const lines = frame.split('\n');
  const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  if (type === 'heartbeat') return { type: 'connected' };
  if (type !== 'pending') return;
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  const parsed = JSON.parse(data) as { launches?: unknown };
  return { type: 'pending', launches: pendingAiLaunchesSchema.parse(parsed.launches) };
}

async function readEvents(response: Response, receive: (event: AiLaunchEvent) => void) {
  if (!response.body) throw new Error('Canal de testes sem conteúdo.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { buffer: '' };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      state.buffer = (state.buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      if (state.buffer.length > 65_536) throw new Error('Evento de testes excedeu o limite.');
      const frames = state.buffer.split('\n\n');
      state.buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = streamEvent(frame);
        if (event) receive(event);
      }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class AiLaunchStream {
  private readonly subscriptions = new Map<number, Subscription>();
  constructor(private readonly workspace: (runtime: LocalRuntimeConfig) => Promise<Workspace>) {}

  start(sender: WebContents, id: string, runtime: LocalRuntimeConfig): void {
    this.subscriptions.get(sender.id)?.controller.abort();
    const subscription = { id, controller: new AbortController() };
    this.subscriptions.set(sender.id, subscription);
    void this.receive(sender, subscription, runtime);
  }

  stop(sender: WebContents, id: string): void {
    const subscription = this.subscriptions.get(sender.id);
    if (subscription?.id === id) subscription.controller.abort();
  }

  private async receive(sender: WebContents, subscription: Subscription, runtime: LocalRuntimeConfig): Promise<void> {
    const { controller, id } = subscription;
    const state = { timer: setTimeout(() => controller.abort(), 20_000), intentional: false };
    const close = () => { state.intentional = true; controller.abort(); };
    const send = (event: AiLaunchEvent) => {
      if (!sender.isDestroyed() && this.subscriptions.get(sender.id) === subscription) {
        sender.send('ai-tester:launch-event', { subscriptionId: id, event });
      }
    };
    sender.once('destroyed', close);
    try {
      const workspace = await this.workspace(runtime);
      controller.signal.throwIfAborted();
      const response = await workspace.client.aiTesterLaunchStream(controller.signal, workspace.accessToken);
      await readEvents(response, event => {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => controller.abort(), 45_000);
        send(event);
      });
    } catch {}
    finally {
      clearTimeout(state.timer);
      controller.abort();
      sender.removeListener('destroyed', close);
      if (!state.intentional) send({ type: 'disconnected' });
      if (this.subscriptions.get(sender.id) === subscription) this.subscriptions.delete(sender.id);
    }
  }
}
