import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { validateConfig, runEngine } from '@voidr/loops-engine';
import { executionValues } from '../../../packages/loops-engine/src/values';
import { createDecider } from '../../../packages/loops-engine/src/decide';
import { journeyConfigSchema } from '../shared/journeys';
const browserAvailable = await chromium.launch().then(async browser => { await browser.close(); return true; }).catch(() => false);
const data = ['Document initial: 123456', 'Document updated: 654321'];
const config = { url: 'http://127.0.0.1/', data,
  steps: ['Fill Document with the updated value from the test data.', 'Confirm Document contains 654321.'],
  stepKinds: ['action', 'assertion'] as const, expected: [], headed: false, maxActions: 5 };
const choice = (value: string) => ({ type: 'choice', choice: value, confidence: 1, probabilities: { [value]: 1 } });
describe('authored data reaches the browser executor', () => {
  it('preserves bounded data across both configuration contracts without adding it to assertion terms', () => {
    const validated = validateConfig(config);
    expect(journeyConfigSchema.parse(validated).data).toEqual(data);
    expect(executionValues(config.steps[0]!, data)).toContain('654321');
    expect(executionValues(config.steps[0]!)).not.toContain('654321');
    expect(() => validateConfig({ ...config, data: Array(31).fill('value') })).toThrow();
    expect(() => validateConfig({ ...config, data: [42] })).toThrow();
  });
  it.skipIf(!browserAvailable)('fills a referenced data value in Chromium and verifies it through the DOM', async () => {
    const server = createServer((_req, res) => { res.setHeader('content-type','text/html'); res.end('<label>Document<input value="123456"></label>'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = await mkdtemp(path.join(tmpdir(), 'voidr-test-data-'));
    let contextSeen = false;
    const client = { systemOne: async (request: any) => {
      expect(request.state.testData).toEqual(data); contextSeen = true;
      const field = request.state.page.controls.find((control: any) => control.name.trim() === 'Document');
      const done = field?.value === '654321';
      const action = Object.entries(request.questions.next.criteria).find(([, value]) => String(value).startsWith('fill ') && String(value).includes('"654321"'))?.[0] ?? 'unsure';
      const region = Object.entries(request.questions.evidence.criteria).filter(([id, value]) => id !== 'none' && String(value).includes('654321')).sort((a,b) => String(a[1]).length - String(b[1]).length)[0]?.[0] ?? 'none';
      return { answers: { needsHuman: { type:'noul', noul:0 }, assertionPredicate:choice('contains'),
        intent:choice(request.state.fixedStepKind), rejection:choice('none'), evidence:choice(region),
        status:choice(done?'done':'pending'), satisfied:{type:'noul',noul:done?1:0}, next:choice(action) },
        usage:{input_tokens:0,output_tokens:0},model:'deterministic-data-contract-test' };
    } };
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}/`;
      const result = await runEngine({ config: validateConfig({ ...config, url }), outputRoot:root,
        decide:createDecider(client as any) });
      expect(contextSeen).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.actions).toBe(1);
      expect(result.assertions[0]?.actual?.values[0]?.value).toBe('654321');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root,{recursive:true,force:true}); }
  }, 30_000);
});
