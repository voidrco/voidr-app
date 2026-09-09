import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchStartupUpdate, releaseServiceUrl } from './update-release';
const input = { serviceUrl: 'https://api.voidr.co/v1', currentVersion: '0.1.17', platform: 'darwin' as const, arch: 'arm64' };
const update = { version: '0.1.18', available: true, automatic: true, url: 'https://storage.example/app.zip', sha256: 'a'.repeat(64), sizeBytes: 100 };
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
afterEach(() => vi.unstubAllGlobals());
describe('startup update feed', () => {
  it('checks without login and pins the device architecture', async () => {
    const request = vi.fn().mockResolvedValue(response(update));
    vi.stubGlobal('fetch', request);
    expect(await fetchStartupUpdate(input)).toMatchObject({ version: '0.1.18', automatic: true, sizeBytes: 100, sha256: 'a'.repeat(64) });
    expect(request.mock.calls[0]![0]).toBe('https://api.voidr.co/v1/capture/updates?appVersion=0.1.17&hostProtocol=CAPTURE-HOST%2F1&platform=mac&arch=arm64');
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
    expect(request.mock.calls[0]![1]).not.toHaveProperty('headers');
  });
  it('requires an explicit signed-release opt-in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...update, automatic: false })));
    expect(await fetchStartupUpdate(input)).toEqual({ version: '0.1.18', automatic: false, notes: undefined });
  });
  it.each([{ ...update, sha256: undefined }, { ...update, url: 'http://example.com/app.zip' }, { ...update, sizeBytes: undefined }])('rejects incomplete or insecure automatic downloads', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)));
    await expect(fetchStartupUpdate(input)).rejects.toThrow();
  });
  it('does not reinstall an equal or older version even if the server advertises it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...update, version: '0.1.16' })));
    expect(await fetchStartupUpdate(input)).toBeNull();
  });
  it('supports rolling service deployments without requesting authentication', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(response({ latestVersion: '0.1.18' }));
    vi.stubGlobal('fetch', request);
    expect(await fetchStartupUpdate(input)).toEqual({ version: '0.1.18', automatic: false });
    expect(request.mock.calls[1]![0]).toContain('/capture/compatibility?');
  });
  it('pins update channels independently of invitations and renderer settings', () => {
    expect(releaseServiceUrl('production')).toBe('https://api.voidr.co/v1');
    expect(releaseServiceUrl('staging')).toBe('https://api-staging.voidr.co/v1');
    expect(releaseServiceUrl('preview')).toBeUndefined();
    expect(releaseServiceUrl('https://evil.example')).toBeUndefined();
  });
});
