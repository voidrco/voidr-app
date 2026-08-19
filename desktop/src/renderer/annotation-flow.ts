export type AnnotationKind = 'element' | 'region' | 'screen';
export type SelectableAnnotationKind = Exclude<AnnotationKind, 'screen'>;

export type AnnotationFlow =
  | { phase: 'closed'; note: '' }
  | { phase: 'choosing'; note: string }
  | { phase: 'selecting'; kind: SelectableAnnotationKind; note: string; attempt: number }
  | { phase: 'composing'; kind: AnnotationKind; note: string }
  | { phase: 'saving'; kind: AnnotationKind; note: string };

export type AnnotationFlowEvent =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'CHOOSE'; kind: AnnotationKind; attempt: number }
  | { type: 'SELECTION_SUCCEEDED'; kind: SelectableAnnotationKind; attempt: number }
  | { type: 'SELECTION_CANCELLED'; attempt: number }
  | { type: 'BACK' }
  | { type: 'CHANGE_NOTE'; note: string }
  | { type: 'SAVE_STARTED' }
  | { type: 'SAVE_SUCCEEDED' }
  | { type: 'SAVE_FAILED' }
  | { type: 'RECORDING_ENDED' };

export const initialAnnotationFlow: AnnotationFlow = { phase: 'closed', note: '' };

export function annotationFlowReducer(
  state: AnnotationFlow,
  event: AnnotationFlowEvent,
): AnnotationFlow {
  switch (event.type) {
    case 'OPEN':
      return state.phase === 'closed' ? { phase: 'choosing', note: '' } : state;
    case 'CLOSE':
    case 'SAVE_SUCCEEDED':
    case 'RECORDING_ENDED':
      return initialAnnotationFlow;
    case 'CHOOSE':
      return event.kind === 'screen'
        ? { phase: 'composing', kind: 'screen', note: state.note }
        : { phase: 'selecting', kind: event.kind, note: state.note, attempt: event.attempt };
    case 'SELECTION_SUCCEEDED':
      return state.phase === 'selecting' &&
        state.kind === event.kind &&
        state.attempt === event.attempt
        ? { phase: 'composing', kind: event.kind, note: state.note }
        : state;
    case 'SELECTION_CANCELLED':
      return state.phase === 'selecting' && state.attempt === event.attempt
        ? { phase: 'choosing', note: state.note }
        : state;
    case 'BACK':
      return state.phase === 'composing' || state.phase === 'selecting'
        ? { phase: 'choosing', note: state.note }
        : state;
    case 'CHANGE_NOTE':
      return state.phase === 'composing' ? { ...state, note: event.note } : state;
    case 'SAVE_STARTED':
      return state.phase === 'composing' && state.note.trim()
        ? { ...state, phase: 'saving' }
        : state;
    case 'SAVE_FAILED':
      return state.phase === 'saving' ? { ...state, phase: 'composing' } : state;
    default:
      return state;
  }
}

export function annotationKind(flow: AnnotationFlow): AnnotationKind | undefined {
  return 'kind' in flow ? flow.kind : undefined;
}

export function annotationIsActive(flow: AnnotationFlow): boolean {
  return flow.phase !== 'closed';
}
