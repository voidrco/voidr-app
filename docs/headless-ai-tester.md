# Headless Loops executor for Assistant runs

`desktop/dist/main/headless-ai-tester.cjs` exports `runHeadlessAiTest(input, options)` after `npm run build:main` in the desktop workspace. This Node entry point reuses `AiTesterController`, the Loops browser engine, Collector, journal and resumable evidence uploader. It does not import Electron.

The caller supplies an existing Service run ID, Loop ID, runtime configuration, an absolute journal directory and a session provider returning the authorized `VoidrServiceClient` and access token. The session provider must preserve the requesting workspace and actor. The runner does not discover credentials, mint privileges, create a scenario/run or publish an application. The existing Service claim and credential endpoints remain authoritative.

The browser engine requires `TYPESAFE_API_KEY`, its configured model and an installed Playwright Chromium. Keep model credentials in the worker's environment, never in the scenario or journal. Environment credentials come from the claimed run's normal credential endpoint. Collector setup is required for each runnable journey, as it is on the desktop; an unavailable Collector does not fall back to fabricated capture evidence.

`options.signal` cancels the run; `timeoutMs` defaults to ten minutes and accepts one second to one hour. Cancellation asks the engine to stop and waits for partial evidence and browser cleanup. This is cooperative cancellation, not a process-level kill deadline. A supervisor still needs a termination policy for a process that cannot shut down.

Journal roots are partitioned by Service URL and organization. An exclusive directory lock prevents concurrent local workers from sharing a journal. A crash can leave the lock behind: confirm that the old worker is gone before removing that specific lock. Never automatically steal it. To resend persisted evidence without executing the journey, use `mode: 'retry-evidence'` with the same root, workspace, Loop and run ID. No attempt to rerun a terminal run is made.

A headless browser cannot service an interactive human authentication prompt. That journey stops with an explicit reason and partial evidence; it is not reported as passed. Human interaction must be handed to an executor with an interface. A completed execution can still contain blocked or failed journeys: consumers must use the existing validation assessment and evidence, not just the run status.

## Verified scope

- Desktop TypeScript check and main-process bundles pass.
- Lifecycle/adapter tests cover claim denial, missing run IDs, terminal executions, cancellation, timeout, concurrent worker exclusion, evidence-only retry, secret redaction and Collector configuration.
- The opt-in Chromium test executes a real click, records a screenshot/video/result and verifies a human-intervention failure. Its decision function is deterministic; it does not prove model reasoning or customer resolution. Set `VOIDR_TEST_CHROMIUM_EXECUTABLE` to an installed Chromium executable to run it.
- The Node bundle imports successfully without Electron.

## Automatic queue consumption

The `headless-ai-worker.cjs` bundle exports `runHeadlessAiWorker(options)`. It polls the authenticated actor's `ai-tester-launches?target=headless` queue and calls the runner for each pending request. Assistant MCP requests default to this target; desktop remains an explicit option. Service restricts headless claims to the requesting actor. No alternate identity is used when access fails.

Use a stable `actorId` matching the session provider and a private durable root for that worker identity. The ID partitions local state; authorization comes from the Service token, not the supplied ID. The worker fails before consuming requests when its model key is missing. It persists dispatch references before execution and records completion. On restart, a run already claimed is eligible only for evidence recovery; uncertain browser actions are never replayed. Upload failures preserve the pending dispatch and stop the worker for a supervised retry. Access failures also stop it rather than switching credentials. A process crash leaves a lock for explicit reconciliation, not automatic takeover.

Tests cover automatic consumption, actor-scoped routing, terminal dispatch deduplication, restart into evidence-only recovery, missing model configuration and denied access. A live local authenticated MCP/REST proof confirmed default headless routing, desktop exclusion, stable request retries and cancellation removing the request. That proof did not execute the browser or use a model to request the run.

A deployment supervisor, valid worker model configuration and a complete Collector/storage setup are still required. No real nstech run or deployed application revision has been validated through this worker yet.

## Expected failures and assertion evidence

The Loops engine distinguishes an executed interaction from a confirmed business effect. An expected rejection can complete an action only after the engine observed the interaction and new page text, and the model explicitly matches the rejection to the current instruction at the normal confirmation threshold. Unexpected rejection, missing evidence and contradictory low satisfaction remain non-passing. A model-classified assertion adds DOM verification even when the scenario labels that step as an action.

The `step_done.outcome` field survives the App event boundary; `unconfirmed` is not a successful business operation. Engine decision records retain the corresponding observations. Regression tests cover contradictory model answers, missing evidence, removal-only page changes, and combined action/assertion instructions with incorrect DOM values. The final laboratory comparison used the same bundled executor with real JEV/Chromium: the original CITWEB frontend component blocked after 1/3 steps; the candidate completed 3/3 with a DOM-checked assertion. This did not deploy the application or validate the customer backend.
