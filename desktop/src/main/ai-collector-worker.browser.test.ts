import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { AiCollectorWorker } from './ai-collector-worker';

it('records across a navigation into a page with a restrictive CSP', async () => {
  let loginGets=0, loginPosts=0;
  const collector = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/recorder.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end('globalThis.VoidrCollector={init:async function(o){const r=await fetch(o.collectorUrl+"/init");this.ready=r.ok},isCaptureReady:function(){return this.ready},captureNetwork(){},captureException(){}};');
    } else res.end('{}');
  });
  const site = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/Login') {
      if(req.method==='POST')loginPosts++;else loginGets++;
      res.setHeader('Content-Security-Policy', ["default-src 'self' 'unsafe-inline'", "connect-src 'self'; img-src 'self'"]);
      res.setHeader('Content-Encoding','gzip');
      res.end(gzipSync('<h1>Login ready</h1><form method="post" action="/Login"></form>'));
    } else { res.statusCode=401; res.end('<h1>401 Unauthorized</h1>'); }
  });
  collector.listen(0,'127.0.0.1'); site.listen(0,'127.0.0.1');
  await Promise.all([once(collector,'listening'), once(site,'listening')]);
  const origin=`http://127.0.0.1:${(site.address() as {port:number}).port}`;
  const collectorUrl=`http://127.0.0.1:${(collector.address() as {port:number}).port}`;
  const browser=await chromium.launch(); const context=await browser.newContext();
  const protocolFailures: string[]=[];
  const cdp=context.newCDPSession.bind(context);
  vi.spyOn(context,'newCDPSession').mockImplementation(async page => {
    const session=await cdp(page), send=session.send.bind(session);
    session.send=(async (method: string, params: unknown) => {
      try { return await (send as any)(method,params); }
      catch(error) { protocolFailures.push(`${method}: ${(error as Error).message}`); throw error; }
    }) as typeof session.send;
    return session;
  });
  try {
    const page=await context.newPage();
    const worker=new AiCollectorWorker({scriptUrl:collectorUrl+'/recorder.js',collectorUrl,targetUrl:origin,options:{collectorUrl}});
    await worker.setup(context);
    await page.goto(origin); await worker.ready(page);
    await page.goto(origin+'/Login');
    let failure: unknown; try { await worker.ready(page); } catch(error) { failure=error; }
    expect(protocolFailures.filter(error => error.startsWith('Fetch.'))).toEqual([]);
    expect(failure).toBeUndefined();
    expect(await page.locator('h1').textContent()).toBe('Login ready');
    await Promise.all([page.waitForNavigation(),page.evaluate(()=>document.querySelector('form')!.submit())]);
    await worker.ready(page);
    expect(loginGets).toBe(1);expect(loginPosts).toBe(1);
    // The application's own connections remain restricted; only Collector was added.
    const policy=await page.evaluate(() => new Promise<string>(resolve => {
      document.addEventListener('securitypolicyviolation',event=>resolve(event.effectiveDirective),{once:true});
      void fetch('https://unapproved.invalid/').catch(()=>undefined);
      setTimeout(()=>resolve('no-policy-violation'),1000);
    }));
    expect(policy).toBe('connect-src');
  } finally { await browser.close();collector.close();site.close();await Promise.all([once(collector,'close'),once(site,'close')]); }
},30000);
