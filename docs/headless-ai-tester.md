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

The worker scheduler/registration and dispatch from Assistant-requested runs are not wired by this change. No real nstech run or deployed application revision has been validated through this executor yet. These are the next integration boundaries, not completed outcomes.
