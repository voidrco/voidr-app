export const MAX_VOICE_DURATION_MS = 120_000;
export const MIN_VOICE_DURATION_MS = 600;

export interface VoiceDraftMeta {
  id: string;
  startedAtMs: number;
  durationMs: number;
  canSend: boolean;
}

export type VoiceFlow =
  | { phase: 'idle' }
  | { phase: 'requesting'; attempt: number }
  | { phase: 'recording'; attempt: number; startedAtMs: number }
  | { phase: 'stopping'; attempt: number; startedAtMs: number }
  | ({ phase: 'reviewing' } & VoiceDraftMeta)
  | ({ phase: 'sending' } & VoiceDraftMeta)
  | ({ phase: 'error'; error: string; sendAttempted: boolean } & VoiceDraftMeta)
  | { phase: 'unavailable'; error: string }
  | { phase: 'success'; transcript: string };

export type VoiceFlowEvent =
  | { type: 'START_REQUESTED'; attempt: number }
  | { type: 'START_SUCCEEDED'; attempt: number; startedAtMs: number }
  | { type: 'START_FAILED'; attempt: number; error: string }
  | { type: 'REQUEST_CANCELLED'; attempt: number }
  | { type: 'STOP_REQUESTED' }
  | { type: 'DRAFT_READY'; draft: VoiceDraftMeta; warning?: string }
  | { type: 'STOP_FAILED'; error: string }
  | { type: 'SEND_REQUESTED' }
  | { type: 'SEND_SUCCEEDED'; id: string; transcript: string }
  | { type: 'SEND_FAILED'; id: string; error: string; sendAttempted?: boolean }
  | { type: 'RESTORE_DRAFT'; draft: VoiceDraftMeta; error: string }
  | { type: 'DISCARD' }
  | { type: 'CYCLE_ENDED' };

export type VoiceVisualFlow =
  | { phase: 'none' }
  | { phase: 'selecting'; attempt: number; previousSelectionId?: number }
  | { phase: 'selected'; selectionId: number }
  | { phase: 'error'; error: string; selectionId?: number };

export type VoiceVisualFlowEvent =
  | { type: 'SELECT_REQUESTED'; attempt: number }
  | { type: 'SELECT_SUCCEEDED'; attempt: number }
  | { type: 'SELECT_CANCELLED'; attempt: number }
  | { type: 'SELECT_FAILED'; attempt: number; error: string }
  | { type: 'SELECTION_INVALIDATED'; error: string }
  | { type: 'CLEAR' }
  | { type: 'CYCLE_ENDED' };

export const initialVoiceFlow: VoiceFlow = { phase: 'idle' };
export const initialVoiceVisualFlow: VoiceVisualFlow = { phase: 'none' };

function draftMeta(flow: VoiceFlow): VoiceDraftMeta | undefined {
  if (flow.phase !== 'reviewing' && flow.phase !== 'sending' && flow.phase !== 'error') {
    return undefined;
  }
  return {
    id: flow.id,
    startedAtMs: flow.startedAtMs,
    durationMs: flow.durationMs,
    canSend: flow.canSend,
  };
}

export function voiceHasPendingWork(flow: VoiceFlow): boolean {
  return !['idle', 'success', 'unavailable'].includes(flow.phase);
}

export function voiceVisualHasSelection(flow: VoiceVisualFlow): boolean {
  return voiceVisualSelectionId(flow) !== undefined;
}

export function voiceVisualSelectionId(flow: VoiceVisualFlow): number | undefined {
  if (flow.phase === 'selected' || flow.phase === 'error') return flow.selectionId;
  if (flow.phase === 'selecting') return flow.previousSelectionId;
  return undefined;
}

export function voiceVisualMatchesSelection(
  flow: VoiceVisualFlow,
  selectionId: number | undefined,
): boolean {
  if (selectionId === undefined) return false;
  if (flow.phase === 'selecting') {
    return flow.attempt === selectionId || flow.previousSelectionId === selectionId;
  }
  return voiceVisualSelectionId(flow) === selectionId;
}

