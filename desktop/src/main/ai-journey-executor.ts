import type { JourneyEvent, JourneyState } from '../shared/journeys';
import type { AiCollectorInput } from './ai-collector-worker';

export type PlannedJourney = {
  runId: string;
  config: unknown;
  secrets: Record<string, string>;
  collector?: AiCollectorInput;
  outputRoot: string;
  onEvent: (event: JourneyEvent) => void;
};

/** Execution boundary shared by the desktop and a headless Assistant worker. */
export interface AiJourneyExecutor {
  readonly running: boolean;
  reserve(): void;
  release(): void;
  showStandalone(): unknown;
  executePlanned(input: PlannedJourney): Promise<JourneyState>;
  stop(): unknown;
  resume(): unknown;
}
