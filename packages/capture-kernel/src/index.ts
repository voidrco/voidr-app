import type { CapturePlatform, CaptureStage, CaptureStatus, SafeWebContext } from '@voidr/capture-contracts';

export type EvidenceCategory = keyof CaptureStatus['evidence'];

export interface CaptureState extends CaptureStatus {
  startedAt?: number;
  sealedAt?: number;
  retryFrom?: 'stop' | 'attach';
}

export type CaptureAction =
  | { type: 'PREPARE'; platform: CapturePlatform; generation: string }
  | { type: 'PREPARED'; context?: SafeWebContext }
  | { type: 'START'; startedAt: number; sessionId?: string }
  | { type: 'EVIDENCE'; category: EvidenceCategory; increment?: number }
  | { type: 'STOP' }
  | { type: 'SEALED'; sessionId: string; sealedAt: number }
  | { type: 'ATTACH' }
  | { type: 'PROCESS' }
  | { type: 'READY' }
  | { type: 'OFFLINE'; message?: string }
  | { type: 'FAIL'; message: string; code: string; retryFrom?: 'stop' | 'attach'; terminal?: boolean }
  | { type: 'RESET' };

const evidenceZero: CaptureStatus['evidence'] = {
  pages: 0,
  clicks: 0,
  requests: 0,
  errors: 0,
  notes: 0,
  voiceNotes: 0,
};

export const initialCaptureState: CaptureState = {
  stage: 'idle',
  elapsedMs: 0,
  evidence: evidenceZero,
};

const allowed: Record<CaptureStage, readonly CaptureStage[]> = {
  idle: ['preparing'],
  preparing: ['ready', 'recoverable_error', 'terminal_error', 'offline'],
  ready: ['recording', 'idle', 'recoverable_error'],
  recording: ['stopping', 'offline', 'recoverable_error'],
  stopping: ['sealed', 'recoverable_error', 'terminal_error'],
  sealed: ['attaching', 'processing', 'recoverable_error'],
  attaching: ['processing', 'ready_for_review', 'recoverable_error'],
  processing: ['ready_for_review', 'recoverable_error'],
  ready_for_review: ['preparing', 'idle'],
  offline: ['recording', 'stopping', 'recoverable_error'],
  recoverable_error: ['stopping', 'attaching', 'preparing', 'idle'],
  terminal_error: ['idle', 'preparing'],
};

function transition(state: CaptureState, stage: CaptureStage): CaptureState {
  if (!allowed[state.stage].includes(stage)) {
    throw new Error(`Invalid capture transition: ${state.stage} -> ${stage}`);
  }
  return { ...state, stage, message: undefined, errorCode: undefined };
}

export function captureReducer(state: CaptureState, action: CaptureAction): CaptureState {
  switch (action.type) {
    case 'PREPARE':
      return {
        ...transition(state, 'preparing'),
        platform: action.platform,
        generation: action.generation,
        context: undefined,
        sessionId: undefined,
        evidence: { ...evidenceZero },
        elapsedMs: 0,
        retryFrom: undefined,
      };
    case 'PREPARED':
      return { ...transition(state, 'ready'), context: action.context };
    case 'START':
      return {
        ...transition(state, 'recording'),
        startedAt: action.startedAt,
        sessionId: action.sessionId,
      };
    case 'EVIDENCE':
      if (state.stage !== 'recording') return state;
      return {
        ...state,
        evidence: {
          ...state.evidence,
          [action.category]: state.evidence[action.category] + (action.increment ?? 1),
        },
      };
    case 'STOP':
      return transition(state, 'stopping');
    case 'SEALED':
      return {
        ...transition(state, 'sealed'),
        sessionId: action.sessionId,
        sealedAt: action.sealedAt,
        retryFrom: undefined,
      };
    case 'ATTACH':
      return transition(state, 'attaching');
    case 'PROCESS':
      return transition(state, 'processing');
    case 'READY':
      return transition(state, 'ready_for_review');
    case 'OFFLINE':
      return { ...transition(state, 'offline'), message: action.message };
    case 'FAIL':
      return {
        ...transition(state, action.terminal ? 'terminal_error' : 'recoverable_error'),
        message: action.message,
        errorCode: action.code,
        retryFrom: action.retryFrom,
      };
    case 'RESET':
      return { ...initialCaptureState, evidence: { ...evidenceZero } };
  }
}

export function isGenerationCurrent(state: CaptureState, generation?: string): boolean {
  return Boolean(generation && state.generation === generation);
}

export class SingleFlight<T> {
  #inFlight: Promise<T> | undefined;

  run(operation: () => Promise<T>): Promise<T> {
    if (this.#inFlight) return this.#inFlight;
    const task = operation().finally(() => {
      if (this.#inFlight === task) this.#inFlight = undefined;
    });
    this.#inFlight = task;
    return task;
  }

  get active(): boolean {
    return Boolean(this.#inFlight);
  }
}
