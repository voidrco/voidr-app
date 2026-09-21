import { app } from 'electron';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';

export function isAuthenticatedLocalRuntime(runtime: LocalRuntimeConfig) {
  const development = app?.isPackaged === false && Boolean(process.env.VOIDR_CAPTURE_DEV_SERVER_URL);
  if (!development && process.env.VOIDR_CAPTURE_RELEASE_CHANNEL !== 'local') return false;
  const endpoints = [runtime.serviceUrl, runtime.platformUrl, runtime.collectorUrl, runtime.collectorScriptUrl].map(value => new URL(value));
  if (!endpoints.every(url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return false;
  const [service, platform] = endpoints;
  return service!.protocol === 'http:' && service!.port === '3000' && service!.pathname.replace(/\/+$/, '') === '/v1'
    && platform!.protocol === 'http:' && platform!.port === '3030' && platform!.pathname.replace(/\/+$/, '') === '';
}
