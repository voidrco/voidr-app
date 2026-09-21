import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import type { AiLaunchEvent, PendingAiLaunch } from '../shared/ai-launch';

type LaunchApi = {
  pendingLaunches(runtime: LocalRuntimeConfig): Promise<PendingAiLaunch[]>;
  watchLaunches?(runtime: LocalRuntimeConfig, receive: (event: AiLaunchEvent) => void): () => void;
};
type InboxOptions = {
  api: LaunchApi;
  runtime: LocalRuntimeConfig;
  receive: (launches: PendingAiLaunch[]) => void;
  healthy: () => void;
  unavailable: () => void;
};

const retryDelay = (failures: number) => Math.min(60_000, 10_000 * 2 ** Math.min(3, Math.max(0, failures - 1)));
const jitter = (delay: number) => Math.min(60_000, Math.round(delay * (0.9 + Math.random() * 0.2)));

export function monitorAiLaunchInbox(options: InboxOptions): () => void {
  const state = {
    active: true, polling: false, connected: false, connecting: false,
    failures: 0, empty: 0, streamFailures: 0, reconnectAt: 0, lastQueryAt: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    close: undefined as (() => void) | undefined,
  };
  const healthy = () => { state.failures = 0; options.healthy(); };
  const schedule = (delay: number) => {
    clearTimeout(state.timer);
    if (state.active && !state.connected && navigator.onLine) {
      state.timer = setTimeout(() => void refresh(), delay);
    }
  };
  const receive = (event: AiLaunchEvent) => {
    if (!state.active) return;
    if (event.type === 'disconnected') {
      state.connected = false;
      state.connecting = false;
      state.reconnectAt = Date.now() + jitter(retryDelay(++state.streamFailures));
      state.close?.();
      state.close = undefined;
      schedule(0);
      return;
    }
    state.connecting = false;
    state.connected = true;
    state.streamFailures = 0;
    clearTimeout(state.timer);
    healthy();
    if (event.type === 'pending') options.receive(event.launches);
  };
  const connect = () => {
    if (!state.active || !navigator.onLine || state.connected || state.connecting
      || Date.now() < state.reconnectAt || !options.api.watchLaunches) return;
    state.connecting = true;
    try { state.close = options.api.watchLaunches(options.runtime, receive); }
    catch { receive({ type: 'disconnected' }); }
  };
  const refresh = async (force = false) => {
    if (!state.active || state.polling || !navigator.onLine || (state.connected && !force)) return;
    clearTimeout(state.timer);
    state.polling = true;
    state.lastQueryAt = Date.now();
    try {
      const launches = await options.api.pendingLaunches(options.runtime);
      if (!state.active) return;
      healthy();
      state.empty = launches.length ? 0 : Math.min(3, state.empty + 1);
      options.receive(launches);
    } catch {
      if (state.active && ++state.failures >= 3 && !state.connected) options.unavailable();
    } finally {
      state.polling = false;
      connect();
      schedule(jitter(state.failures ? retryDelay(state.failures) : Math.max(10_000, state.empty * 10_000)));
    }
  };
  const focus = () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastQueryAt >= 3000) void refresh(true);
  };
  const offline = () => {
    clearTimeout(state.timer);
    state.close?.();
    state.close = undefined;
    state.connecting = false;
    state.connected = false;
  };
  const online = () => { state.reconnectAt = 0; connect(); void refresh(true); };
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', focus);
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  connect();
  schedule(options.api.watchLaunches ? 10_000 : 0);
  return () => {
    state.active = false;
    clearTimeout(state.timer);
    state.close?.();
    window.removeEventListener('focus', focus);
    document.removeEventListener('visibilitychange', focus);
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
  };
}
