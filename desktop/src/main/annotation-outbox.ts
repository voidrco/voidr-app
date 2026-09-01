import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import type { SecretWebAuthorization } from './service-client';

export interface AnnotationOutboxCodec {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface DurableAnnotation {
  version: 'DESKTOP-ANNOTATION/1';
  localId: string;
  createdAt: string;
  runtime: LocalRuntimeConfig;
  authorization: SecretWebAuthorization;
  annotation: {
    idempotencyKey: string;
    kind: 'element' | 'region' | 'screen';
    note: string;
    pageUrl: string;
    timestampMs: number;
    selector?: string;
    rect?: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
    screenshotBase64: string;
    cropBase64?: string;
  };
}

export interface AnnotationDrainResult {
  syncedIds: string[];
  failedIds: string[];
  pendingCount: number;
}

function isDurableAnnotation(value: unknown): value is DurableAnnotation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DurableAnnotation>;
  return (
    item.version === 'DESKTOP-ANNOTATION/1' &&
    typeof item.localId === 'string' &&
    Boolean(item.runtime) &&
    Boolean(item.authorization) &&
    Boolean(item.annotation) &&
    typeof item.annotation?.note === 'string' &&
    typeof item.annotation?.screenshotBase64 === 'string'
  );
}

export class AnnotationOutbox {
  readonly directory: string;
  #drainFlight?: Promise<AnnotationDrainResult>;

  constructor(
    userDataDirectory: string,
    private readonly codec: AnnotationOutboxCodec,
  ) {
    this.directory = path.join(userDataDirectory, 'annotation-outbox');
  }

  async enqueue(
    input: Omit<DurableAnnotation, 'version' | 'localId' | 'createdAt'>,
  ): Promise<DurableAnnotation> {
    const item: DurableAnnotation = {
      ...input,
      version: 'DESKTOP-ANNOTATION/1',
      localId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#file(item.localId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const encrypted = this.codec.encrypt(JSON.stringify(item));
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(encrypted);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    try {
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Some Windows filesystems cannot fsync directory handles. The file was
      // already flushed and atomically renamed, so durability still degrades safely.
    }
    return item;
  }

  async pendingCount(): Promise<number> {
    return (await this.#files()).length;
  }

  drain(
    upload: (item: DurableAnnotation) => Promise<void>,
  ): Promise<AnnotationDrainResult> {
    if (this.#drainFlight) return this.#drainFlight;
    this.#drainFlight = this.#drain(upload).finally(() => {
      this.#drainFlight = undefined;
    });
    return this.#drainFlight;
  }

  async #drain(
    upload: (item: DurableAnnotation) => Promise<void>,
  ): Promise<AnnotationDrainResult> {
    const syncedIds: string[] = [];
    const failedIds: string[] = [];
    const attempted = new Set<string>();
    while (true) {
      const files = (await this.#files()).filter(
        (file) => !attempted.has(file),
      );
      if (files.length === 0) break;
      for (const file of files) {
        attempted.add(file);
        let item: DurableAnnotation | undefined;
        try {
          const decrypted = this.codec.decrypt(await readFile(file));
          const parsed: unknown = JSON.parse(decrypted);
          if (!isDurableAnnotation(parsed))
            throw new Error('Invalid annotation outbox entry.');
          item = parsed;
          await upload(item);
          await unlink(file);
          syncedIds.push(item.localId);
        } catch {
          failedIds.push(item?.localId ?? path.basename(file, '.bin'));
        }
      }
    }
    return {
      syncedIds,
      failedIds,
      pendingCount: await this.pendingCount(),
    };
  }

  async #files(): Promise<string[]> {
    try {
      return (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.bin'))
        .map((entry) => path.join(this.directory, entry.name))
        .sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
  }

  #file(localId: string): string {
    return path.join(this.directory, `${localId}.bin`);
  }
}
