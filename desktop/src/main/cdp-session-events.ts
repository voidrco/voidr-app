import { redactText } from "@voidr/capture-contracts";

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_STACK_LENGTH = 4_000;

export interface CanonicalNetworkResponseMeta {
  status: number;
  statusText: string;
  mimeType: string;
  responseSize: number;
}

export interface CanonicalNetworkRequestMeta {
  requestId: string;
  sequence: number;
  method: string;
  url: string;
  startedAt: number;
  resourceType: string;
  response?: CanonicalNetworkResponseMeta;
}

export interface CanonicalNetworkSignal {
  requestId?: string;
  method: string;
  url: string;
  status: number;
  statusText?: string;
  mimeType?: string;
  durationMs: number;
  startedAt?: number;
  resourceType?: string;
  responseSize?: number;
  failure?: string;
}

function signalFromKnownResponse(
  request: CanonicalNetworkRequestMeta,
  now: number,
  responseSize?: number,
): CanonicalNetworkSignal | undefined {
  if (!request.response) return undefined;
  return {
    requestId: `${request.requestId}:${request.sequence}`,
    method: request.method,
    url: request.url,
    status: request.response.status,
    statusText: request.response.statusText,
    mimeType: request.response.mimeType,
    durationMs: Math.max(0, now - request.startedAt),
    startedAt: request.startedAt,
    resourceType: request.resourceType,
    responseSize: Number.isFinite(responseSize)
      ? Number(responseSize)
      : request.response.responseSize,
  };
}

/** Consume a normally completed request. A request drained during Stop is no longer emitted late. */
export function finishCdpNetworkRequest(
  requests: Map<string, CanonicalNetworkRequestMeta>,
  requestId: string,
  now = Date.now(),
  responseSize?: number,
): CanonicalNetworkSignal | undefined {
  const request = requests.get(requestId);
  if (!request) return undefined;
  requests.delete(requestId);
  return signalFromKnownResponse(request, now, responseSize);
}

/**
 * Stop-time fallback for the CDP race where response headers arrived but
 * Network.loadingFinished is delivered after the user has finalized capture.
 */
export function drainKnownCdpNetworkResponses(
  requests: Map<string, CanonicalNetworkRequestMeta>,
  now = Date.now(),
): CanonicalNetworkSignal[] {
  const signals: CanonicalNetworkSignal[] = [];
  for (const [requestId, request] of requests) {
    const signal = signalFromKnownResponse(request, now);
    if (!signal) continue;
    requests.delete(requestId);
    signals.push(signal);
  }
  return signals;
}

export interface CanonicalConsoleError {
  name: string;
  message: string;
  stack?: string;
  context: Record<string, string | number>;
  /** In-memory correlation only. It must never be sent to the collector. */
  fingerprint?: string;
}

function consoleFingerprint(error: CanonicalConsoleError): string {
  if (error.fingerprint) return error.fingerprint;
  return error.message
    .toLowerCase()
    .replace(/^uncaught(?:\s+\(in promise\))?:?\s*/i, "")
    .replace(/^(?:console)?error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AssertionError",
  "ConsoleError",
  "Error",
  "EvalError",
  "NetworkError",
  "RangeError",
  "ReferenceError",
  "SecurityError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function safeErrorName(input: unknown, fallback: string): string {
  const candidate = String(input ?? "").split(":", 1)[0]?.trim();
  return candidate && SAFE_ERROR_NAMES.has(candidate) ? candidate : fallback;
}

function diagnosticFingerprint(input: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `cdp:${(hash >>> 0).toString(36)}`;
}

export class RecentConsoleEventDeduper {
  #recent = new Map<string, number>();

  constructor(
    private readonly windowMs = 1_000,
    private readonly capacity = 200,
  ) {}

  accept(error: CanonicalConsoleError, now = Date.now()): boolean {
    const fingerprint = consoleFingerprint(error);
    if (!fingerprint) return false;
    for (const [key, seenAt] of this.#recent) {
      if (now - seenAt > this.windowMs) this.#recent.delete(key);
    }
    const seenAt = this.#recent.get(fingerprint);
    if (seenAt != null && now - seenAt <= this.windowMs) return false;
    this.#recent.set(fingerprint, now);
    while (this.#recent.size > this.capacity) {
      const oldest = this.#recent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#recent.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.#recent.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function withoutUrlSecrets(input: string): string {
  return input.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch {
      return candidate;
    }
  });
}

function boundedDiagnostic(input: unknown, maxLength: number): string {
  return withoutUrlSecrets(redactText(String(input ?? "")))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function remoteObjectText(input: unknown): string {
  const value = asRecord(input);
  if (!value) return "";
  if (
    "value" in value &&
    ["string", "number", "boolean", "bigint"].includes(typeof value.value)
  ) {
    return boundedDiagnostic(value.value, 500);
  }
  if (value.value === null) return "null";
  if (value.type === "undefined") return "undefined";
  if (typeof value.unserializableValue === "string") {
    return boundedDiagnostic(value.unserializableValue, 120);
  }
  return boundedDiagnostic(
    value.description ?? value.className ?? value.type ?? "",
    500,
  );
}

/** Only console calls that semantically represent failures become passive feedback. */
export function consoleErrorFromCdp(
  parameters: Record<string, unknown>,
): CanonicalConsoleError | undefined {
  const consoleType = String(parameters.type ?? "").toLowerCase();
  if (!["error", "assert"].includes(consoleType)) return undefined;
  const args = Array.isArray(parameters.args) ? parameters.args : [];
  const rawMessage = boundedDiagnostic(
    args.map(remoteObjectText).filter(Boolean).join(" ") ||
      (consoleType === "assert" ? "Assertion failed" : "Console error"),
    MAX_MESSAGE_LENGTH,
  );
  if (!rawMessage || rawMessage.startsWith("VoidrCollector:")) return undefined;
  const name =
    consoleType === "assert"
      ? "AssertionError"
      : safeErrorName(rawMessage, "ConsoleError");
  return {
    name,
    // Console arguments frequently contain customer data. The durable stream
    // only needs a factual failure category and timestamp; the replay remains
    // the source of truth for what happened on screen.
    message:
      name === "AssertionError"
        ? "Falha de asserção registrada no console."
        : `${name} registrado no console.`,
    context: {
      source: "cdp.console",
      consoleType,
    },
    fingerprint: diagnosticFingerprint(`${consoleType}\0${rawMessage}`),
  };
}

export function exceptionFromCdp(
  parameters: Record<string, unknown>,
): CanonicalConsoleError | undefined {
  const details = asRecord(parameters.exceptionDetails);
  if (!details) return undefined;
  const exception = asRecord(details.exception);
  const description = boundedDiagnostic(
    exception?.description ??
      exception?.value ??
      details.text ??
      "Erro JavaScript",
    MAX_STACK_LENGTH,
  );
  const [firstLine = "Erro JavaScript"] = description.split("\n");
  if (!firstLine) return undefined;
  const name = safeErrorName(
    exception?.className ?? firstLine.split(":", 1)[0],
    "Error",
  );
  const line = Math.max(0, Math.round(Number(details.lineNumber ?? 0))) + 1;
  const column = Math.max(0, Math.round(Number(details.columnNumber ?? 0))) + 1;
  return {
    name,
    message: `${name} não tratado registrado na aplicação.`,
    context: {
      source: "cdp.exception",
      line,
      column,
    },
    fingerprint: diagnosticFingerprint(`exception\0${description}`),
  };
}
