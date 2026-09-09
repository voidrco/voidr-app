import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { desktopCaptureLaunchSchema, type DesktopCaptureLaunch } from '@voidr/capture-contracts';

/** Only the validated, secret-free descriptor survives a requested update. */
export class PendingLaunchStore {
  constructor(private readonly filename: string) {}
  save(launch: DesktopCaptureLaunch | undefined, now = Date.now()): void {
    if (!launch) { rmSync(this.filename, { force: true }); return; }
    const descriptor = desktopCaptureLaunchSchema.parse(launch);
    writeFileSync(`${this.filename}.tmp`, JSON.stringify({ savedAt: now, launch: descriptor }), { mode: 0o600 });
    renameSync(`${this.filename}.tmp`, this.filename);
  }
  take(now = Date.now()): DesktopCaptureLaunch | undefined {
    try {
      const raw = readFileSync(this.filename, 'utf8');
      if (raw.length > 8_192) return undefined;
      const value = JSON.parse(raw);
      if (typeof value.savedAt !== 'number' || value.savedAt > now || now - value.savedAt > 24 * 60 * 60_000) return undefined;
      return desktopCaptureLaunchSchema.parse(value.launch);
    } catch { return undefined; }
    finally { try { rmSync(this.filename, { force: true }); } catch { /* unreadable state must not prevent startup */ } }
  }
}
