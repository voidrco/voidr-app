import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
const styleSource = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
const entrySource = readFileSync(fileURLToPath(new URL('./src.tsx', import.meta.url)), 'utf8');
const designSystemSource = readFileSync(
  fileURLToPath(new URL('../../../packages/capture-design-system/src/index.tsx', import.meta.url)),
  'utf8',
);
const designSystemStyles = readFileSync(
  fileURLToPath(new URL('../../../packages/capture-design-system/src/styles.css', import.meta.url)),
  'utf8',
);

describe('desktop experience contract', () => {
  it('keeps Voidr identity present in idle and agentic states', () => {
    expect(appSource).toContain('<VoidrBrand />');
    expect(appSource).toContain('<VoidrMark size={30} active />');
    expect(designSystemSource).toContain('<svg className="vdr-logo"');
    expect(designSystemSource).not.toContain('src="./logo-light.svg"');
  });

  it('uses the complete local Space Grotesk family without a network fallback', () => {
    for (const weight of [300, 400, 500, 600, 700]) {
      expect(designSystemStyles).toContain(`@fontsource/space-grotesk/latin-${weight}.css`);
    }
    expect(styleSource).toContain('font-synthesis: none');
    expect(styleSource).toContain('font-family: var(--font-sans)');
  });

  it('does not expose implementation jargon in the primary workflow', () => {
    for (const deprecatedCopy of [
      'Desktop alpha',
      'A capability é consumida',
      'Valida app, environment, readiness',
      '>Vincular Session<',
      '>Executar doctor<',
    ]) {
      expect(appSource).not.toContain(deprecatedCopy);
    }
  });

  it('uses design-system tokens instead of raw colors in renderer styles', () => {
    expect(styleSource).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styleSource).toContain('var(--background)');
    expect(styleSource).toContain('var(--text-primary)');
  });

  it('reserves a branded titlebar safe area for macOS traffic lights', () => {
    expect(entrySource).toContain("document.documentElement.dataset.platform");
    expect(styleSource).toMatch(/data-platform='darwin'.*\.vdr-brand/);
    expect(styleSource).toContain('margin-left: 96px');
  });

  it('never persists the local development credential in renderer storage', () => {
    expect(appSource).toContain('localDevKey: _ephemeralSecret');
    expect(appSource).toContain('JSON.stringify(persistableRuntime)');
    expect(appSource).not.toContain("JSON.stringify(runtime));");
  });

  it('claims harness receipt only after the authoritative acknowledgement', () => {
    expect(appSource).toContain("harnessDeliveryState === 'acknowledged'");
    expect(appSource).toContain('recebeu o contexto citado');
    expect(appSource).toContain('Aguardando o ${agentName} confirmar o contexto');
    expect(appSource).not.toContain('recebeu a confirmação e já pode continuar');
  });
});
