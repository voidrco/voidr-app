import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AnnotationOutbox,
  type AnnotationOutboxCodec,
} from './annotation-outbox';

const codec: AnnotationOutboxCodec = {
  encrypt: (value) =>
    Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
  decrypt: (value) =>
    Buffer.from(value.toString().slice('sealed:'.length), 'base64').toString(),
};

function fixture() {
  return {
    runtime: {
      serviceUrl: 'https://api.example.test/v1',
      collectorUrl: 'https://collector.example.test',
      collectorScriptUrl: 'https://cdn.example.test/recorder.js',
      platformUrl: 'https://app.example.test',
      organizationId: 'org_test',
      localAdapter: false,
      localDevKey: '',
    },
    authorization: {
      safeContext: {
        scenarioId: 'loop_test',
        scenarioName: 'Checkout resiliente',
        cycleId: '19a1ee62-a15d-4c2f-8da8-6dd329001887',
        applicationId: 'app_test',
        verificationId: 'b524dd4f-7961-42cc-b7fe-8f92e726e5df',
        verificationGeneration: '3732273f-4067-423e-bb47-0c16cfeff4ef',
        lifecycleGeneration: '3f6be367-ff86-433f-a908-0d1258967e8e',
        lifecycleVersion: 1,
        safeTargetUrl: 'https://app.example.test',
      },
      collectorApiKey: 'collector-secret',
      attachToken: 'attach-secret',
      verificationToken: 'verification-secret',
      verificationExpiresAt: '2026-08-22T00:00:00.000Z',
      mission: 'Validar checkout',
    },
    annotation: {
      idempotencyKey: 'desktop-annotation:generation:annotation',
      kind: 'screen' as const,
      note: 'O botão travou após o clique',
      pageUrl: 'https://app.example.test/checkout',
      timestampMs: 1250,
      viewport: { width: 1280, height: 720 },
      screenshotBase64: 'base64-image',
    },
  };
}

describe('AnnotationOutbox', () => {
  it('durably encrypts before acknowledging and removes only after upload succeeds', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'voidr-annotation-outbox-'),
    );
    const outbox = new AnnotationOutbox(root, codec);
    const item = await outbox.enqueue(fixture());
    const [file] = await readdir(outbox.directory);
    const raw = await readFile(path.join(outbox.directory, file!), 'utf8');

    expect(raw).not.toContain(item.annotation.note);
    expect(raw).not.toContain('verification-secret');
    expect(await outbox.pendingCount()).toBe(1);

    const upload = vi.fn().mockResolvedValue(undefined);
    const result = await outbox.drain(upload);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ localId: item.localId }),
    );
    expect(result).toEqual({
      syncedIds: [item.localId],
      failedIds: [],
      pendingCount: 0,
    });
  });

  it('keeps a failed item and retries it with the same idempotency key', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'voidr-annotation-outbox-'),
    );
    const outbox = new AnnotationOutbox(root, codec);
    const item = await outbox.enqueue(fixture());
    const failure = await outbox.drain(async () => {
      throw new Error('offline');
    });

    expect(failure).toEqual({
      syncedIds: [],
      failedIds: [item.localId],
      pendingCount: 1,
    });

    const seen: string[] = [];
    const recovery = await outbox.drain(async (pending) => {
      seen.push(pending.annotation.idempotencyKey);
    });
    expect(seen).toEqual([fixture().annotation.idempotencyKey]);
    expect(recovery.pendingCount).toBe(0);
  });

  it('shares a single drain while an upload is in flight', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'voidr-annotation-outbox-'),
    );
    const outbox = new AnnotationOutbox(root, codec);
    await outbox.enqueue(fixture());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upload = vi.fn(async () => barrier);

    const first = outbox.drain(upload);
    const second = outbox.drain(upload);
    release();
    await Promise.all([first, second]);

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('also drains an item enqueued while the current upload is in flight', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'voidr-annotation-outbox-'),
    );
    const outbox = new AnnotationOutbox(root, codec);
    await outbox.enqueue(fixture());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const drain = outbox.drain(async () => {
      calls += 1;
      if (calls === 1) await barrier;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await outbox.enqueue({
      ...fixture(),
      annotation: {
        ...fixture().annotation,
        idempotencyKey: 'desktop-annotation:generation:second',
      },
    });
    release();

    expect((await drain).pendingCount).toBe(0);
    expect(calls).toBe(2);
  });
});
