import {
  collectorStopReceiptSchema,
  redactText,
  type CollectorStopReceipt,
} from '@voidr/capture-contracts';

const NON_RETRYABLE_CODES = new Set([
  'LOOP_SEALED_SESSION_V1_DISABLED',
  'SESSION_NOT_FOUND',
  'SESSION_EXPIRED',
]);

export interface CollectorStopAttempt {
  receipt?: CollectorStopReceipt;
  retryable: boolean;
  message: string;
}

const safeText = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return redactText(value.trim()).slice(0, 240);
};

export function inspectCollectorStopAttempt(raw: unknown): CollectorStopAttempt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      retryable: true,
      message: 'O collector ainda não confirmou a finalização do teste.',
    };
  }

  const value = raw as Record<string, unknown>;
  const sealedThrough = Number(
    value.sealedThrough ?? value.finalizedThrough ?? value.finalChunkSeq,
  );
  const parsed = collectorStopReceiptSchema.safeParse({
    sessionId: value.sessionId,
    ok: value.ok,
    flushed: value.flushed,
    sealed: value.sealed,
    sealedThrough,
  });
  if (parsed.success) {
    return { receipt: parsed.data, retryable: false, message: '' };
  }

  const code = safeText(value.code);
  const status = Number(value.status);
  const retryable =
    !code ||
    (!NON_RETRYABLE_CODES.has(code) &&
      (!Number.isInteger(status) || status < 400 || status >= 500 || status === 409));
  const detail = safeText(value.error);

  if (code === 'LOOP_SEALED_SESSION_V1_DISABLED') {
    return {
      retryable: false,
      message: 'A finalização segura de gravações está indisponível neste ambiente.',
    };
  }
  if (code === 'SESSION_NOT_FOUND' || code === 'SESSION_EXPIRED') {
    return {
      retryable: false,
      message: 'A sessão do collector expirou antes de confirmar a finalização.',
    };
  }

  return {
    retryable,
    message: detail
      ? `O collector ainda não confirmou a finalização: ${detail}`
      : 'O collector ainda não confirmou a gravação completa. Tente finalizar novamente.',
  };
}
