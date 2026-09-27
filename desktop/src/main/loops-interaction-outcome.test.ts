import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { runEngine, type EngineEvent } from '@voidr/loops-engine';
import { createDecider } from '../../../packages/loops-engine/src/decide';

// Regressão do defeito encontrado na prova real do executor Loops (JEV/Chromium):
// o passo pedia um clique que provoca uma falha de rede controlada, o clique foi
// executado e a mensagem de erro apareceu, mas o modelo respondia status=done 0.94
// com satisfied=0.13 e o motor recusava a conclusão (pending), pedia outra ação —
// que a própria instrução proíbe repetir — recebia `unsure` e encerrava `uncertain`
// após três recuperações, sem chegar aos passos seguintes.
//
// A nota de negócio (`satisfied`) media se a página confirmou o efeito e era usada
// como veto da conclusão. Interação executada e negócio bem-sucedido são eixos
// distintos, mas a exceção para teste negativo NÃO pode virar aprovação automática:
// exigir apenas status=done + satisfied baixo + texto alterado aprovaria um erro
// inesperado, porque essa é justamente a discordância que antes bloqueava. Por isso
// a exceção exige, com limiar preservado:
//   1. evidência do próprio motor: ação realmente executada e texto NOVO observado;
//   2. verificação explícita do modelo (`rejection=requested`) de que a rejeição
//      visível é a rejeição que a instrução pediu;
//   3. nenhuma verificação pedida pela instrução (stepKind fixo não pode esconder
//      uma asserção do modelo);
//   4. status done confiante e efeito de negócio NÃO confirmado (registrado como
//      `unconfirmed`, nunca como sucesso).
// Sem essa verificação explícita, o comportamento antigo permanece: nada é aprovado.

type Answers = {
  status: 'done' | 'pending' | 'blocked';
  confidence: number;
  satisfied: number;
  next?: string;
  intent?: 'action' | 'assertion' | 'action_assertion';
  evidence?: string;
  predicate?: 'contains' | 'absent' | 'semantic';
  rejection?: 'requested' | 'unexpected' | 'none';
  rejectionConfidence?: number;
};
type Criteria = Record<string, string>;
type State = {
  currentStep: string;
  fixedStepKind: 'action' | 'assertion' | null;
  executedActions: string[];
  page: { url: string; text: string; controls: { name: string; value: string }[] };
  assertionTerms: string[];
};
type Request = { state: State; questions: { next: { criteria: Criteria }; evidence: { criteria: Criteria } } };
type Client = Parameters<typeof createDecider>[0];
type DecisionInput = Parameters<ReturnType<typeof createDecider>>[0];
type EngineOptions = Parameters<typeof runEngine>[0];

const pick = (choice: string, confidence = 1) => ({ type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } });

/** Modelo determinístico: devolve as respostas registradas na prova real, a variante adversarial de erro
 * inesperado e as demais variantes que precisam continuar sem aprovação. `withRejectionAnswer: false`
 * representa um cliente que não responde à pergunta de correspondência da rejeição. */
function fakeClient(answer: (request: Request) => Answers, withRejectionAnswer = true) {
  return {
    systemOne: async (request: Request) => {
      const answers = answer(request);
      const questions = {
        needsHuman: { type: 'noul' as const, noul: 0 },
        assertionPredicate: pick(answers.predicate ?? 'semantic'),
        intent: pick(answers.intent ?? 'action'),
        evidence: pick(answers.evidence ?? 'none'),
        status: pick(answers.status, answers.confidence),
        satisfied: { type: 'noul' as const, noul: answers.satisfied },
        next: pick(answers.next ?? 'unsure'),
      };
      return {
        answers: withRejectionAnswer
          ? { ...questions, rejection: pick(answers.rejection ?? 'none', answers.rejectionConfidence ?? 1) }
          : questions,
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'test-decision-function',
      };
    },
  } as unknown as Client;
}

const decider = (answer: (request: Request) => Answers) => createDecider(fakeClient(answer));

function actionId(request: Request, ...needles: string[]) {
  const entry = Object.entries(request.questions.next.criteria)
    .find(([id, description]) => id !== 'unsure' && needles.every(needle => description.includes(needle)));
  if (!entry) throw new Error(`A fixture não ofereceu a ação ${needles.join(' + ')}: ${JSON.stringify(Object.values(request.questions.next.criteria))}`);
  return entry[0];
}

