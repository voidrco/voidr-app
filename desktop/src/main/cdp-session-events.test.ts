import { describe, expect, it } from "vitest";
import {
  consoleErrorFromCdp,
  drainKnownCdpNetworkResponses,
  exceptionFromCdp,
  finishCdpNetworkRequest,
  RecentConsoleEventDeduper,
  type CanonicalNetworkRequestMeta,
} from "./cdp-session-events";

describe("CDP network finalization", () => {
  it("persists a known 500 exactly once when Stop wins the loadingFinished race", () => {
    const requests = new Map<string, CanonicalNetworkRequestMeta>([
      [
        "request-500",
        {
          requestId: "request-500",
          sequence: 0,
          method: "GET",
          url: "https://api.test/orders/:id",
          startedAt: 10_000,
          resourceType: "Fetch",
          response: {
            status: 500,
            statusText: "Internal Server Error",
            mimeType: "application/json",
            responseSize: 128,
          },
        },
      ],
    ]);

    const drainedAtStop = drainKnownCdpNetworkResponses(requests, 10_080);
    const lateLoadingFinished = finishCdpNetworkRequest(
      requests,
      "request-500",
      10_100,
      256,
    );

    expect(drainedAtStop).toEqual([
      {
        requestId: "request-500:0",
        method: "GET",
        url: "https://api.test/orders/:id",
        status: 500,
        statusText: "Internal Server Error",
        mimeType: "application/json",
        durationMs: 80,
        startedAt: 10_000,
        resourceType: "Fetch",
        responseSize: 128,
      },
    ]);
    expect(lateLoadingFinished).toBeUndefined();
    expect(requests.size).toBe(0);
  });

  it("does not invent a result for requests that never received a response", () => {
    const requests = new Map<string, CanonicalNetworkRequestMeta>([
      [
        "pending",
        {
          requestId: "pending",
          sequence: 0,
          method: "GET",
          url: "https://api.test/pending",
          startedAt: 10_000,
          resourceType: "Fetch",
        },
      ],
    ]);

    expect(drainKnownCdpNetworkResponses(requests, 10_250)).toEqual([]);
    expect(requests.has("pending")).toBe(true);
  });
});

describe("CDP console normalization", () => {
  it("keeps only a useful error category and never persists console arguments", () => {
    const result = consoleErrorFromCdp({
      type: "error",
      args: [
        {
          type: "string",
          value: "Falha em https://admin:secret@api.test/orders?token=secret",
        },
        { type: "string", value: "Authorization: Bearer abcdefghijklmnop" },
      ],
      stackTrace: {
        callFrames: [
          {
            functionName: "loadOrders",
            url: "https://app.test/main.js?build=secret#chunk",
            lineNumber: 9,
            columnNumber: 4,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      name: "ConsoleError",
      message: "ConsoleError registrado no console.",
      context: { source: "cdp.console", consoleType: "error" },
    });
    expect(result?.fingerprint).toMatch(/^cdp:/);
    expect(JSON.stringify(result)).not.toContain("api.test");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result?.stack).toBeUndefined();
  });

  it("ignores informational console noise", () => {
    for (const type of ["log", "debug", "info", "warning"]) {
      expect(
        consoleErrorFromCdp({ type, args: [{ value: "noise" }] }),
      ).toBeUndefined();
    }
  });

  it("ignores failures emitted by the collector itself", () => {
    expect(
      consoleErrorFromCdp({
        type: "error",
        args: [
          {
            type: "string",
            value: "VoidrCollector: Failed to send events 503",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("deduplicates equivalent console and exception facts inside a short window", () => {
    const deduper = new RecentConsoleEventDeduper(1_000, 2);
    const consoleEvent = {
      name: "ConsoleError",
      message: "Error: checkout failed",
      context: { source: "cdp.console" },
    };
    const exceptionEvent = {
      name: "Error",
      message: "Uncaught Error: checkout failed",
      context: { source: "cdp.exception" },
    };

    expect(deduper.accept(consoleEvent, 10_000)).toBe(true);
    expect(deduper.accept(exceptionEvent, 10_500)).toBe(false);
    expect(deduper.accept(exceptionEvent, 11_001)).toBe(true);
  });

  it("normalizes uncaught exceptions with bounded source coordinates", () => {
    const result = exceptionFromCdp({
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 40,
        columnNumber: 7,
        exception: {
          className: "TypeError",
          description:
            "TypeError: Cannot read properties of undefined\n at checkout (?token=secret)",
        },
        stackTrace: {
          callFrames: [
            {
              functionName: "checkout",
              url: "https://app.test/checkout.js?token=secret",
              lineNumber: 40,
              columnNumber: 7,
            },
          ],
        },
      },
    });

    expect(result).toEqual({
      name: "TypeError",
      message: "TypeError não tratado registrado na aplicação.",
      context: { source: "cdp.exception", line: 41, column: 8 },
      fingerprint: expect.stringMatching(/^cdp:/),
    });
  });

  it("does not retain personal data from console or exception payloads", () => {
    const consoleEvent = consoleErrorFromCdp({
      type: "error",
      args: [
        {
          value:
            "Falha para João da Silva, joao@example.com, CPF 123.456.789-00, conta 12345678",
        },
      ],
    });
    const exceptionEvent = exceptionFromCdp({
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          className: "Error",
          description: "Error: cliente João da Silva não encontrado",
        },
      },
    });

    const durable = JSON.stringify([consoleEvent, exceptionEvent]);
    expect(durable).not.toContain("João");
    expect(durable).not.toContain("example.com");
    expect(durable).not.toContain("123.456");
    expect(durable).not.toContain("12345678");
  });
});
