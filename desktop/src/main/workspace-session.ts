import {
  PENDING_CAPTURE_ORGANIZATION_ID,
  localRuntimeConfigSchema,
  type LocalRuntimeConfig,
} from '@voidr/capture-contracts';
import { VoidrServiceClient } from './service-client';

type OrganizationAuthSession = {
  accessToken(
    profile: 'organization',
    organizationId: string,
  ): Promise<string>;
};

function cleanUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('O contexto deste workspace não é confiável. Abra o teste novamente pela Voidr.');
  }
  return url;
}

function previewSlug(hostname: string, suffix: string): string | null {
  const ending = `.${suffix}`;
  if (!hostname.endsWith(ending)) return null;
  const slug = hostname.slice(0, -ending.length);
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

function assertTrustedWorkspaceRuntime(runtime: LocalRuntimeConfig): void {
  const service = cleanUrl(runtime.serviceUrl);
  const platform = cleanUrl(runtime.platformUrl);

  if (runtime.localAdapter) {
    const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if (!loopback.has(service.hostname) || !loopback.has(platform.hostname)) {
      throw new Error('O adaptador local só pode usar serviços desta máquina.');
    }
    return;
  }

  const production =
    service.origin === 'https://api.voidr.co' &&
    service.pathname.replace(/\/+$/, '') === '/v1' &&
    platform.origin === 'https://platform.voidr.co' &&
    platform.pathname.replace(/\/+$/, '') === '';
  if (production) return;

  const servicePreview = previewSlug(service.hostname, 'api-preview.voidr.co');
  const platformPreview = previewSlug(platform.hostname, 'app-preview.voidr.co');
  const preview =
    service.protocol === 'https:' &&
    service.port === '' &&
    service.pathname.replace(/\/+$/, '') === '/v1' &&
    platform.protocol === 'https:' &&
    platform.port === '' &&
    platform.pathname.replace(/\/+$/, '') === '' &&
    servicePreview != null &&
    servicePreview === platformPreview;
  if (!preview) {
    throw new Error('O contexto deste workspace não é confiável. Abra o teste novamente pela Voidr.');
  }
}

export function workspacePlatformLoopsUrl(runtimeInput: unknown): string {
  const runtime = localRuntimeConfigSchema.parse(runtimeInput);
  assertTrustedWorkspaceRuntime(runtime);
  return new URL('/loops', runtime.platformUrl).toString();
}

export async function createWorkspaceSession(
  runtimeInput: unknown,
  auth: OrganizationAuthSession,
): Promise<{ client: VoidrServiceClient; accessToken?: string }> {
  const runtime = localRuntimeConfigSchema.parse(runtimeInput);
  assertTrustedWorkspaceRuntime(runtime);
  const client = new VoidrServiceClient(runtime);
  if (runtime.localAdapter) return { client };
  if (runtime.organizationId === PENDING_CAPTURE_ORGANIZATION_ID) {
    throw new Error(
      'Conecte este aplicativo ao seu workspace pela plataforma Voidr.',
    );
  }
  return {
    client,
    accessToken: await auth.accessToken('organization', runtime.organizationId),
  };
}
