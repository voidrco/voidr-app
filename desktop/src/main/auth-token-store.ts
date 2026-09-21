import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AuthTokenStore {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
  remove(key: string): void;
}

export function encryptedAuthTokenStore(deps: { directory: () => string; available: () => boolean;
  encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string }): AuthTokenStore {
  const file = (key: string) => path.join(deps.directory(), `${createHash('sha256').update(key).digest('hex')}.bin`);
  return {
    read(key) {
      if (!deps.available()) return undefined;
      try { return deps.decrypt(readFileSync(file(key))); } catch { return undefined; }
    },
    write(key, value) {
      if (!deps.available()) return;
      mkdirSync(deps.directory(), { recursive: true, mode: 0o700 });
      const temporary = `${file(key)}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, deps.encrypt(value), { mode: 0o600 });
        renameSync(temporary, file(key));
      } finally { rmSync(temporary, { force: true }); }
    },
    remove(key) { rmSync(file(key), { force: true }); },
  };
}
