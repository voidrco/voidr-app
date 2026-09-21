import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@voidr/capture-design-system';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import { isAllowedLoopTarget, type CreatedLoop, type LoopApplication, type LoopEnvironment } from '../shared/loop-creation';

type Props = { runtime: LocalRuntimeConfig; onClose: () => void; onCreated: (loop: CreatedLoop) => void };
type FormState = {
  applications: LoopApplication[]; environments: LoopEnvironment[];
  applicationId: string; environmentSlug: string; mission: string; publicAccess: boolean;
  targetUrl: string | null;
  loadingApplications: boolean; loadingEnvironments: boolean; submitting: boolean;
  error: string;
};
const initialState: FormState = {
  applications: [], environments: [], applicationId: '', environmentSlug: '', mission: '',
  publicAccess: false, loadingApplications: true, loadingEnvironments: false,
  targetUrl: null,
  submitting: false, error: '',
};

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Não foi possível criar o Loop.';
}

export function CreateLoopDialog({ runtime, onClose, onCreated }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [state, setState] = useState(initialState);
  const update = (patch: Partial<FormState>) => setState(current => ({ ...current, ...patch }));
  const environment = state.environments.find(item => item.slug === state.environmentSlug);
  const targetUrl = state.targetUrl ?? environment?.applicationUrl ?? '';
  const invalidUrl = !isAllowedLoopTarget(targetUrl.trim());

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setState(current => ({ ...current, loadingApplications: true, error: '' }));
    void window.voidrCapture.workspace.applications(runtime).then(applications => {
      if (active) setState(current => ({ ...current, applications, loadingApplications: false }));
    }).catch(reason => {
      if (active) setState(current => ({ ...current, error: failureMessage(reason), loadingApplications: false }));
    });
    return () => { active = false; };
  }, [runtime]);

  useEffect(() => {
    if (!state.applicationId) return;
    let active = true;
    setState(current => ({ ...current, loadingEnvironments: true, environments: [], environmentSlug: '', targetUrl: null }));
    void window.voidrCapture.workspace.environments(runtime, state.applicationId).then(environments => {
      if (active) setState(current => ({ ...current, environments, environmentSlug: environments.length === 1 ? environments[0]?.slug ?? '' : '', loadingEnvironments: false }));
    }).catch(reason => {
      if (active) setState(current => ({ ...current, error: failureMessage(reason), loadingEnvironments: false }));
    });
    return () => { active = false; };
  }, [runtime, state.applicationId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !environment || invalidUrl || !state.mission.trim()) return;
    submitting.current = true;
    update({ submitting: true, error: '' });
    try {
      const loop = await window.voidrCapture.workspace.createLoop(runtime, {
        applicationId: state.applicationId, environmentSlug: state.environmentSlug,
        targetUrl: targetUrl.trim(),
        featureUnderTest: state.mission.trim(), accessMode: state.publicAccess ? 'authenticated_link' : 'organization_only',
      });
      onCreated(loop);
    } catch (reason) {
      update({ error: failureMessage(reason), submitting: false });
    } finally { submitting.current = false; }
  }

  async function openEnvironments() {
    try { await window.voidrCapture.workspace.openEnvironments(runtime, state.applicationId); }
    catch (reason) { update({ error: failureMessage(reason) }); }
  }

  return <dialog ref={dialog} className="create-loop-dialog" aria-labelledby="create-loop-title" onCancel={event => {
    event.preventDefault();
    if (!submitting.current) onClose();
  }}>
    <form onSubmit={event => void submit(event)}>
      <header><div><h2 id="create-loop-title">Criar Loop</h2><p>Defina o que a equipe deve testar.</p></div>
        <button type="button" aria-label="Fechar" disabled={state.submitting} onClick={onClose}><X size={18} /></button></header>
      <fieldset disabled={state.submitting}>
        <label htmlFor="loop-application">Aplicação</label>
        <select id="loop-application" required value={state.applicationId} disabled={state.loadingApplications} onChange={event => update({ applicationId: event.target.value, environments: [], environmentSlug: '', targetUrl: null, error: '' })}>
          <option value="">{state.loadingApplications ? 'Carregando aplicações…' : 'Selecione uma aplicação'}</option>
          {state.applications.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {!state.loadingApplications && !state.applications.length && <small>Nenhuma aplicação disponível neste workspace.</small>}
        <label htmlFor="loop-environment">Ambiente</label>
        <select id="loop-environment" required value={state.environmentSlug} disabled={!state.applicationId || state.loadingEnvironments} onChange={event => update({ environmentSlug: event.target.value, targetUrl: null, error: '' })}>
          <option value="">{state.loadingEnvironments ? 'Carregando ambientes…' : 'Selecione um ambiente'}</option>
          {state.environments.map(item => <option key={item.slug} value={item.slug}>{item.name} · {item.slug}</option>)}
        </select>
        {state.applicationId && !state.loadingEnvironments && !state.environments.length && <small>Cadastre um ambiente para esta aplicação. <button type="button" onClick={() => void openEnvironments()}>Configurar na Voidr</button></small>}
        {environment && <><label htmlFor="loop-target">URL para testar</label><input id="loop-target" type="url" required value={targetUrl} placeholder="http://localhost:3000" onChange={event => update({ targetUrl: event.target.value, error: '' })} />
          <small>Usada neste Loop, sem alterar o cadastro do ambiente.</small>
          {invalidUrl && <small role="alert" className="create-loop-error">Use HTTPS ou um endereço local, como http://localhost:3000.</small>}</>}
        <label htmlFor="loop-mission">O que a equipe deve testar?</label>
        <textarea id="loop-mission" required maxLength={300} rows={3} placeholder="Ex.: concluir uma proposta de crédito rural" value={state.mission} onChange={event => update({ mission: event.target.value })} />
        <small className="create-loop-counter">{state.mission.length}/300</small>
        <label className="create-loop-access"><input type="checkbox" checked={state.publicAccess} onChange={event => update({ publicAccess: event.target.checked })} /><span>Qualquer pessoa com o link<small>A pessoa entra com Google para testar, sem acessar o workspace.</small></span></label>
      </fieldset>
      {state.error && <p role="alert" className="create-loop-error">{state.error}</p>}
      <footer>
        <Button type="button" disabled={state.submitting} onClick={onClose}>Cancelar</Button>
        <Button type="submit" variant="primary" disabled={state.submitting || state.loadingApplications || state.loadingEnvironments || !environment || !!invalidUrl || !state.mission.trim()}>{state.submitting && <Loader2 size={14} className="spin" />}{state.submitting ? 'Criando…' : 'Criar Loop'}</Button></footer>
    </form>
  </dialog>;
}
