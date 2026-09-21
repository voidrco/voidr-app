import { createHash } from "node:crypto";
import { describeAction, type Action } from "./actions.js";
import type { Observation } from "./browser.js";

export type RecoveryFailure = {
  kind: "blocked" | "stale" | "uncertain" | "no_action" | "unconfirmed";
  reason: string; action?: string; outcome: "not_executed" | "unknown";
};
type Attempt = { key: string; state: string; unknown: boolean };

export function observationKey(observation: Observation) {
  const controls = observation.controls.map(({ availability, ...control }) => control);
  return createHash("sha256").update(JSON.stringify({ ...observation, controls })).digest("hex");
}

function actionKey(action: Action) {
  return JSON.stringify([action.kind, action.control.frame, action.control.name, action.control.href, action.value]);
}

export class StepRecovery {
  private state = { failures: [] as RecoveryFailure[], attempts: [] as Attempt[] };
  get failures() { return this.state.failures; }

  candidates(actions: Action[], observation: Observation) {
    const state = observationKey(observation);
    return actions.filter(action => !this.state.attempts.some(attempt => attempt.key === actionKey(action)
      && (attempt.unknown || attempt.state === state)));
  }

  executed(action: Action, observation: Observation) {
    this.state.attempts.push({ key: actionKey(action), state: observationKey(observation), unknown: false });
  }

  fail(failure: RecoveryFailure, observation: Observation, action?: Action) {
    this.state.failures.push({ ...failure, action: action ? describeAction(action) : undefined });
    if (action) this.state.attempts.push({ key: actionKey(action),
      state: observationKey(observation), unknown: failure.outcome === "unknown" });
    return this.state.failures.length <= 3;
  }
}