function regionId(request: Request, name: string, value: string) {
  const entry = Object.entries(request.questions.evidence.criteria)
    .filter(([id, description]) => id !== 'none' && description.includes(`"name":"${name}"`) && description.includes(`"value":"${value}"`))
    .sort((left, right) => left[1].length - right[1].length)[0];
  if (!entry) throw new Error(`A fixture não ofereceu região de evidência para ${name}=${value}.`);
  return entry[0];
}

const observation = (text: string) => ({ url: 'http://127.0.0.1/', title: '', readyState: 'complete', text, controls: [], evidence: [] }) as unknown as DecisionInput['observation'];
const clickAction = { id: 'a0', kind: 'click', control: { frame: 0, index: 0, name: 'Calcular prêmio', href: '', options: [], context: '' } } as unknown as DecisionInput['actions'][number];
const negativeStep = (overrides: Partial<DecisionInput> = {}): DecisionInput => ({
  steps: ['Clique uma vez em Calcular prêmio para executar o cálculo que terá uma falha de rede controlada.'],
  stepIndex: 0, stepKind: 'action', observation: observation('Calcular prêmio\nErro ao calcular prêmio!'),
  actions: [clickAction], history: ['{"interaction":"Clicar em “Calcular prêmio”","execution":"interaction_completed","addedText":["Erro ao calcular prêmio!"]}'],
  ...overrides,
});
// Respostas reais do modelo na prova: a página rejeitou o cálculo e ele não propôs outra ação.
const rejection: Answers = { status: 'done', confidence: 0.94, satisfied: 0.13, next: 'unsure', rejection: 'requested', rejectionConfidence: 0.9 };
const executedAndObserved = { performed: true, added: ['Erro ao calcular prêmio!'] };

