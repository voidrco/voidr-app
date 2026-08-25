import type { LocalRuntimeConfig } from '@voidr/capture-contracts';

/**
 * Endpoints are per ENVIRONMENT, so they are baked at build time — a customer
 * should never have to type a URL. The organization is per USER, so it is NOT
 * baked: it arrives with the `voidr://` deep link and overwrites the
 * placeholder below on the first launch.
 *
 * Baking per organization would mean one artifact per customer, and on macOS
 * rewriting anything inside a signed `.app` invalidates the signature (and the
 * notarization with it). Per-customer configuration must always arrive as data.
 */
export type CaptureChannel = 'local' | 'preview' | 'production';

/** Replaced by the deep link before any request that needs a real tenant. */
const PENDING_ORGANIZATION = 'org_pending_launch';

const LOCAL: LocalRuntimeConfig = {
  serviceUrl: 'http://127.0.0.1:3000/v1',
  collectorUrl: 'http://localhost:3100',
  collectorScriptUrl: 'http://localhost:8889/dist/recorder.min.js',
  platformUrl: 'http://localhost:3030',
  localAdapter: true,
  localDevKey: 'voidr-verification-local',
  organizationId: 'org_verification_local',
};

const PRODUCTION: LocalRuntimeConfig = {
  serviceUrl: 'https://api.voidr.co/v1',
  collectorUrl: 'https://collector.voidr.co',
  collectorScriptUrl: 'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js',
  platformUrl: 'https://app.voidr.co',
  localAdapter: false,
  localDevKey: 'voidr-capture-production',
  organizationId: PENDING_ORGANIZATION,
};

/**
 * Preview is a throwaway environment for a single branch, so it may bake a test
 * organization to stay usable before any deep link arrives. Production never
 * does: there the tenant only ever comes from the link.
 */
function preview(slug: string, organizationId: string): LocalRuntimeConfig {
  return {
    serviceUrl: `https://${slug}.api-preview.voidr.co/v1`,
    collectorUrl: 'https://collector-staging.voidr.co',
    collectorScriptUrl: 'https://cdn.voidr.co/voidr-collector/staging/latest/recorder.min.js',
    platformUrl: `https://${slug}.app-preview.voidr.co`,
    localAdapter: false,
    localDevKey: 'voidr-capture-preview',
    organizationId,
  };
}

function resolveChannel(): CaptureChannel {
  const declared = import.meta.env.VITE_VOIDR_CAPTURE_CHANNEL;
  if (declared === 'local' || declared === 'preview' || declared === 'production') return declared;
  return import.meta.env.DEV ? 'local' : 'production';
}

export const captureChannel: CaptureChannel = resolveChannel();

export const defaultRuntime: LocalRuntimeConfig =
  captureChannel === 'local'
    ? LOCAL
    : captureChannel === 'preview'
      ? preview(
          import.meta.env.VITE_VOIDR_CAPTURE_PREVIEW_SLUG || 'release-capture',
          import.meta.env.VITE_VOIDR_CAPTURE_ORGANIZATION || PENDING_ORGANIZATION,
        )
      : PRODUCTION;

/**
 * A secret-free launch carries only a server-owned deployment label. Resolve
 * that label against baked, allowlisted endpoints so a production link cannot
 * accidentally query a developer's localhost (and cannot inject an origin).
 */
export function runtimeForDeployment(
  deployment: 'local' | 'preview' | 'production',
  _current: LocalRuntimeConfig,
  organizationId: string,
  previewSlug?: string,
): LocalRuntimeConfig {
  // A deep link's deployment label is server-owned. Never let a persisted
  // runtime from an older desktop build override its baked trust boundary —
  // stale dev keys/endpoints otherwise turn a valid local Loop into a
  // misleading tenant-scoped "not found" response.
  if (deployment === 'preview' && !previewSlug) throw new Error('O link de preview está incompleto.');
  const selected =
    deployment === 'production'
      ? PRODUCTION
      : deployment === 'preview'
        ? preview(previewSlug!, PENDING_ORGANIZATION)
        : LOCAL;
  return { ...selected, organizationId };
}

export function isPendingOrganization(organizationId: string): boolean {
  return organizationId === PENDING_ORGANIZATION;
}
