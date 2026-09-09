import { describe, expect, it, vi } from 'vitest';
import { CaptureUpdater, isNewerRelease, type UpdateDependencies } from './update-controller';

function fixture(overrides: Partial<UpdateDependencies> = {}) {
  const deps: UpdateDependencies = {
    currentVersion: '0.1.17', enabled: true, automatic: true,
    release: vi.fn(async () => ({ version: '0.1.18', url: 'https://storage.example/app.zip', sizeBytes: 100 })),
    download: vi.fn(async (_release, progress) => { progress(50, 100, 10); return '/private/update.zip'; }),
    stage: vi.fn(async () => {}), cleanup: vi.fn(async () => {}), canRestart: () => true,
    preserveLaunch: vi.fn(), install: vi.fn(), publish: vi.fn(), ...overrides,
  };
  return { updater: new CaptureUpdater(deps), deps };
}
describe('Capture automatic updates', () => {
  it('reports actual download and verified readiness in order', async () => {
    const { updater, deps } = fixture();
    await updater.check();
    expect(vi.mocked(deps.publish).mock.calls.map(([state]) => state.phase)).toEqual(['checking', 'downloading', 'downloading', 'verifying', 'ready']);
    expect(vi.mocked(deps.publish).mock.calls[2]![0]).toMatchObject({ transferred: 50, total: 100, bytesPerSecond: 10 });
    expect(deps.install).not.toHaveBeenCalled();
    expect(updater.state.phase).toBe('ready');
    updater.restart();
    expect(deps.preserveLaunch).toHaveBeenCalledOnce();
    expect(deps.install).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.preserveLaunch).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.install).mock.invocationCallOrder[0]!);
  });
  it('coalesces simultaneous checks and never downloads a ready update twice', async () => {
    const { updater, deps } = fixture();
    const first = updater.check();
    expect(updater.check(true)).toBe(first);
    await first;
    await updater.check();
    expect(deps.download).toHaveBeenCalledOnce();
  });
  it('never restarts an active capture or bypasses failed launch preservation', async () => {
    let busy = true;
    const { updater, deps } = fixture({ canRestart: () => !busy });
    await updater.check();
    expect(updater.restart().phase).toBe('ready');
    expect(deps.install).not.toHaveBeenCalled();
    busy = false;
    vi.mocked(deps.preserveLaunch).mockImplementation(() => { throw new Error('Disk full'); });
    expect(updater.restart().phase).toBe('ready');
    expect(deps.install).not.toHaveBeenCalled();
  });
  it('allows retry after a verification failure and cleans temporary files', async () => {
    const { updater, deps } = fixture({ stage: vi.fn().mockRejectedValueOnce(new Error('https://private?token=secret')).mockResolvedValueOnce(undefined) });
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(JSON.stringify(updater.state)).not.toContain('secret');
    expect(deps.install).not.toHaveBeenCalled();
    await updater.check(true);
    expect(updater.state.phase).toBe('ready');
    expect(deps.cleanup).toHaveBeenCalledTimes(2);
  });
  it('does not open authentication for a background check without a session', async () => {
    const { updater, deps } = fixture({ release: vi.fn(async () => 'sign-in' as const) });
    await updater.check();
    expect(deps.release).toHaveBeenCalledWith(false);
    expect(updater.state.phase).toBe('sign-in');
    expect(deps.download).not.toHaveBeenCalled();
  });
  it('offers an installer for platforms without native update support', async () => {
    const { updater, deps } = fixture({ automatic: false });
    await updater.check();
    expect(updater.state.phase).toBe('manual');
    updater.restart();
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });
  it('does not contact releases from a source or preview build', async () => {
    const { updater, deps } = fixture({ enabled: false });
    await updater.check(true);
    expect(deps.release).not.toHaveBeenCalled();
  });
  it.each(['0.1.17', '0.1.16', '0.1.18-beta.1', 'bad', '999999999999999999999.1.1'])('never installs an equal, older, or unsupported version %s', async (version) => {
    const { updater, deps } = fixture({ release: async () => ({ version, url: 'https://example.com' }) });
    await updater.check();
    expect(deps.download).not.toHaveBeenCalled();
  });
  it('compares numeric versions instead of lexicographic order', () => {
    expect(isNewerRelease('0.1.100', '0.1.99')).toBe(true);
    expect(isNewerRelease('0.2.0', '0.1.99')).toBe(true);
    expect(isNewerRelease('0.1.99', '1.0.0')).toBe(false);
  });
});
