import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PendingLaunchStore } from './pending-launch';
import { parseDesktopCaptureLaunch } from './deep-link';
const launch = parseDesktopCaptureLaunch('voidr://capture/loops/lts_1b8c167cfb2247d4863801953fc14d8a/cycles/12de63f9-4d32-4c25-a1a6-530e34e14839?organization=org_XpZs54aP8Oop8qUz&surface=web&deployment=production&v=1&attempt=3fbf4a47-5c5d-4a54-9371-9d68ba60f405');
let dir: string;
function fixture() {
  dir = mkdtempSync(path.join(tmpdir(), 'capture-launch-test-'));
  const file = path.join(dir, 'pending.json');
  return { file, store: new PendingLaunchStore(file) };
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
describe('pending update launch', () => {
  it('resumes the exact invitation once, retaining tenant, environment and attempt', () => {
    const { store } = fixture();
    store.save(launch, 100);
    expect(store.take(101)).toEqual(launch);
    expect(store.take(102)).toBeUndefined();
  });
  it('does not persist fields outside the secret-free contract', () => {
    const { store, file } = fixture();
    store.save({ ...launch, token: 'secret' } as typeof launch);
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
  });
  it('expires old invitations and consumes malformed state safely', () => {
    const { store, file } = fixture();
    store.save(launch, 1);
    expect(store.take(86_400_002)).toBeUndefined();
    writeFileSync(file, '{bad');
    expect(store.take()).toBeUndefined();
  });
  it('clears a completed invitation instead of reopening it after update', () => {
    const { store } = fixture();
    store.save(launch);
    store.save(undefined);
    expect(store.take()).toBeUndefined();
  });
});
