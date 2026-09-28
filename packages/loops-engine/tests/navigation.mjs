import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { navigationActions } from '../src/navigation.ts';
import { executeAction } from '../src/actions.ts';
import { StepRecovery } from '../src/recovery.ts';
import { runEngine } from '../src/engine.ts';

const base = 'https://example.test/';
assert.deepEqual(navigationActions('Abrir a tela de login (rota /Login)', base), [{ id:'navigation_0',kind:'navigate',url:base+'Login' }]);
assert.equal(navigationActions('Navegar para /Nacional/AverbacaoRCV e aguardar',base)[0].url,base+'Nacional/AverbacaoRCV');
for (const step of ['Verificar /Login','Não navegar para /Login','Do not open /Login','Open //outside.test/x','Open https://outside.test/x','Open https://user:pass@example.test/Login','Open javascript:alert(1)','Open /{{env.SECRET}}','Open /\\outside.test/x']) {
  assert.deepEqual(navigationActions(step,base),[],step);
}
assert.deepEqual(navigationActions('Open /Login',base,'assertion'),[]);
assert.equal(navigationActions('Open /Login and /Login',base).length,1);
const action=navigationActions('Open /Login',base)[0];
const observation={url:base,text:'Unauthorized',controls:[]};
const recovery=new StepRecovery();
recovery.fail({kind:'unconfirmed',reason:'Timeout',outcome:'unknown'},observation,action);
assert.equal(recovery.candidates([action],{...observation,text:'Changed'}).length,0,'uncertain navigation is not replayed');
let navigations=0;
const page={url:()=>base,goto:async()=>{navigations++}};
await assert.rejects(executeAction({page,observation,action,credentialOrigin:base.slice(0,-1),allowedNavigationUrls:[]}),/autorizadas/);
await assert.rejects(executeAction({page,observation,action:{...action,url:'https://outside.test/'},credentialOrigin:base.slice(0,-1),allowedNavigationUrls:['https://outside.test/']}),/autorizadas/);
assert.equal(navigations,0);
assert.equal(await executeAction({page:{...page,url:()=>base+'changed'},observation,action,credentialOrigin:base.slice(0,-1),allowedNavigationUrls:[action.url]}),false);
console.log('OK: only explicit same-origin navigation; no assertions, external URLs, credentials or uncertain replay.');

const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/Login'){res.end('<h1>Login ready</h1><input name="username">')}else{res.statusCode=401;res.end('<h1>401 Unauthorized</h1>')}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const outputRoot=await mkdtemp(join(tmpdir(),'voidr-navigation-test-'));
const answer=choice=>({choice,confidence:1});
try {
 const origin=`http://127.0.0.1:${server.address().port}`;
 const result=await runEngine({config:{url:origin,steps:['Abrir a tela de login do sistema (rota /Login)'],stepKinds:['action'],expected:['Login ready'],headed:false,maxActions:5},outputRoot,decide:async input=>{
  const choice=input.observation.url===origin+'/Login'&&input.observation.text.includes('Login ready')?'step_done':input.actions.find(x=>x.kind==='navigate')?.id;
  assert.ok(choice,'the engine must offer the authored route even when the initial page has no controls');
  return {answer:answer(choice),requiresVerification:false,actionVerified:false,usage:{input_tokens:0,output_tokens:0}};
 }});
 assert.equal(result.status,'completed');assert.equal(result.actions,1);assert.equal(result.completedSteps,1);
 const saved=JSON.parse(await readFile(join(result.output,'result.json'),'utf8'));
 assert.equal(saved.records[0].observation.text,'401 Unauthorized');
 assert.equal(saved.records[0].execution,'interaction_completed');
 assert.equal(saved.finalObservation.url,origin+'/Login');
 assert.ok(result.artifacts.videos.length>0);
 console.log('OK: real Chromium leaves an initial 401 for the authored login route, with trace and video.');
 const failedCapture=await runEngine({config:{url:origin,steps:['Open /Login'],stepKinds:['action'],expected:[],headed:false,maxActions:5},outputRoot,
  captureSession:{setup:async()=>{},finish:async()=>{},ready:async page=>{if(page.url().endsWith('/Login'))throw Error('Collector unavailable on destination');}},
  decide:async input=>({answer:answer(input.actions.find(x=>x.kind==='navigate').id),requiresVerification:false,actionVerified:false,usage:{input_tokens:0,output_tokens:0}})});
 assert.equal(failedCapture.status,'error');assert.equal(failedCapture.completedSteps,0);
 const failedReport=JSON.parse(await readFile(join(failedCapture.output,'result.json'),'utf8'));
 assert.equal(failedReport.finalObservation.url,origin+'/Login');
 assert.equal(failedReport.finalObservation.text,'Login ready');
 assert.ok((await readFile(join(failedCapture.output,'final.png'))).length>0);
 console.log('OK: Collector failure preserves destination evidence and cannot pass the test.');
} finally { server.close();await once(server,'close');await rm(outputRoot,{recursive:true,force:true}); }
