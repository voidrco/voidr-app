import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
const mainSource = readFileSync(
  fileURLToPath(new URL('../main/index.ts', import.meta.url)),
  'utf8',
);
const workspaceSource = readFileSync(
  fileURLToPath(new URL('./WorkspaceHome.tsx', import.meta.url)),
  'utf8',
);
const styleSource = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
const entrySource = readFileSync(fileURLToPath(new URL('./src.tsx', import.meta.url)), 'utf8');
const htmlSource = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
const designSystemSource = readFileSync(
  fileURLToPath(new URL('../../../packages/capture-design-system/src/index.tsx', import.meta.url)),
  'utf8',
);
const designSystemStyles = readFileSync(
  fileURLToPath(new URL('../../../packages/capture-design-system/src/styles.css', import.meta.url)),
  'utf8',
);
const presentationSource = readFileSync(
  fileURLToPath(new URL('../../../packages/capture-presentation/src/index.ts', import.meta.url)),
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

  it('makes Loops the operational Home with real cycles, participants and evidence', () => {
    expect(appSource).toContain("useState<'loops' | 'capture'>('loops')");
    expect(appSource).toContain('<WorkspaceHome');
    expect(workspaceSource).toContain('workspace.listLoops(runtime)');
    expect(workspaceSource).toMatch(/workspace\s*\.listCycles\(runtime, selectedLoopId\)/);
    expect(workspaceSource).toMatch(
      /workspace\s*\.getCycle\(runtime, selectedLoopId, selectedCycleId\)/,
    );
    expect(workspaceSource).toContain('Iniciar meu ciclo');
    expect(workspaceSource).toContain("useState<EvidenceFilter>('highlights')");
    expect(workspaceSource).toContain('Destaques');
    expect(workspaceSource).not.toContain('VAP');
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

  it('keeps the workspace scoped to the organization carried by a local launch', () => {
    expect(appSource).toContain('organizationId: launch.organizationId');
    expect(appSource).toContain('capture.acceptLaunch(launch, launchRuntime)');
    expect(appSource).toContain('setRuntime(launchRuntime)');
  });

  it('starts a Web Cycle immediately and identifies its human owner during capture', () => {
    expect(mainSource).toContain("if (status.stage === 'ready') status = await webCapture!.start()");
    expect(appSource).toContain('cycleParticipantLabel(cycleParticipant, cycleStartedAt)');
    expect(appSource).toContain('A captura começou automaticamente e o tempo já está contando.');
    expect(appSource).toContain('Ciclo de ${participantLabel}');
    expect(appSource).toContain('referrerPolicy="no-referrer"');
    expect(htmlSource).toContain("img-src 'self' data: https:");
  });

  it('claims harness receipt only after the authoritative acknowledgement', () => {
    expect(appSource).toContain("harnessDeliveryState === 'acknowledged'");
    expect(appSource).toContain('recebeu o contexto citado');
    expect(appSource).toContain('Aguardando o ${agentName} confirmar o contexto');
    expect(appSource).not.toContain('recebeu a confirmação e já pode continuar');
  });

  it('reserves native target space for notes and captured-context details', () => {
    expect(appSource).toContain('capture.setControlPanel(controlPanelMode)');
    expect(appSource).toContain('capture-shell-note');
    expect(appSource).toContain('capture-shell-evidence');
    expect(appSource).toContain('<EvidenceInspector');
    expect(styleSource).toContain('.capture-shell-note');
    expect(styleSource).toContain('.capture-shell-evidence');
    expect(styleSource).toContain('.dock-evidence');
  });

  it('matches the extension contract: select, explain, then explicitly save', () => {
    expect(appSource).toContain("onClick={() => void beginAnnotation('element')}");
    expect(appSource).toContain("onClick={() => void beginAnnotation('screen')}");
    expect(appSource).toContain('capture.selectElement()');
    expect(appSource).toContain('O que deve ser investigado?');
    expect(appSource).toContain('Inclua esperado × observado quando ajudar · Enter salva');
    expect(appSource).toContain('Salvar anotação');
    expect(appSource).toContain('disabled={busy || !note.trim()}');
    expect(appSource).toContain('capture.clearElementSelection()');
    expect(appSource).not.toContain('fallbackNote');
    expect(appSource).not.toContain('Elemento salvo');
    expect(appSource).not.toContain('Nenhuma nota era obrigatória');
    expect(styleSource).toContain('.dock-note-composer textarea');
  });

  it('makes every automatic evidence category inspectable from the recording dock', () => {
    expect(appSource).toContain("label: 'Requisições'");
    expect(appSource).toContain('title={`Ver ${label.toLowerCase()}`}');
    expect(appSource).toContain("signal.category === evidenceOpen");
    expect(appSource).toContain('método, status e duração');
  });

  it('presents four honest, status-driven finalization stages with delayed-state copy', () => {
    for (const label of [
      'Consolidando jornada',
      'Preservando captura',
      'Indexando evidências',
      'Preparando revisão',
    ]) {
      expect(presentationSource).toContain(label);
    }
    expect(appSource).toContain("stage === 'stopping' ? 0");
    expect(appSource).toContain('elapsedMs >= 15_000');
    expect(appSource).toContain('Captura segura.');
    expect(styleSource).toContain('.finalization-step.active');
  });
});
