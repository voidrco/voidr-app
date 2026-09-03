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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VoidrServiceClient", () => {
  it("projects the canonical workspace logo, name and signed-in user from auth/me", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            email: "ana@itau.com.br",
            name: "Ana QA",
            picture: "https://images.example/ana.png",
            organizationId: "org_XpZs54aP8Oop8qUz",
            organization: {
              id: "org_XpZs54aP8Oop8qUz",
              name: "itau",
              displayName: "Itaú",
            },
            logoUrl: "https://images.example/itau.png",
          },
        }),
        { status: 200 },
      ),
    );

    const identity = await new VoidrServiceClient(runtime).workspaceIdentity("workspace-token");

    expect(identity).toEqual({
      organizationId: "org_XpZs54aP8Oop8qUz",
      name: "Itaú",
      logoUrl: "https://images.example/itau.png",
      user: {
        name: "Ana QA",
        email: "ana@itau.com.br",
        picture: "https://images.example/ana.png",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/v1/auth/me",
      expect.objectContaining({ headers: { Authorization: "Bearer workspace-token" } }),
    );
  });

  it("accepts an indexed collector response with a terminal index version", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "collector-read-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "indexed", ingestVersion: 1788216612342 }),
          { status: 200 },
        ),
      );

    await expect(
      new VoidrServiceClient(runtime).waitForCollectorReadiness(
        "session-sealed",
        "collector-api-key",
        4,
      ),
    ).resolves.toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:3100/sessions/session-sealed/ensure-indexed?budgetMs=1500",
    );
  });

  it("keeps polling when a claimed ingest outlives one HTTP request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "collector-read-token" }), { status: 200 }),
      )
      .mockRejectedValueOnce(new DOMException("The operation timed out", "TimeoutError"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ready",
            readinessToken: { indexedThrough: 7, indexVersion: 2 },
          }),
          { status: 200 },
        ),
      );

    const readiness = new VoidrServiceClient(runtime).waitForCollectorReadiness(
      "session-slow-index",
      "collector-api-key",
      7,
    );
    await vi.advanceTimersByTimeAsync(750);

    await expect(readiness).resolves.toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("authenticates every production workspace request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    const productionRuntime = {
      ...runtime,
      serviceUrl: "https://api.voidr.co/v1",
      collectorUrl: "https://collector.voidr.co",
      collectorScriptUrl: "https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js",
      platformUrl: "https://platform.voidr.co",
      localAdapter: false,
      organizationId: "org_blip",
    };
    const client = new VoidrServiceClient(productionRuntime);

    await client.listLoops("organization-access-token");
    await client.listLoopCycles("lts_blip", "organization-access-token");

    for (const [, request] of fetchMock.mock.calls) {
      expect(request).toMatchObject({
        headers: { Authorization: "Bearer organization-access-token" },
      });
    }
  });

  it("fails before the network when a production workspace is not authenticated", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new VoidrServiceClient({
      ...runtime,
      serviceUrl: "https://api.voidr.co/v1",
      collectorUrl: "https://collector.voidr.co",
      collectorScriptUrl: "https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js",
      platformUrl: "https://platform.voidr.co",
      localAdapter: false,
      organizationId: "org_blip",
    });

    await expect(client.listLoops()).rejects.toThrow("Conecte sua conta Voidr");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows voice transcription to outlive the default control request timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { segment: { text: "pronto" } },
        }),
        {
          status: 200,
        },
      ),
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

  it("never regresses lifecycle state when concurrent responses arrive out of order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { lifecycleVersion: 3 } }), {
        status: 200,
      }),
    );
    const authorization = {
      verificationToken: "verification-capability",
      safeContext: {
        verificationId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
        lifecycleVersion: 5,
      },
    } as never;

    await new VoidrServiceClient(runtime).verificationIngest(
      authorization,
      "annotations",
      {},
    );

    expect((authorization as { safeContext: { lifecycleVersion: number } }).safeContext.lifecycleVersion).toBe(5);
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
        expect.objectContaining({
          kind: "annotation",
          title: "Botão não respondeu",
        }),
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

  it("claims and reports the canonical capture attempt without exposing a credential in the link", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, data: { state: "app_claimed" } }), {
        status: 200,
      }),
    );
    const client = new VoidrServiceClient(runtime);
    const launch = {
      version: "VOIDR-CAPTURE-LAUNCH/1" as const,
      organizationId: "org_verification_local",
      loopId: "lts_itau_agro",
      cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
      attemptId: "11111111-1111-4111-8111-111111111111",
      surface: "web" as const,
      access: "organization" as const,
      deployment: "local" as const,
    };

    await client.claimDesktopLaunch(launch, {
      appVersion: "0.1.13",
      appPlatform: "darwin",
      appArch: "arm64",
    });
    await client.reportDesktopLaunchState(launch, "recording");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3000/v1/loop-test-dev/scenarios/lts_itau_agro/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd/capture-attempts/11111111-1111-4111-8111-111111111111/claim",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/capture-attempts/11111111-1111-4111-8111-111111111111/events");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        appVersion: "0.1.13",
        appPlatform: "darwin",
        appArch: "arm64",
      }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ state: "recording" }),
    });
  });

  it("uses the participant audience only for a participant-marked desktop handoff", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: "VOIDR-CAPTURE-LAUNCH/1",
            captureAdapter: "voidr_app",
            surface: "api",
            loopId: "lts_public",
            cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
            cycleNumber: 1,
            applicationId: "app_public",
            environment: "staging",
            mission: "Validar API",
            targetUrl: "https://api.example.test",
            participant: {
              name: "Ana Silva",
              role: "Participante externo",
              picture: null,
            },
            cycleStartedAt: "2026-08-20T12:00:00.000Z",
          },
        }),
        { status: 200 },
      ),
    );
    const remoteRuntime = {
      ...runtime,
      serviceUrl: "https://api.example.test/v1",
      collectorUrl: "https://collector.example.test",
      collectorScriptUrl: "https://cdn.example.test/recorder.min.js",
      platformUrl: "https://platform.example.test",
      localAdapter: false,
    };
    await new VoidrServiceClient(remoteRuntime).resolveDesktopLaunch(
      {
        version: "VOIDR-CAPTURE-LAUNCH/1",
        organizationId: "org_hidden",
        loopId: "lts_public",
        cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
        surface: "api",
        access: "participant",
      },
      "participant-access-token",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/loop-participant/captures/lts_public/88ad0919-9754-4787-8a43-fc4bf79e52bd",
      ),
      expect.objectContaining({
        headers: { Authorization: "Bearer participant-access-token" },
      }),
    );
  });

  it("authenticates an organization handoff against the production Loop API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: "VOIDR-CAPTURE-LAUNCH/1",
            captureAdapter: "voidr_app",
            surface: "web",
            loopId: "lts_production",
            cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
            cycleNumber: 1,
            applicationId: "app_production",
            environment: "production",
            mission: "Validar o fluxo",
            targetUrl: "https://example.test",
            participant: null,
            cycleStartedAt: "2026-08-20T12:00:00.000Z",
            recordingUrl: "https://example.test/?voidr_record=1",
          },
        }),
        { status: 200 },
      ),
    );
    const remoteRuntime = {
      ...runtime,
      serviceUrl: "https://api.voidr.co/v1",
      collectorUrl: "https://collector.voidr.co",
      collectorScriptUrl:
        "https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js",
      platformUrl: "https://platform.voidr.co",
      localAdapter: false,
    };

    await new VoidrServiceClient(remoteRuntime).resolveDesktopLaunch(
      {
        version: "VOIDR-CAPTURE-LAUNCH/1",
        organizationId: "org_production",
        loopId: "lts_production",
        cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
        surface: "web",
        access: "organization",
        deployment: "production",
      },
      "organization-access-token",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.voidr.co/v1/loop-test/scenarios/lts_production/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd/capture-handoff",
      expect.objectContaining({
        headers: { Authorization: "Bearer organization-access-token" },
      }),
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
      expect.objectContaining({
        kind: "annotation",
        title: "Campo sem instrução",
      }),
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
