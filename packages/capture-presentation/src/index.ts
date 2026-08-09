import type { CaptureStage } from '@voidr/capture-contracts';

export interface StageCopy {
  title: string;
  detail: string;
  tone: 'neutral' | 'live' | 'success' | 'warning' | 'error';
}

export const stageCopy: Record<CaptureStage, StageCopy> = {
  idle: { title: 'Pronto', detail: 'Capture uma aplicação Web ou Android.', tone: 'neutral' },
  preparing: { title: 'Preparando a verificação', detail: 'Confirmando acesso e contexto.', tone: 'neutral' },
  ready: { title: 'Aplicação pronta', detail: 'A captura começa quando você confirmar.', tone: 'neutral' },
  recording: { title: 'Capturando', detail: 'Interações e evidências estão sendo registradas.', tone: 'live' },
  stopping: { title: 'Consolidando interações', detail: 'Guardando os últimos cliques, páginas e requisições.', tone: 'neutral' },
  sealed: { title: 'Confirmando evidências', detail: 'A Voidr confirmou que a captura está preservada.', tone: 'success' },
  attaching: { title: 'Vinculando ao ciclo', detail: 'Organizando o contexto da verificação.', tone: 'neutral' },
  processing: { title: 'Preparando a análise', detail: 'Frames, replay e contexto estão sendo indexados.', tone: 'neutral' },
  ready_for_review: { title: 'Verificação pronta', detail: 'As evidências estão disponíveis na Voidr.', tone: 'success' },
  offline: { title: 'Sem conexão', detail: 'A captura foi preservada e retomará com segurança.', tone: 'warning' },
  recoverable_error: { title: 'Ação necessária', detail: 'Seus dados continuam preservados.', tone: 'warning' },
  terminal_error: { title: 'Captura indisponível', detail: 'Nenhuma conclusão foi inventada.', tone: 'error' },
};

export const finalizationStages = [
  'Consolidando interações',
  'Confirmando requisições',
  'Selando evidências',
  'Avisando o agente',
] as const;
