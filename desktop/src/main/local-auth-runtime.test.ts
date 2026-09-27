import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoidrServiceClient } from './service-client';
const runtime = {
  serviceUrl: 'http://127.0.0.1:3000/v1', platformUrl: 'http://127.0.0.1:3030',
  collectorUrl: 'http://127.0.0.1:3100', collectorScriptUrl: 'http://127.0.0.1:8889/recorder.js',
  organizationId: 'org_test', localAdapter: false, localDevKey: 'unused-authenticated-mode',
};
afterEach(() => vi.unstubAllEnvs());
describe('authenticated headless HTTP policy', () => {
  it('loads the real client bundle when Electron is unavailable', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'voidr-node-client-'));
    try {
      const outfile = path.join(directory, 'client.cjs');
      buildSync({ entryPoints: [path.resolve('src/main/service-client.ts')], outfile,
        bundle: true, platform: 'node', format: 'cjs', external: ['electron'], tsconfig: 'tsconfig.json' });
      const output = execFileSync(process.execPath, ['-e', `
        const Module = require('module'), load = Module._load;
        Module._load = function(id, ...args) {
          if (id === 'electron') throw Error('Electron is not installed');
          return load.call(this, id, ...args);
        };
        const { VoidrServiceClient } = require(process.argv[1]);
        if (typeof VoidrServiceClient !== 'function') throw Error('Client missing');
        process.stdout.write('loaded');
      `, outfile], { encoding: 'utf8' });
      expect(output).toBe('loaded');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects HTTP in a production Node process', () => {
    vi.stubEnv('VOIDR_CAPTURE_RELEASE_CHANNEL', 'production');
    expect(() => new VoidrServiceClient(runtime)).toThrow('HTTP autenticado');
  });
  it('permits only the explicitly selected local environment', () => {
    vi.stubEnv('VOIDR_CAPTURE_RELEASE_CHANNEL', 'local');
    expect(() => new VoidrServiceClient(runtime)).not.toThrow();
    expect(() => new VoidrServiceClient({ ...runtime, serviceUrl: 'http://127.0.0.1:9999/v1' })).toThrow();
    expect(() => new VoidrServiceClient({ ...runtime, collectorUrl: 'http://example.com' })).toThrow();
    expect(() => new VoidrServiceClient({ ...runtime, platformUrl: 'http://127.0.0.1:3030/untrusted' })).toThrow();
  });
});
