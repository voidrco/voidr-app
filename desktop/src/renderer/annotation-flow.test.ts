import { describe, expect, it } from 'vitest';
import {
  annotationFlowReducer,
  initialAnnotationFlow,
  type AnnotationFlow,
} from './annotation-flow';

function reduce(flow: AnnotationFlow, ...events: Parameters<typeof annotationFlowReducer>[1][]) {
  return events.reduce(annotationFlowReducer, flow);
}

describe('annotation flow', () => {
  it('cancels element selection back to the chooser without creating a draft', () => {
    const selecting = reduce(
      initialAnnotationFlow,
      { type: 'OPEN' },
      { type: 'CHOOSE', kind: 'element', attempt: 7 },
    );

    expect(reduce(selecting, { type: 'SELECTION_CANCELLED', attempt: 7 })).toEqual({
      phase: 'choosing',
      note: '',
    });
  });

  it('ignores a late result from a cancelled selection attempt', () => {
    const selecting = reduce(
      initialAnnotationFlow,
      { type: 'OPEN' },
      { type: 'CHOOSE', kind: 'element', attempt: 3 },
    );
    const choosing = reduce(selecting, { type: 'BACK' });

    expect(
      reduce(choosing, { type: 'SELECTION_SUCCEEDED', kind: 'element', attempt: 3 }),
    ).toBe(choosing);
  });

  it('preserves a draft when going back and changing the capture target', () => {
    const composing = reduce(
      initialAnnotationFlow,
      { type: 'OPEN' },
      { type: 'CHOOSE', kind: 'screen', attempt: 1 },
      { type: 'CHANGE_NOTE', note: 'Esperado A, observado B' },
      { type: 'BACK' },
      { type: 'CHOOSE', kind: 'region', attempt: 2 },
      { type: 'SELECTION_SUCCEEDED', kind: 'region', attempt: 2 },
    );

    expect(composing).toEqual({
      phase: 'composing',
      kind: 'region',
      note: 'Esperado A, observado B',
    });
  });

  it('restores the same draft after a failed save and clears it only after success', () => {
    const saving = reduce(
      initialAnnotationFlow,
      { type: 'OPEN' },
      { type: 'CHOOSE', kind: 'screen', attempt: 1 },
      { type: 'CHANGE_NOTE', note: 'Falha intermitente' },
      { type: 'SAVE_STARTED' },
    );

    expect(reduce(saving, { type: 'SAVE_FAILED' })).toEqual({
      phase: 'composing',
      kind: 'screen',
      note: 'Falha intermitente',
    });
    expect(reduce(saving, { type: 'SAVE_SUCCEEDED' })).toBe(initialAnnotationFlow);
  });

  it('never starts saving a blank note', () => {
    const composing = reduce(
      initialAnnotationFlow,
      { type: 'OPEN' },
      { type: 'CHOOSE', kind: 'screen', attempt: 1 },
    );

    expect(reduce(composing, { type: 'SAVE_STARTED' })).toBe(composing);
  });
});
