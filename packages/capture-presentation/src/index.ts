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
  stopping: { title: 'Encerrando a captura', detail: 'Consolidando os últimos sinais da jornada.', tone: 'neutral' },
  sealed: { title: 'Captura preservada', detail: 'A sessão já pode ser recuperada com segurança.', tone: 'success' },
  attaching: { title: 'Organizando evidências', detail: 'Indexando replay, requests e referências do ciclo.', tone: 'neutral' },
  processing: { title: 'Preparando a entrega', detail: 'Montando o contexto citado para revisão.', tone: 'neutral' },
  ready_for_review: { title: 'Verificação pronta', detail: 'As evidências estão disponíveis na Voidr.', tone: 'success' },
  offline: { title: 'Sem conexão', detail: 'A captura foi preservada e retomará com segurança.', tone: 'warning' },
  recoverable_error: { title: 'Ação necessária', detail: 'Seus dados continuam preservados.', tone: 'warning' },
  terminal_error: { title: 'Captura indisponível', detail: 'Nenhuma conclusão foi inventada.', tone: 'error' },
};

export const finalizationStages = [
  {
    id: 'consolidate',
    title: 'Consolidando jornada',
    detail: 'Cliques, páginas, notas e requests finais.',
  },
  {
    id: 'preserve',
    title: 'Preservando captura',
    detail: 'Seal durável e recuperação garantida.',
  },
  {
    id: 'index',
    title: 'Indexando evidências',
    detail: 'Replay, frames e referências do ciclo.',
  },
  {
    id: 'deliver',
    title: 'Preparando revisão',
    detail: 'Contexto citado e entrega ao agente.',
  },
] as const;
