import { z } from 'zod';
import { isNewerRelease, type UpdateRelease } from './update-controller';

const stableVersion = z.string().regex(/^\d+\.\d+\.\d+$/).max(40);
const updateSchema = z.object({
  version: stableVersion,
  notes: z.string().max(8_000).optional(),
  available: z.boolean(),
  automatic: z.boolean(),
  url: z.string().url().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sizeBytes: z.number().int().positive().max(1_500_000_000).optional(),
});

export function releaseServiceUrl(channel: string): string | undefined {
  if (channel === 'production') return 'https://api.voidr.co/v1';
  if (channel === 'staging') return 'https://api-staging.voidr.co/v1';
  return undefined;
}

/** Startup is independent of OAuth. Only signed app artifacts are auto-distributed. */
export async function fetchStartupUpdate(input: {
  serviceUrl: string;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<UpdateRelease | null> {
  if (!['arm64', 'x64'].includes(input.arch)) throw new Error('Unsupported architecture');
  const platform = input.platform === 'darwin' ? 'mac' : input.platform === 'win32' ? 'windows' : 'linux';
  const query = new URLSearchParams({ appVersion: input.currentVersion, hostProtocol: 'CAPTURE-HOST/1', platform, arch: input.arch });
  const response = await fetch(`${input.serviceUrl}/capture/updates?${query}`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store',
  });
  if (response.status === 404) {
    // A rolling Service deployment may still serve the previous public contract.
    const fallbackQuery = new URLSearchParams({ appVersion: input.currentVersion, hostProtocol: 'CAPTURE-HOST/1' });
    const fallback = await fetch(`${input.serviceUrl}/capture/compatibility?${fallbackQuery}`, {
      redirect: 'error', signal: AbortSignal.timeout(8_000), cache: 'no-store',
    });
    if (!fallback.ok) throw new Error('Update service unavailable');
    const legacy = z.object({ success: z.literal(true), data: z.object({ latestVersion: stableVersion }) }).parse(await fallback.json());
    return isNewerRelease(legacy.data.latestVersion, input.currentVersion)
      ? { version: legacy.data.latestVersion, automatic: false } : null;
  }
  if (!response.ok) throw new Error('Update service unavailable');
  const { data: update } = z.object({ success: z.literal(true), data: updateSchema }).parse(await response.json());
  if (!update.available || !isNewerRelease(update.version, input.currentVersion)) return null;
  if (!update.automatic) return { version: update.version, notes: update.notes, automatic: false };
  if (!update.url || !update.sha256 || !update.sizeBytes) throw new Error('Incomplete signed update');
  const url = new URL(update.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid download URL');
  return { version: update.version, notes: update.notes, automatic: true,
    url: url.toString(), sha256: update.sha256, sizeBytes: update.sizeBytes };
}
