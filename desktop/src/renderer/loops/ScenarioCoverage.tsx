import { useEffect, useState } from 'react';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import type { AiRun, AiScenario } from '../../shared/ai-tester';

const angles: Record<string, string> = { happy_path: 'Fluxo principal', validation: 'Validação', permissions: 'Permissões', boundary: 'Limites', recovery: 'Recuperação', alternative: 'Caminho alternativo', regression: 'Regressão' };
const outcomes: Record<string, string> = { passed: 'Passou', divergence: 'Divergência encontrada', unable_to_verify: 'Não foi possível verificar', blocked: 'Bloqueado', cancelled: 'Cancelado' };

function scenarioStatus(scenario: AiScenario, run?: AiRun) {
  const journey = run?.plan?.journeys.find(item => item.scenarioId === scenario.id && item.scenarioVersion === scenario.version);
  const result = run?.results.find(item => item.journeyId === journey?.id);
  if (result) return outcomes[result.outcome];
  if (scenario.state === 'suggested') return 'Sugestão · expectativa a confirmar';
  if (scenario.state === 'blocked' || journey?.blockers.length) return 'Bloqueado';
  if (run && ['completed', 'cancelled', 'interrupted'].includes(run.status)) return 'Não executado nesta revisão';
  return journey ? 'Pronto para testar' : 'Sem passos preparados nesta revisão';
}

export function ScenarioCoverage({ scenarios, run }: { scenarios: AiScenario[]; run?: AiRun }) {
  return <details className="workspace-scenario-coverage">
    <summary>Cenários da feature · {scenarios.length}</summary>
    {!scenarios.length && <p>Os cenários são preparados ao consolidar os testes humanos do Loop.</p>}
    {scenarios.map(scenario => <article key={scenario.id} className="ai-tester-journey">
      <strong>{scenario.title}</strong><span>{scenarioStatus(scenario, run)}</span>
      <p>{angles[scenario.angle] ?? scenario.angle} · {scenario.actor}</p>
      <p>{scenario.expectation.text}</p>
      {scenario.prerequisites.length > 0 && <p>Pré-condições: {scenario.prerequisites.join('; ')}</p>}
      {scenario.data.length > 0 && <p>Dados: {scenario.data.join('; ')}</p>}
      {run?.plan?.journeys.find(journey => journey.scenarioId === scenario.id)?.steps && <details><summary>O que testar</summary>
        <ol>{run.plan.journeys.find(journey => journey.scenarioId === scenario.id)?.steps.map((step, index) => <li key={index}>{step.kind === 'assertion' ? 'Verificar: ' : ''}{step.instruction}</li>)}</ol>
      </details>}
      {scenario.blockers.map((blocker, index) => <p key={index}>{blocker}</p>)}
      <details><summary>Origem e revisão</summary>
        <p>{scenario.id} · {scenario.version.slice(0, 12)}</p>
        <p>{scenario.expectation.status === 'confirmed' ? 'Expectativa fundamentada na descrição' : scenario.expectation.status === 'conflict' ? 'Expectativas conflitantes' : 'Expectativa inferida do contexto; será verificada durante a execução'}</p>
        {scenario.sources.map(id => {
          const source = run?.sources.find(item => item.id === id);
          return <p key={id}>{source?.label ?? (id === 'description' ? 'Descrição do Loop' : id)}{source?.commit ? ` · commit ${source.commit.slice(0, 12)}` : ''}</p>;
        })}
      </details>
    </article>)}
    {run?.plan?.gaps?.map((gap, index) => <p key={index}>Lacuna: {gap}</p>)}
  </details>;
}

export function LoopScenarioCatalogue({ runtime, loopId }: { runtime: LocalRuntimeConfig; loopId: string }) {
  const [state, setState] = useState<{ run?: AiRun; error: boolean }>({ error: false });
  useEffect(() => {
    let active = true;
    setState({ error: false });
    const load = async () => {
      try {
        const run = await window.voidrCapture.aiTester.preparation({ runtime, loopId });
        if (active) setState({ run: run ?? undefined, error: false });
      } catch { if (active) setState(previous => ({ ...previous, error: true })); }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [runtime, loopId]);
  return <div>
    {state.error && <p role="status">Não foi possível carregar os cenários do Loop.</p>}
    {state.run?.status === 'planning' && <p role="status">Interpretando testes humanos e preparando cenários…</p>}
    {state.run?.error && <p role="alert">{state.run.error}</p>}
    <ScenarioCoverage scenarios={state.run?.plan?.scenarios ?? []} run={state.run} />
  </div>;
}
