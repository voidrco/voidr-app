import { afterEach, describe, expect, it, vi } from "vitest";
import { VoidrApiError, VoidrServiceClient } from "./service-client";

const runtime = {
  serviceUrl: "http://127.0.0.1:3000/v1",
  collectorUrl: "http://127.0.0.1:3100",
  collectorScriptUrl: "http://127.0.0.1:8889/dist/recorder.min.js",
  platformUrl: "http://127.0.0.1:3030",
  localAdapter: true,
  localDevKey: "voidr-verification-local",
  organizationId: "org_verification_local",
};

afterEach(() => vi.restoreAllMocks());

describe("VoidrServiceClient", () => {
  it("allows voice transcription to outlive the default control request timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { segment: { text: "pronto" } } }), {
        status: 200,
      }),
    );
    const authorization = {
      verificationToken: "verification-capability",
      safeContext: {
        verificationId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
        lifecycleVersion: 0,
      },
    } as never;

    await new VoidrServiceClient(runtime).verificationIngest(
      authorization,
      "voice-segments",
      {},
    );

    expect(timeout).toHaveBeenCalledWith(75_000);
  });

  it("preserves HTTP status so voice can distinguish rejection from an ambiguous failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { message: "Voice note contained no transcribable speech." },
        }),
        { status: 422 },
      ),
    );
    const authorization = {
      verificationToken: "verification-capability",
      safeContext: {
        verificationId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
        lifecycleVersion: 0,
      },
    } as never;

    const failure = await new VoidrServiceClient(runtime)
      .verificationIngest(authorization, "voice-segments", {})
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VoidrApiError);
    expect(failure).toMatchObject({
      status: 422,
      message: "Voice note contained no transcribable speech.",
    });
  });

  it("reduces Loop workspace responses to safe renderer projections", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/scenarios")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "lts_itau_agro",
                name: "Itaú Agro",
                applicationId: "app_itau",
                applicationType: "WEB",
                targetUrl: "http://localhost:8080/?token=private-value",
                environmentSlug: "local",
                status: "recording",
                cycle: 1,
                sessionsRecorded: 1,
                updatedAt: "2026-08-13T12:00:00.000Z",
                latestCycle: {
                  id: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
                  number: 1,
                  status: "ready",
                  updatedAt: "2026-08-13T12:00:00.000Z",
                },
                workspace: {
                  state: "collecting",
                  counts: {
                    tests: {
                      total: 2,
                      active: 1,
                      ready: 1,
                      confirmed: 0,
                      failed: 0,
                    },
                    participants: 2,
                    evidence: 9,
                  },
                  participants: [
                    {
                      id: "ana",
                      name: "Ana QA",
                      role: "QA Engineer",
                      picture: "https://images.example/ana.png",
                    },
                    {
                      id: "bruno",
                      name: "Bruno Dev",
                      role: "Developer",
                      picture: null,
                    },
                  ],
                },
                collectorApiKey: "must-not-cross-ipc",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/cycles")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
                loopId: "lts_itau_agro",
                cycleNumber: 1,
                visibleStatus: "ready",
                mission: "Validar crédito rural",
                environment: "local",
                applicationType: "WEB",
                participant: {
                  name: "Ana QA",
                  email: "ana@example.com",
                  role: "QA Engineer",
                  picture: "https://images.example/ana.png",
                },
                artifactReady: true,
                diagnosisReady: true,
                updatedAt: "2026-08-13T12:00:00.000Z",
                createdAt: "2026-08-13T11:55:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
            loopId: "lts_itau_agro",
            number: 1,
            context: {
              durationMs: 8_200,
              replay: {
                available: true,
                signedUrl: "https://secret.example/replay",
              },
              counts: {
                annotations: 1,
                actions: 8,
                consoleErrors: 0,
                failedRequests: 1,
                transcriptSegments: 0,
              },
              evidence: [
                {
                  evidenceRef: "vap://secret-ref",
                  kind: "recording",
                  label: "Session replay",
                },
                {
                  evidenceRef: "vap://secret-note",
                  kind: "annotation",
                  label: "Botão não respondeu",
                  atMs: 920,
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    });

    const client = new VoidrServiceClient(runtime);
    const loops = await client.listLoops();
    const cycles = await client.listLoopCycles("lts_itau_agro");
    const detail = await client.getLoopCycle(
      "lts_itau_agro",
      "88ad0919-9754-4787-8a43-fc4bf79e52bd",
    );

    expect(loops[0]).toMatchObject({
      name: "Itaú Agro",
      environment: "local",
      workspaceState: "collecting",
      testCount: 2,
      participantCount: 2,
      evidenceCount: 9,
      participants: [
        {
          id: "ana",
          name: "Ana QA",
          picture: "https://images.example/ana.png",
        },
        { id: "bruno", name: "Bruno Dev", picture: null },
      ],
    });
    expect(cycles[0]).toMatchObject({
      participant: "Ana QA",
      participantRole: "QA Engineer",
      participantAvatarUrl: "https://images.example/ana.png",
      artifactReady: true,
    });
    expect(detail).toMatchObject({
      replayAvailable: true,
      counts: { failedRequests: 1 },
      evidence: [
        expect.objectContaining({ kind: "replay", title: "Replay do teste" }),
        expect.objectContaining({ kind: "annotation", title: "Botão não respondeu" }),
      ],
    });
    expect(JSON.stringify({ loops, cycles, detail })).not.toMatch(
      /collectorApiKey|evidenceRef|signedUrl|must-not-cross-ipc|secret\.example/,
    );
  });

  it("prepares a new cycle and returns only the secret-free desktop descriptor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            launchUrl:
              "voidr://capture/loops/lts_itau_agro/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_verification_local&surface=web&v=1",
            token: "must-not-cross-ipc",
          },
        }),
        { status: 200 },
      ),
    );

    const launch = await new VoidrServiceClient(runtime).prepareLoopCycle(
      "lts_itau_agro",
    );

    expect(launch).toMatchObject({
      loopId: "lts_itau_agro",
      cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
      organizationId: "org_verification_local",
      surface: "web",
    });
    expect(JSON.stringify(launch)).not.toContain("token");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/loop-test-dev/scenarios/lts_itau_agro/capture"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not present a replay before the recording is actually available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
            loopId: "lts_itau_agro",
            number: 1,
            context: {
              durationMs: null,
              replay: { available: false, frameCount: 0, medium: "rrweb" },
              counts: {},
              evidence: [
                { kind: "recording", label: "Session replay" },
                { kind: "annotation", label: "Campo sem instrução", atMs: 400 },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );

    const detail = await new VoidrServiceClient(runtime).getLoopCycle(
      "lts_itau_agro",
      "88ad0919-9754-4787-8a43-fc4bf79e52bd",
    );

    expect(detail.replayAvailable).toBe(false);
    expect(detail.evidence).toEqual([
      expect.objectContaining({ kind: "annotation", title: "Campo sem instrução" }),
    ]);
  });

  it("accepts a Web mission without a harness or harness delivery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            valid: true,
            scenarioId: "lts_itau_agro",
            scenarioName: "Itaú Agro · Crédito Rural",
            applicationId: "6a7e3b80680ef0e818f1afdf",
            collectorApiKey: "collector-key",
            attachToken: "attach-token",
            verificationCapability: {
              token: "verification-capability-token",
              expiresAt: "2026-08-14T12:00:00.000Z",
            },
            verification: {
              verificationId: "c4256f33-48de-4b41-a53a-2a52b7af83dd",
              generation: "ce408d50-b58c-48b5-9afd-111873279a62",
              cycleId: "c4256f33-48de-4b41-a53a-2a52b7af83dd",
              cycleNumber: 1,
              lifecycleVersion: 0,
              mission: "Validar originação para produtor rural",
              participant: {
                name: "Milson Ramos de Carvalho Júnior",
                email: "milson.ramos@voidr.co",
                role: "Software Developer",
                picture: "https://images.example/milson.png",
              },
              createdAt: "2026-08-17T15:45:00.000Z",
              harness: null,
              harnessDelivery: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const authorization = await new VoidrServiceClient(
      runtime,
    ).validateWebLaunch(
      {
        scenarioId: "lts_itau_agro",
        cycleId: "c4256f33-48de-4b41-a53a-2a52b7af83dd",
        token: "recording-token",
        safeUrl: "http://127.0.0.1:8080/",
        transportVersion: "legacy",
      },
      "766e4ed7-e413-45a7-8090-c95e2e255c07",
    );

    expect(authorization.safeContext).toMatchObject({
      scenarioId: "lts_itau_agro",
      cycleId: "c4256f33-48de-4b41-a53a-2a52b7af83dd",
      cycleNumber: 1,
      safeTargetUrl: "http://127.0.0.1:8080/",
      participant: {
        name: "Milson Ramos de Carvalho Júnior",
        role: "Software Developer",
        picture: "https://images.example/milson.png",
      },
      cycleStartedAt: "2026-08-17T15:45:00.000Z",
    });
    expect(authorization.safeContext).not.toHaveProperty("harnessName");
    expect(authorization.safeContext).not.toHaveProperty(
      "harnessDeliveryState",
    );
  });
});