describe('interação executada e negócio confirmado são eixos distintos', () => {
  it('conclui o passo quando a instrução pediu a rejeição, ela está visível e o modelo a confirma', async () => {
    const decision = await decider(() => rejection)(negativeStep({ interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('step_done');
    expect(decision.outcome).toBe('unconfirmed');
    expect(decision.interactionEvidence).toEqual(executedAndObserved);
  });

  it('NÃO aprova erro inesperado quando as duas respostas do modelo discordam (status done com efeito não confirmado)', async () => {
    // Instrução positiva (gravar com sucesso), HTTP 500 observado, status done 0.95 e satisfied 0.05.
    const adversarial = await decider(() => ({ status: 'done', confidence: 0.95, satisfied: 0.05, next: 'unsure', rejection: 'unexpected', rejectionConfidence: 0.93 }))(
      negativeStep({
        steps: ['Clique em Salvar para gravar o formulário.'],
        stepKind: 'action',
        observation: observation('Cadastro\nSalvar\nErro HTTP 500 ao gravar'),
        actions: [{ ...clickAction, control: { ...clickAction.control, name: 'Salvar' } }] as DecisionInput['actions'],
        history: ['{"interaction":"Clicar em “Salvar”","execution":"interaction_completed","addedText":["Erro HTTP 500 ao gravar"]}'],
        interaction: { performed: true, added: ['Erro HTTP 500 ao gravar'] },
      }));
    expect(adversarial.answer.choice).toBe('unsure');
    expect(adversarial.outcome).toBeUndefined();
  });

  it('não conclui quando a rejeição observada não é a solicitada', async () => {
    const decision = await decider(() => ({ ...rejection, rejection: 'none' }))(negativeStep({ interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('não conclui quando a confirmação da rejeição solicitada fica abaixo do limiar', async () => {
    const decision = await decider(() => ({ ...rejection, rejectionConfidence: 0.5 }))(negativeStep({ interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('não conclui quando a classificação da rejeição não foi respondida', async () => {
    const decision = await createDecider(fakeClient(() => rejection, false))(negativeStep({ interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('não conclui sem evidência observada do próprio motor, mesmo com o modelo afirmando done', async () => {
    const decision = await decider(() => rejection)(negativeStep({ interaction: { performed: false, added: [] } }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('não trata mudança arbitrária de texto como resultado observado', async () => {
    // A ação rodou, mas nada novo apareceu na página: só uma mudança qualquer não é prova.
    const decision = await decider(() => rejection)(negativeStep({ interaction: { performed: true, added: [] } }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('não conclui um passo ação e verificação mesmo com stepKind action', async () => {
    const decision = await decider(() => ({ ...rejection, intent: 'action_assertion' }))(negativeStep({ stepKind: 'action', interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('não conclui um passo que o modelo classificou como asserção mesmo com stepKind action', async () => {
    const decision = await decider(() => ({ ...rejection, intent: 'assertion' }))(negativeStep({ stepKind: 'action', interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('não conclui um passo classificado como asserção', async () => {
    const decision = await decider(() => ({ ...rejection, intent: 'assertion' }))(negativeStep({ stepKind: 'assertion', interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });

  it('exige verificação numa instrução de ação e asserção mesmo com stepKind action', async () => {
    // satisfied alto e status done: sem a correção, o passo passaria como ação comum, sem conferir o DOM.
    const decision = await decider(() => ({ status: 'done', confidence: 0.99, satisfied: 0.95, intent: 'action_assertion' }))(negativeStep({ stepKind: 'action' }));
    expect(decision.assertion).toMatchObject({ required: true, readOnly: false });
    expect(decision.answer.choice).toBe('step_done');
  });

  it('exige verificação de uma asserção pura mesmo com stepKind action', async () => {
    const decision = await decider(() => ({ status: 'done', confidence: 0.99, satisfied: 0.95, intent: 'assertion' }))(negativeStep({ stepKind: 'action' }));
    expect(decision.assertion).toMatchObject({ required: true, readOnly: true });
  });

  it('mantém a exigência da configuração mesmo quando o modelo não pede verificação', async () => {
    const decision = await decider(() => ({ status: 'done', confidence: 0.99, satisfied: 0.95, intent: 'action' }))(negativeStep({ stepKind: 'assertion' }));
    expect(decision.assertion).toMatchObject({ required: true, readOnly: true });
  });

  it('não exige verificação numa ação comum', async () => {
    const decision = await decider(() => ({ status: 'done', confidence: 0.99, satisfied: 0.95, intent: 'action' }))(negativeStep({ stepKind: 'action' }));
    expect(decision.assertion).toMatchObject({ required: false, readOnly: false });
    expect(decision.answer.choice).toBe('step_done');
  });

  it('conclui como confirmado quando a página provou o efeito pedido', async () => {
    const decision = await decider(() => ({ status: 'done', confidence: 0.95, satisfied: 0.9 }))(negativeStep());
    expect(decision.answer.choice).toBe('step_done');
    expect(decision.outcome).toBe('confirmed');
  });

  it('mantém bloqueado o erro inesperado que o passo não pediu', async () => {
    const decision = await decider(() => ({ status: 'blocked', confidence: 0.9, satisfied: 0.02, rejection: 'unexpected' }))(negativeStep({ interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('blocked');
    expect(decision.outcome).toBeUndefined();
  });

  it('não conclui quando o modelo considera que o efeito ainda falta, mesmo após executar a ação', async () => {
    const decision = await decider(() => ({ status: 'pending', confidence: 0.9, satisfied: 0.04, next: 'unsure', rejection: 'unexpected' }))(negativeStep({ interaction: executedAndObserved }));
    expect(decision.answer.choice).toBe('unsure');
    expect(decision.outcome).toBeUndefined();
  });
});

// Executa o motor real em Chromium. Sem navegador disponível o bloco é ignorado.
const browserAvailable = await chromium.launch().then(async instance => { await instance.close(); return true; }).catch(() => false);

const fixture = (body: string) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>body{font:18px system-ui;padding:30px}label{display:block;margin:12px}input{padding:8px}button{padding:12px}#alerts{color:#b00}</style><body>${body}</body></html>`;
const negativeFixture = fixture(`<h1>Recuperação do formulário</h1><label>Número do documento <input id="nr_dfv" value="123456"></label>
<button type="button" id="calcular">Calcular prêmio</button><p id="alerts"></p>
<script>document.getElementById('calcular').addEventListener('click',()=>{document.getElementById('alerts').textContent='Erro ao calcular prêmio!'})</script>`);
const unexpectedFixture = fixture(`<h1>Cadastro</h1><label>Nome <input id="nome" value="Teste"></label>
<button type="button" id="salvar">Salvar</button><p id="alerts"></p>
<script>document.getElementById('salvar').addEventListener('click',()=>{document.getElementById('alerts').textContent='Falha inesperada do servidor'})</script>`);
// Erro HTTP 500 real, observado pela própria página depois da ação pedida pela instrução positiva.
const failingSaveFixture = fixture(`<h1>Cadastro</h1><label>Nome <input id="nome" value="Teste"></label>
<button type="button" id="salvar">Salvar</button><p id="alerts"></p>
<script>document.getElementById('salvar').addEventListener('click',async()=>{const response=await fetch('/save',{method:'POST'});document.getElementById('alerts').textContent=response.ok?'Registro gravado':'Erro HTTP '+response.status+' ao gravar'})</script>`);
const silentFixture = fixture('<h1>Painel</h1><button type="button" id="recalcular">Recalcular</button>');
// O campo recusa o valor pedido: a página volta para 123456, então a condição "contém 654321" é falsa no DOM.
const refusingFixture = fixture(`<h1>Recuperação do formulário</h1><label>Número do documento <input id="nr_dfv" value="123456"></label>
<script>document.getElementById('nr_dfv').addEventListener('input',event=>{event.target.value='123456'})</script>`);
// A ação só REMOVE texto da página: uma mudança qualquer não é resultado observado.
const removalFixture = fixture(`<h1>Painel</h1><p id="hint">Dica: confira os dados antes de enviar</p>
<button type="button" id="calcular">Calcular prêmio</button>
<script>document.getElementById('calcular').addEventListener('click',()=>{document.getElementById('hint').remove()})</script>`);

async function serve(html: string, failingPath?: string) {
  const server = createServer((request, response) => {
    if (failingPath && request.url === failingPath) {
      request.resume();
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Controlled failure' }));
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/`, close: async () => { server.close(); await once(server, 'close'); } };
}

type SavedRecord = { stepIndex: number; outcome?: string; decision: { request: { state: { executedActions: string[] } } } };
type SavedDecision = SavedRecord & { decision: { answer: { choice: string }; outcome?: string; interactionEvidence?: { performed: boolean; added: string[] };
  response: { answers: { status: { choice: string; confidence: number }; satisfied: { noul: number }; rejection?: { choice: string; confidence: number } } } } };
/** Mensagem de falha com a razão e as decisões, sem depender de logs do teste. */
const report = (result: { reason: string }, trace: unknown) => JSON.stringify({ reason: result.reason, trace }, null, 1);
const traceOf = (records: SavedDecision[]) => records.map(record => ({ step: record.stepIndex, answer: record.decision.answer.choice,
  decidedOutcome: record.decision.outcome, recordedOutcome: record.outcome, status: record.decision.response.answers.status.choice,
  satisfied: record.decision.response.answers.satisfied.noul, rejection: record.decision.response.answers.rejection?.choice,
  ...record.decision.interactionEvidence }));

describe.skipIf(!browserAvailable)('motor real em Chromium', () => {
  const run = async (html: string, options: Omit<EngineOptions, 'secrets' | 'outputRoot'>, failingPath?: string) => {
    const origin = await serve(html, failingPath);
    const root = await mkdtemp(path.join(tmpdir(), 'voidr-loops-outcome-'));
    try {
      const events: Pick<EngineEvent, 'type' | 'stepIndex' | 'outcome'>[] = [];
      const result = await runEngine({ ...options, secrets: {}, outputRoot: root,
        onEvent: event => { if (['step_done', 'step_started'].includes(event.type)) events.push({ type: event.type, stepIndex: event.stepIndex, outcome: event.outcome }); },
        config: { ...options.config, url: origin.url } });
      const saved = JSON.parse(await readFile(path.join(result.output, 'result.json'), 'utf8')) as { records: SavedDecision[] };
      return { result, events, saved, trace: traceOf(saved.records) };
    } finally { await origin.close(); await rm(root, { recursive: true, force: true }); }
  };

  it('conclui o teste negativo, avança para os passos seguintes e não reporta sucesso de negócio', async () => {
    const decided = decider(request => {
      const { state } = request;
      if (state.fixedStepKind === 'assertion') return { status: 'done', confidence: 0.95, satisfied: 0.9, intent: 'assertion',
        predicate: 'semantic', evidence: regionId(request, 'nr_dfv', '654321') };
      if (state.currentStep.includes('Calcular prêmio')) return state.executedActions.length
        ? { status: 'done', confidence: 0.94, satisfied: 0.13, next: 'unsure', rejection: 'requested', rejectionConfidence: 0.9 }
        : { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'click "Calcular prêmio"') };
      const document = state.page.controls.find(control => control.name.trim() === 'Número do documento')?.value;
      return document === '654321' ? { status: 'done', confidence: 0.95, satisfied: 0.9 }
        : { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'fill "Número do documento', '"654321"') };
    });
    const { result, events, saved, trace } = await run(negativeFixture, { decide: decided,
      config: { url: '', headed: false, maxActions: 12, expected: [], stepKinds: ['action', 'action', 'assertion'],
        steps: ['Clique uma vez em Calcular prêmio para executar o cálculo que terá uma falha de rede controlada.',
          'Altere o campo Número do documento de 123456 para 654321.',
          'Confirme que o campo Número do documento contém 654321.'] } });
    expect(result, report(result, trace)).toMatchObject({ status: 'completed', completedSteps: 3 });
    expect(result.actions).toBe(2);
    expect(result.assertions.map(assertion => assertion.status)).toEqual(['passed']);
    expect(events.filter(event => event.type === 'step_done')).toEqual([
      { type: 'step_done', stepIndex: 0, outcome: 'unconfirmed' },
      { type: 'step_done', stepIndex: 1, outcome: 'confirmed' },
      { type: 'step_done', stepIndex: 2, outcome: 'confirmed' },
    ]);
    // O desfecho fica registrado na decisão que concluiu cada passo: a rejeição não vira sucesso.
    expect(saved.records.filter(record => record.outcome).map(record => `${record.stepIndex}:${record.outcome}`))
      .toEqual(['0:unconfirmed', '1:confirmed', '2:confirmed']);
    // A conclusão do passo negativo cita a verificação explícita da rejeição solicitada e o texto novo observado.
    const rejected = saved.records[1]!;
    expect(rejected.decision.response.answers.rejection).toMatchObject({ choice: 'requested' });
    expect(rejected.decision.interactionEvidence?.added).toEqual(['Erro ao calcular prêmio!']);
    // A rejeição continua disponível como evidência do que a página fez, sem afirmar sucesso da interação.
    const reported = saved.records.flatMap(record => record.decision.request.state.executedActions)
      .find(entry => entry.includes('Erro ao calcular prêmio!'));
    expect(reported).toContain('interaction_completed');
  }, 90_000);

  it('NÃO aprova HTTP 500 inesperado numa instrução positiva, mesmo com status done e confiança alta', async () => {
    const config = { url: '', headed: false, maxActions: 12, expected: [], stepKinds: ['action' as const],
      steps: ['Clique em Salvar para gravar o formulário.'] };
    const adversarial = await run(failingSaveFixture, { config, decide: decider(request => request.state.executedActions.length
      ? { status: 'done', confidence: 0.95, satisfied: 0.05, next: 'unsure', rejection: 'unexpected', rejectionConfidence: 0.93 }
      : { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'click "Salvar"') }) }, '/save');
    // O 500 é real e observado pela página; a jornada não pode concluir o passo nem registrar desfecho.
    expect(adversarial.trace.some(item => item.added?.some(text => text.includes('Erro HTTP 500')))).toBe(true);
    expect(adversarial.result, report(adversarial.result, adversarial.trace)).toMatchObject({ status: 'uncertain', completedSteps: 0 });
    expect(adversarial.result.actions).toBe(1);
    expect(adversarial.events.filter(event => event.type === 'step_done')).toEqual([]);
    expect(adversarial.saved.records.length).toBeGreaterThan(0);
    expect(adversarial.saved.records.every(record => record.outcome === undefined)).toBe(true);
  }, 90_000);

  it('mantém bloqueada a jornada cujo erro o passo não pediu', async () => {
    const config = { url: '', headed: false, maxActions: 12, expected: [], stepKinds: ['action' as const],
      steps: ['Clique em Salvar para gravar o formulário.'] };
    const blocked = await run(unexpectedFixture, { config, decide: decider(request => {
      if (!request.state.executedActions.length) return { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'click "Salvar"') };
      return request.state.page.text.includes('Falha inesperada')
        ? { status: 'blocked', confidence: 0.9, satisfied: 0.02, rejection: 'unexpected' }
        : { status: 'pending', confidence: 0.9, satisfied: 0.05 };
    }) });
    expect(blocked.result, report(blocked.result, blocked.trace)).toMatchObject({ status: 'blocked', completedSteps: 0 });
    expect(blocked.result.actions).toBe(1);
    expect(blocked.events.filter(event => event.type === 'step_done')).toEqual([]);
    expect(blocked.saved.records.length).toBeGreaterThan(0);
    expect(blocked.saved.records.every(record => record.outcome === undefined)).toBe(true);

    const pending = await run(unexpectedFixture, { config, decide: decider(request => request.state.executedActions.length
      ? { status: 'pending', confidence: 0.9, satisfied: 0.03, next: 'unsure', rejection: 'unexpected' }
      : { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'click "Salvar"') }) });
    expect(pending.result, report(pending.result, pending.trace)).toMatchObject({ status: 'uncertain', completedSteps: 0 });
    expect(pending.events.filter(event => event.type === 'step_done')).toEqual([]);
    expect(pending.saved.records.every(record => record.outcome === undefined)).toBe(true);
  }, 90_000);

  it('não conclui uma ação executada cujo resultado não apareceu na página', async () => {
    const silent = await run(silentFixture, { config: { url: '', headed: false, maxActions: 12, expected: [], stepKinds: ['action'],
      steps: ['Clique em Recalcular para atualizar os dados.'] }, decide: decider(request => request.state.executedActions.length
      ? { status: 'done', confidence: 0.93, satisfied: 0.1, next: 'unsure', rejection: 'requested', rejectionConfidence: 0.9 }
      : { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'click "Recalcular"') }) });
    expect(silent.result, report(silent.result, silent.trace)).toMatchObject({ status: 'uncertain', completedSteps: 0 });
    expect(silent.result.decisions).toBe(5);
    expect(silent.events.filter(event => event.type === 'step_done')).toEqual([]);
    expect(silent.saved.records.every(record => record.outcome === undefined)).toBe(true);
  }, 90_000);

  it('não passa como ação comum quando a instrução pede ação e verificação e a evidência do DOM contradiz o modelo', async () => {
    const refusing = await run(refusingFixture, { config: { url: '', headed: false, maxActions: 12, expected: [], stepKinds: ['action'],
      steps: ['Altere o campo Número do documento de 123456 para 654321 e confirme que ele contém 654321.'] },
      decide: decider(request => request.state.executedActions.length
        // O modelo afirma o efeito satisfeito, mas a página continua mostrando 123456.
        ? { status: 'done', confidence: 0.99, satisfied: 0.95, intent: 'action_assertion',
          predicate: request.state.assertionTerms.includes('654321') ? 'contains' : 'semantic',
          evidence: regionId(request, 'nr_dfv', '123456') }
        : { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'fill "Número do documento', '"654321"') }) });
    expect(refusing.result, report(refusing.result, refusing.trace)).toMatchObject({ status: 'assertion_failed', completedSteps: 0 });
    expect(refusing.result.assertions.map(assertion => assertion.status)).toEqual(['failed']);
    expect(refusing.result.assertions[0]!.reason).toContain('654321');
    expect(refusing.events.filter(event => event.type === 'step_done')).toEqual([]);
    // A ação até rodou, mas o passo não foi dado como concluído.
    expect(refusing.result.actions).toBe(1);
  }, 90_000);

  it('não passa como ação comum quando a instrução pede verificação e não há região de evidência', async () => {
    const missing = await run(refusingFixture, { config: { url: '', headed: false, maxActions: 12, expected: [], stepKinds: ['action'],
      steps: ['Confirme que o campo Número do documento contém 654321.'] },
      decide: decider(() => ({ status: 'done', confidence: 0.99, satisfied: 0.95, intent: 'assertion', predicate: 'semantic', evidence: 'none' })) });
    // Sem região verificável o passo nunca é dado como concluído: o motor encerra 'unverified'.
    expect(missing.result, report(missing.result, missing.trace)).toMatchObject({ status: 'unverified', completedSteps: 0 });
    expect(missing.result.assertions.map(assertion => assertion.status)).toEqual(['unverified']);
    expect(missing.events.filter(event => event.type === 'step_done')).toEqual([]);
    expect(missing.saved.records.every(record => record.outcome === undefined)).toBe(true);
  }, 90_000);

  it('não trata remoção de texto como resultado observado da ação', async () => {
    const removed = await run(removalFixture, { config: { url: '', headed: false, maxActions: 12, expected: [], stepKinds: ['action'],
      steps: ['Clique em Calcular prêmio para concluir o cálculo.'] }, decide: decider(request => request.state.executedActions.length
      ? { status: 'done', confidence: 0.94, satisfied: 0.1, next: 'unsure', rejection: 'requested', rejectionConfidence: 0.9 }
      : { status: 'pending', confidence: 1, satisfied: 0.05, next: actionId(request, 'click "Calcular prêmio"') }) });
    expect(removed.result, report(removed.result, removed.trace)).toMatchObject({ status: 'uncertain', completedSteps: 0 });
    expect(removed.events.filter(event => event.type === 'step_done')).toEqual([]);
    // A página apenas perdeu texto: nada novo foi exibido ao usuário.
    expect(removed.trace.some(item => item.added && item.added.length > 0)).toBe(false);
    expect(removed.saved.records.every(record => record.outcome === undefined)).toBe(true);
  }, 90_000);
});
