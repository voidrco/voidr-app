import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { observe } from '../src/browser.ts';
import { buildActions } from '../src/actions.ts';
import { StepRecovery } from '../src/recovery.ts';
import { createDecider, modelObservation } from '../src/decide.ts';
import { runEngine } from '../src/engine.ts';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<button>Cart</button><iframe srcdoc="<button>Background frame</button>"></iframe><div class="modal show" style="position:fixed;inset:0;background:white;z-index:10"><a href="http://localhost/cart">View Cart</a><iframe srcdoc="<button>Modal frame</button>"></iframe></div>');
  const observed = await observe(page);
  const offered = buildActions(observed, []).map(action => action.control.name);
  assert.ok(offered.includes('View Cart'));
  assert.ok(offered.includes('Modal frame'));
  assert.ok(!offered.includes('Cart'));
  assert.ok(!offered.includes('Background frame'));
  assert.equal(observed.activeModals.length, 1);
  await page.setContent('<div><h2>Blue Top</h2><div><ul><li><a href="#blue">View Product</a></li></ul></div></div><div><h2>Red Top</h2><div><ul><li><a href="#red">View Product</a></li></ul></div></div>');
  const products = (await observe(page)).controls;
  assert.ok(products[0].context.includes('Blue Top'));
  assert.ok(products[1].context.includes('Red Top'));
  console.log('OK: modal ativo, frames dentro/fora do modal e contexto de cards repetidos.');
} finally { await browser.close(); }

const observation = { url:'http://localhost/', text:'Product', controls:[] };
const action = { id:'a0',kind:'click',control:{frame:0,name:'Add',href:'',options:[],context:''} };
const recovery = new StepRecovery();
assert.equal(recovery.fail({kind:'blocked',reason:'Overlay',outcome:'not_executed'},observation,action),true);
assert.equal(recovery.candidates([action],observation).length,0);
assert.equal(recovery.candidates([action],{...observation,text:'Changed'}).length,1);
recovery.fail({kind:'unconfirmed',reason:'Unknown effect',outcome:'unknown'},observation,action);
assert.equal(recovery.candidates([action],{...observation,text:'Changed'}).length,0);
assert.equal(recovery.fail({kind:'no_action',reason:'No action',outcome:'not_executed'},observation),true);
assert.equal(recovery.fail({kind:'no_action',reason:'No action',outcome:'not_executed'},observation),false);

const answer = choice => ({type:'choice',choice,confidence:1,probabilities:{[choice]:1}});
const state = { satisfied:0 };
const client = {systemOne: async () => ({answers:{status:answer('done'),next:answer('a0'),satisfied:{type:'noul',noul:state.satisfied}},usage:{input_tokens:0,output_tokens:0},model:'test'})};
const decide = createDecider(client);
const input = {steps:['Search for Blue Top'],stepIndex:0,observation,actions:[action],history:['Filled search']};
assert.equal((await decide(input)).answer.choice,'a0');
state.satisfied=1;
assert.equal((await decide(input)).answer.choice,'step_done');
console.log('OK: conclusão exige evidência, ação obstruída não se repete e efeito desconhecido impede duplicação.');

const html = '<button style="position:fixed;top:20px" onclick="document.body.textContent=\'WRONG\'">Cart</button><div style="position:fixed;inset:0;background:white;z-index:10"><button style="margin-top:200px" onclick="document.body.innerHTML=\'<h1>Cart opened</h1>\'">View Cart</button></div>';
const server = createServer((_req,res) => {res.setHeader('Content-Type','text/html');res.end(html);});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const makeDecision = choice => ({answer:answer(choice),assessment:answer(choice==='step_done'?'done':'pending'),completionEvidence:{type:'noul',noul:choice==='step_done'?1:0},requiresVerification:false,actionVerified:false,usage:{input_tokens:0,output_tokens:0},model:'fixture',durationMs:0});
try {
  const config = {url:`http://127.0.0.1:${server.address().port}`,steps:['Open cart'],expected:['Cart opened'],maxActions:12,headed:false};
  const events = [];
  const result = await runEngine({config,outputRoot:'runs/resilience-tests',onEvent:event=>events.push(event),decide:async input=> {
    if(input.observation.text.includes('Cart opened')) return makeDecision('step_done');
    const name = input.failures.length ? 'View Cart' : 'Cart';
    const action = input.actions.find(action=>action.control.name===name);
    assert.ok(action,`${name} unavailable`);
    return makeDecision(action.id);
  }});
  assert.equal(result.status,'completed');
  assert.equal(result.actions,1);
  const saved = JSON.parse(await readFile(result.output+'/result.json','utf8'));
  assert.equal(saved.recoveries.length,1);
  assert.equal(saved.recoveries[0].kind,'blocked');
  assert.equal(saved.records[0].execution.outcome,'not_executed');
  assert.equal(saved.records[1].failures[0].kind,'blocked');
  assert.equal(events.filter(event=>event.type==='recovery').length,1);
  const stopped = await runEngine({config,outputRoot:'runs/resilience-tests',decide:async()=>makeDecision('unsure')});
  assert.equal(stopped.status,'uncertain');
  assert.equal(stopped.decisions,4);
  assert.equal(stopped.actions,0);
  console.log('OK: engine recupera uma obstrução real, executa alternativa e encerra após três recuperações sem progresso.');
} finally { server.close(); await once(server,'close'); }

const noisy = { url: 'https://example.com', text: 'Blue Top', controls: [{...action.control, value: '3', checked: false, href: 'https://ads.example/?token=' + 'x'.repeat(100000), context: 'Blue Top quantity 3', options: []}] };
const compact = modelObservation(noisy);
assert.ok(JSON.stringify(compact).length < 1000);
assert.equal(compact.controls[0].value, '3');
assert.equal(compact.controls[0].context, 'Blue Top quantity 3');
assert.equal(noisy.controls[0].href.length > 100000, true);
console.log('OK: contexto do modelo remove URLs publicitárias sem alterar a observação e os valores.');
