import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2, RefreshCw, X } from 'lucide-react';
import type { UpdateState } from '../shared/update';

const labels: Record<UpdateState['phase'], string> = {
  idle: 'Atualizações', 'sign-in': 'Atualizações', checking: 'Buscando atualização',
  current: 'Capture atualizado', downloading: 'Baixando atualização', verifying: 'Verificando atualização',
  ready: 'Atualização pronta', installing: 'Reiniciando Capture', error: 'Atualização pendente',
  manual: 'Nova versão disponível', disabled: 'Versão de desenvolvimento',
};
const mb = (value: number) => `${(value / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;

export function UpdateCenter({ blocked }: { blocked: boolean }) {
  const [state, setState] = useState<UpdateState>();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const unsubscribe = window.voidrCapture.updates.onChange((next) => { changed = true; setState(next); });
    void window.voidrCapture.updates.status().then((next) => { if (alive && !changed) setState(next); }).catch(() => {
      if (alive) setActionError('Não foi possível consultar a versão. Reabra o Capture.');
    });
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const action = async (run: () => Promise<unknown>) => {
    setActionError(undefined);
    try { await run(); } catch { setActionError('A ação não pôde ser concluída. Tente novamente.'); }
  };
  if (!state) return null;
  const working = ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
  const percent = state.total ? Math.min(100, Math.floor((state.transferred ?? 0) / state.total * 100)) : undefined;
  const remaining = state.total && state.bytesPerSecond ? Math.ceil((state.total - (state.transferred ?? 0)) / state.bytesPerSecond) : undefined;
  const detail: Record<UpdateState['phase'], string> = {
    idle: 'O Capture verifica novas versões toda vez que é aberto.',
    'sign-in': 'Conecte seu workspace ou abra um convite para consultar as atualizações da sua conta.',
    checking: 'Consultando a versão disponível para este dispositivo.',
    current: 'Você está usando a versão mais recente disponível para este dispositivo.',
    downloading: 'Pode continuar trabalhando. Avisaremos quando estiver pronta.',
    verifying: 'Confirmando a assinatura do aplicativo antes de liberar o reinício.',
    ready: 'Reinicie quando for conveniente. Um convite pendente será retomado ao abrir o Capture.',
    installing: 'Aplicando a nova versão. O Capture vai abrir novamente.',
    error: 'Seu teste pode continuar. Tente novamente quando a conexão estiver disponível.',
    manual: 'Baixe o instalador da nova versão pela plataforma.',
    disabled: 'Esta execução não recebe atualizações automáticas. Use o aplicativo instalado.',
  };
  return <div className="capture-updates" ref={root}>
    <button type="button" className={`capture-update-trigger is-${state.phase}`} onClick={() => setOpen(!open)}
      disabled={blocked && !state.startup} aria-expanded={(open || Boolean(state.startup)) && (!blocked || Boolean(state.startup))} aria-controls="capture-update-panel"
      title={blocked ? `${labels[state.phase]}. Volte à tela de Loops para abrir as atualizações.` : `Voidr Capture ${state.currentVersion}`}>
      {working ? <Loader2 size={13} className="capture-update-spin" /> : state.phase === 'ready' ? <Download size={13} /> : <RefreshCw size={13} />}
      <span>{state.phase === 'idle' || state.phase === 'sign-in' || state.phase === 'disabled' ? `v${state.currentVersion}` : labels[state.phase]}</span>
      {state.phase === 'downloading' && percent !== undefined && <span>{percent}%</span>}
    </button>
    {(open || state.startup) && (!blocked || state.startup) && <section id="capture-update-panel" className="capture-update-panel" aria-label="Atualizações do Capture">
      <div className="capture-update-heading"><span>VOIDR CAPTURE</span><button type="button" aria-label="Fechar atualizações" onClick={() => setOpen(false)}><X size={16} /></button></div>
      <div aria-live="polite" aria-atomic="true"><h2>{labels[state.phase]}</h2><p>{state.message ?? (state.startup && working ? 'Atualizando antes de abrir seu teste. O convite será retomado automaticamente.' : detail[state.phase])}</p></div>
      <div className="capture-update-versions"><span>Instalada <strong>{state.currentVersion}</strong></span>{state.version && <span>Nova versão <strong>{state.version}</strong></span>}</div>
      {(state.phase === 'downloading' || state.phase === 'verifying') && <div className="capture-update-download">
        <progress aria-label={state.phase === 'verifying' ? 'Verificando assinatura' : 'Download da atualização'} max={100} value={state.phase === 'downloading' ? percent : undefined} />
        <div><span>{state.phase === 'verifying' ? 'Verificação de segurança' : `${mb(state.transferred ?? 0)}${state.total ? ` de ${mb(state.total)}` : ''}`}</span>
        <span>{state.phase === 'downloading' && state.bytesPerSecond ? `${mb(state.bytesPerSecond)}/s` : ''}</span></div>
        {state.phase === 'downloading' && remaining !== undefined && remaining > 0 && <small>Cerca de {remaining < 60 ? `${remaining} s` : `${Math.ceil(remaining / 60)} min`} restantes</small>}
      </div>}
      {state.phase === 'ready' && <div className="capture-update-safe"><Check size={15} /> Aplicativo verificado. Pronto para instalar.</div>}
      {state.notes && <details className="capture-update-notes"><summary>O que mudou nesta versão</summary><p>{state.notes}</p></details>}
      {actionError && <p role="alert">{actionError}</p>}
      <div className="capture-update-actions">
        {state.phase === 'ready' ? <><button type="button" onClick={() => setOpen(false)}>Mais tarde</button><button type="button" className="primary" onClick={() => void action(() => window.voidrCapture.updates.restart())}>Reiniciar e atualizar</button></> :
          state.phase === 'manual' ? <button type="button" className="primary" onClick={() => void action(() => window.voidrCapture.updates.openDownload())}>Abrir downloads</button> :
            !working && state.phase !== 'disabled' && <button type="button" className="primary" onClick={() => void action(() => window.voidrCapture.updates.check())}>{state.phase === 'error' ? 'Tentar novamente' : 'Verificar agora'}</button>}
      </div>
    </section>}
  </div>;
}
