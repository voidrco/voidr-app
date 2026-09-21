import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { redactTrace } from '../src/runtime-secrets.ts';

const directory = await mkdtemp(join(tmpdir(), 'voidr-trace-privacy-'));
try {
  const file = join(directory, 'trace.zip');
  const network = url => JSON.stringify({ type: 'resource-snapshot', snapshot: { request: { url, postData: { _sha1: 'request' } }, response: { content: { _sha1: 'token' } } } });
  await writeFile(file, zipSync({
    'trace.network': strToU8(`${network('https://collector.test/init')}\n${JSON.stringify({ snapshot: { request: { url: 'https://product.test/search' } } })}\n`),
    'trace.trace': strToU8('collector-key login-password'),
    'resources/request': strToU8('collector-key'),
    'resources/token': strToU8('collector-jwt'),
    'resources/product': strToU8('login-password'),
  }));
  await redactTrace(file, { COLLECTOR_KEY: 'collector-key', LOGIN_PASSWORD: 'login-password' }, ['https://collector.test']);
  const entries = unzipSync(await readFile(file));
  assert.equal(entries['resources/token'], undefined);
  assert.equal(entries['resources/request'], undefined);
  assert.ok(strFromU8(entries['trace.network']).includes('product.test/search'));
  assert.ok(!strFromU8(entries['trace.network']).includes('collector.test'));
  assert.equal(strFromU8(entries['resources/product']), '{{env.LOGIN_PASSWORD}}');
  assert.equal(strFromU8(entries['trace.trace']), '{{env.COLLECTOR_KEY}} {{env.LOGIN_PASSWORD}}');
  console.log('OK: trace preserva requisições do produto e remove credenciais e transporte do Collector.');
} finally { await rm(directory, { recursive: true, force: true }); }
