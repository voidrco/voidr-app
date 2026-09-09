import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUpdateRelease, releaseServiceUrl } from './update-release';
const input = { serviceUrl: 'https://api.voidr.co/v1', token: 'private-token', participant: false, currentVersion: '0.1.17', platform: 'darwin' as const, arch: 'arm64' };
const catalog = { version: '0.1.18', builds: [{ platform: 'mac', arch: 'arm64', format: 'zip', sizeBytes: 100 }] };
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
afterEach(() => vi.unstubAllGlobals());
describe('authenticated update catalog', () => {
  it('uses the exact architecture and ZIP without exposing the token to downloads', async () => {
    const request = vi.fn().mockResolvedValueOnce(response(catalog)).mockResolvedValueOnce(response({ version: '0.1.18', url: 'https://storage.googleapis.com/private/update.zip?signature=abc' }));
    vi.stubGlobal('fetch', request);
    expect(await fetchUpdateRelease(input)).toMatchObject({ version: '0.1.18', sizeBytes: 100 });
    expect(request.mock.calls[1]![0]).toBe('https://api.voidr.co/v1/capture/download?platform=mac&arch=arm64&format=zip');
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer private-token' } });
  });
  it('uses participant catalog only for a participant session', async () => {
    const request = vi.fn().mockResolvedValue(response({ ...catalog, version: '0.1.17' }));
    vi.stubGlobal('fetch', request);
    expect(await fetchUpdateRelease({ ...input, participant: true })).toBeNull();
    expect(request.mock.calls[0]![0]).toBe('https://api.voidr.co/v1/loop-participant/capture/releases');
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects a release changed between catalog and signed download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(catalog)).mockResolvedValueOnce(response({ version: '0.1.19', url: 'https://storage.googleapis.com/app.zip' })));
    await expect(fetchUpdateRelease(input)).rejects.toThrow('Release changed');
  });
  it('never substitutes another CPU architecture', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(catalog)));
    await expect(fetchUpdateRelease({ ...input, arch: 'x64' })).rejects.toThrow('No compatible');
  });
  it('pins update channels independently of invitations and renderer settings', () => {
    expect(releaseServiceUrl('production')).toBe('https://api.voidr.co/v1');
    expect(releaseServiceUrl('staging')).toBe('https://api-staging.voidr.co/v1');
    expect(releaseServiceUrl('preview')).toBeUndefined();
    expect(releaseServiceUrl('https://evil.example')).toBeUndefined();
  });
});