export function voiceVisualFlowReducer(
  flow: VoiceVisualFlow,
  event: VoiceVisualFlowEvent,
): VoiceVisualFlow {
  switch (event.type) {
    case 'SELECT_REQUESTED':
      return {
        phase: 'selecting',
        attempt: event.attempt,
        ...(voiceVisualSelectionId(flow) !== undefined
          ? { previousSelectionId: voiceVisualSelectionId(flow) }
          : {}),
      };
    case 'SELECT_SUCCEEDED':
      return flow.phase === 'selecting' && flow.attempt === event.attempt
        ? { phase: 'selected', selectionId: event.attempt }
        : flow;
    case 'SELECT_CANCELLED':
      if (flow.phase !== 'selecting' || flow.attempt !== event.attempt) return flow;
      return flow.previousSelectionId !== undefined
        ? { phase: 'selected', selectionId: flow.previousSelectionId }
        : initialVoiceVisualFlow;
    case 'SELECT_FAILED':
      return flow.phase === 'selecting' && flow.attempt === event.attempt
        ? {
            phase: 'error',
            error: event.error,
            ...(flow.previousSelectionId !== undefined
              ? { selectionId: flow.previousSelectionId }
              : {}),
          }
        : flow;
    case 'SELECTION_INVALIDATED':
      return { phase: 'error', error: event.error };
    case 'CLEAR':
    case 'CYCLE_ENDED':
      return initialVoiceVisualFlow;
    default:
      return flow;
  }
}

export function voiceFlowReducer(flow: VoiceFlow, event: VoiceFlowEvent): VoiceFlow {
  switch (event.type) {
    case 'START_REQUESTED':
      return { phase: 'requesting', attempt: event.attempt };
    case 'START_SUCCEEDED':
      return flow.phase === 'requesting' && flow.attempt === event.attempt
        ? { phase: 'recording', attempt: event.attempt, startedAtMs: event.startedAtMs }
        : flow;
    case 'START_FAILED':
      return flow.phase === 'requesting' && flow.attempt === event.attempt
        ? { phase: 'unavailable', error: event.error }
        : flow;
    case 'REQUEST_CANCELLED':
      return flow.phase === 'requesting' && flow.attempt === event.attempt
        ? initialVoiceFlow
        : flow;
    case 'STOP_REQUESTED':
      return flow.phase === 'recording'
        ? { phase: 'stopping', attempt: flow.attempt, startedAtMs: flow.startedAtMs }
        : flow;
    case 'DRAFT_READY':
      if (flow.phase !== 'stopping') return flow;
      return event.warning
        ? { phase: 'error', ...event.draft, error: event.warning, sendAttempted: false }
        : { phase: 'reviewing', ...event.draft };
    case 'STOP_FAILED':
      return flow.phase === 'stopping' ? { phase: 'unavailable', error: event.error } : flow;
    case 'SEND_REQUESTED': {
      const draft = draftMeta(flow);
      return draft && draft.canSend ? { phase: 'sending', ...draft } : flow;
    }
    case 'SEND_SUCCEEDED':
      return flow.phase === 'sending' && flow.id === event.id
        ? { phase: 'success', transcript: event.transcript }
        : flow;
    case 'SEND_FAILED': {
      const draft = draftMeta(flow);
      return flow.phase === 'sending' && flow.id === event.id && draft
        ? {
            phase: 'error',
            ...draft,
            error: event.error,
            sendAttempted: event.sendAttempted ?? true,
          }
        : flow;
    }
    case 'RESTORE_DRAFT':
      return {
        phase: 'error',
        ...event.draft,
        error: event.error,
        sendAttempted: false,
      };
    case 'DISCARD':
    case 'CYCLE_ENDED':
      return initialVoiceFlow;
    default:
      return flow;
  }
}
