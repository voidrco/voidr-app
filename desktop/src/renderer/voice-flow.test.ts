import { describe, expect, it } from 'vitest';
import {
  initialVoiceFlow,
  initialVoiceVisualFlow,
  voiceFlowReducer,
  voiceHasPendingWork,
  voiceVisualFlowReducer,
  voiceVisualHasSelection,
  voiceVisualMatchesSelection,
} from './voice-flow';

const draft = { id: '123', startedAtMs: 4_000, durationMs: 2_000, canSend: true };

describe('voice flow', () => {
  it('ignores a late permission response after the request was cancelled', () => {
    const requesting = voiceFlowReducer(initialVoiceFlow, { type: 'START_REQUESTED', attempt: 1 });
    const cancelled = voiceFlowReducer(requesting, { type: 'REQUEST_CANCELLED', attempt: 1 });
    expect(voiceFlowReducer(cancelled, {
      type: 'START_SUCCEEDED',
      attempt: 1,
      startedAtMs: 10,
    })).toEqual(initialVoiceFlow);
  });

  it('stops into a reviewable local draft before sending', () => {
    const requesting = voiceFlowReducer(initialVoiceFlow, { type: 'START_REQUESTED', attempt: 1 });
    const recording = voiceFlowReducer(requesting, {
      type: 'START_SUCCEEDED',
      attempt: 1,
      startedAtMs: 4_000,
    });
    const stopping = voiceFlowReducer(recording, { type: 'STOP_REQUESTED' });
    expect(voiceFlowReducer(stopping, { type: 'DRAFT_READY', draft })).toEqual({
      phase: 'reviewing',
      ...draft,
    });
  });

  it('keeps the same draft after a send failure so retry is idempotent', () => {
    const reviewing = { phase: 'reviewing' as const, ...draft };
    const sending = voiceFlowReducer(reviewing, { type: 'SEND_REQUESTED' });
    expect(voiceFlowReducer(sending, { type: 'SEND_FAILED', id: draft.id, error: 'Sem rede' })).toEqual({
      phase: 'error',
      ...draft,
      error: 'Sem rede',
      sendAttempted: true,
    });
  });

  it('keeps visual preflight failures editable because nothing was persisted', () => {
    const reviewing = { phase: 'reviewing' as const, ...draft };
    const sending = voiceFlowReducer(reviewing, { type: 'SEND_REQUESTED' });
    expect(voiceFlowReducer(sending, {
      type: 'SEND_FAILED',
      id: draft.id,
      error: 'Selecione a área novamente.',
      sendAttempted: false,
    })).toEqual({
      phase: 'error',
      ...draft,
      error: 'Selecione a área novamente.',
      sendAttempted: false,
    });
  });

  it('restores the previous draft when recording again cannot start', () => {
    const requesting = voiceFlowReducer(initialVoiceFlow, {
      type: 'START_REQUESTED',
      attempt: 2,
    });
    expect(voiceFlowReducer(requesting, {
      type: 'RESTORE_DRAFT',
      draft,
      error: 'A gravação anterior foi preservada.',
    })).toEqual({
      phase: 'error',
      ...draft,
      error: 'A gravação anterior foi preservada.',
      sendAttempted: false,
    });
  });

  it('ignores a late send response after another draft became active', () => {
    const newer = {
      phase: 'sending' as const,
      ...draft,
      id: 'newer-segment',
    };
    expect(voiceFlowReducer(newer, {
      type: 'SEND_SUCCEEDED',
      id: draft.id,
      transcript: 'resposta antiga',
    })).toEqual(newer);
    expect(voiceFlowReducer(newer, {
      type: 'SEND_FAILED',
      id: draft.id,
      error: 'falha antiga',
    })).toEqual(newer);
  });

  it('does not offer sending for a too-short draft', () => {
    const stopping = { phase: 'stopping' as const, attempt: 2, startedAtMs: 0 };
    const next = voiceFlowReducer(stopping, {
      type: 'DRAFT_READY',
      draft: { ...draft, canSend: false },
      warning: 'Muito curta',
    });
    expect(next).toMatchObject({ phase: 'error', canSend: false, sendAttempted: false });
    expect(voiceFlowReducer(next, { type: 'SEND_REQUESTED' })).toEqual(next);
  });

  it('treats every unresolved operation as pending work', () => {
    expect(voiceHasPendingWork({ phase: 'requesting', attempt: 1 })).toBe(true);
    expect(voiceHasPendingWork({ phase: 'reviewing', ...draft })).toBe(true);
    expect(voiceHasPendingWork({ phase: 'success', transcript: 'pronto' })).toBe(false);
  });
});

describe('voice visual context', () => {
  it('cancels a first selection without affecting the voice draft', () => {
    const selecting = voiceVisualFlowReducer(initialVoiceVisualFlow, {
      type: 'SELECT_REQUESTED',
      attempt: 1,
    });
    expect(voiceVisualFlowReducer(selecting, {
      type: 'SELECT_CANCELLED',
      attempt: 1,
    })).toEqual(initialVoiceVisualFlow);
  });

  it('keeps the previous region when changing it is cancelled', () => {
    const selecting = voiceVisualFlowReducer({ phase: 'selected', selectionId: 1 }, {
      type: 'SELECT_REQUESTED',
      attempt: 2,
    });
    expect(voiceVisualFlowReducer(selecting, {
      type: 'SELECT_CANCELLED',
      attempt: 2,
    })).toEqual({ phase: 'selected', selectionId: 1 });
  });

  it('ignores a late selection result after Escape', () => {
    const selecting = voiceVisualFlowReducer(initialVoiceVisualFlow, {
      type: 'SELECT_REQUESTED',
      attempt: 3,
    });
    const cancelled = voiceVisualFlowReducer(selecting, {
      type: 'SELECT_CANCELLED',
      attempt: 3,
    });
    expect(voiceVisualFlowReducer(cancelled, {
      type: 'SELECT_SUCCEEDED',
      attempt: 3,
    })).toEqual(initialVoiceVisualFlow);
  });

  it('preserves an existing region after a failed replacement for retry', () => {
    const selecting = voiceVisualFlowReducer({ phase: 'selected', selectionId: 1 }, {
      type: 'SELECT_REQUESTED',
      attempt: 4,
    });
    const failed = voiceVisualFlowReducer(selecting, {
      type: 'SELECT_FAILED',
      attempt: 4,
      error: 'A captura não ficou disponível.',
    });
    expect(voiceVisualHasSelection(failed)).toBe(true);
    expect(voiceVisualMatchesSelection(failed, 1)).toBe(true);
  });

  it('invalidates only the visual context when the captured page changes', () => {
    expect(voiceVisualFlowReducer({ phase: 'selected', selectionId: 1 }, {
      type: 'SELECTION_INVALIDATED',
      error: 'A página mudou.',
    })).toEqual({ phase: 'error', error: 'A página mudou.' });
  });
});
