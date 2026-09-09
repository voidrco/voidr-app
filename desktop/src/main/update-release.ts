import { z } from 'zod';
import { isNewerRelease, type UpdateRelease } from './update-controller';

const catalogSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  notes: z.string().max(8_000).optional(),
  builds: z.array(z.object({
    platform: z.enum(['mac', 'windows', 'linux']),
    arch: z.enum(['arm64', 'x64']),
    format: z.string(),
    sizeBytes: z.number().int().positive().optional(),
  })).max(64),
});
const downloadSchema = z.object({ url: z.string().url(), version: z.string() });

export function releaseServiceUrl(channel: string): string | undefined {
  if (channel === 'production') return 'https://api.voidr.co/v1';
  if (channel === 'staging') return 'https://api-staging.voidr.co/v1';
  return undefined;
}

export async function fetchUpdateRelease(input: {
  serviceUrl: string;
  token: string;
  participant: boolean;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<UpdateRelease | null> {
  const prefix = input.participant ? 'loop-participant/capture' : 'capture';
  const request = async (suffix: string) => {
    const response = await fetch(`${input.serviceUrl}/${prefix}/${suffix}`, {
      headers: { Authorization: `Bearer ${input.token}` },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Release catalog unavailable');
    const body = await response.json() as { success: boolean; data: unknown };
    if (!body.success) throw new Error('Invalid catalog');
    return body.data;
  };
  const catalog = catalogSchema.parse(await request('releases'));
  if (!isNewerRelease(catalog.version, input.currentVersion)) return null;
  const platform = input.platform === 'darwin' ? 'mac' : input.platform === 'win32' ? 'windows' : 'linux';
  const format = platform === 'mac' ? 'zip' : platform === 'windows' ? 'exe' : 'deb';
  const build = catalog.builds.find((item) => item.platform === platform && item.arch === input.arch && item.format === format);
  if (!build) throw new Error('No compatible release');
  const query = new URLSearchParams({ platform, arch: input.arch, format });
  const download = downloadSchema.parse(await request(`download?${query}`));
  // A release may be promoted between these two calls. Retry from the catalog
  // instead of downloading a mismatched version or validating the wrong size.
  if (download.version !== catalog.version) throw new Error('Release changed');
  const url = new URL(download.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid download URL');
  return { version: catalog.version, notes: catalog.notes, url: url.toString(), sizeBytes: build.sizeBytes };
}
