import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  fileURLToPath(new URL("./App.tsx", import.meta.url)),
  "utf8",
);
const mainSource = readFileSync(
  fileURLToPath(new URL("../main/index.ts", import.meta.url)),
  "utf8",
);
const workspaceSource = readFileSync(
  fileURLToPath(new URL("./WorkspaceHome.tsx", import.meta.url)),
  "utf8",
);
const styleSource = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
  "utf8",
);
const entrySource = readFileSync(
  fileURLToPath(new URL("./src.tsx", import.meta.url)),
  "utf8",
);
const htmlSource = readFileSync(
  fileURLToPath(new URL("./index.html", import.meta.url)),
  "utf8",
);
const designSystemSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/capture-design-system/src/index.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);
const designSystemStyles = readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/capture-design-system/src/styles.css",
      import.meta.url,
    ),
  ),
  "utf8",
);
const presentationSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/capture-presentation/src/index.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);
const annotationFlowSource = readFileSync(
  fileURLToPath(new URL("./annotation-flow.ts", import.meta.url)),
  "utf8",
);
const annotationContract = readFileSync(
  fileURLToPath(new URL("../../ANNOTATION-FLOW.md", import.meta.url)),
  "utf8",
);
const voiceFlowSource = readFileSync(
  fileURLToPath(new URL("./voice-flow.ts", import.meta.url)),
  "utf8",
);
const voiceContract = readFileSync(
  fileURLToPath(new URL("../../VOICE-FLOW.md", import.meta.url)),
  "utf8",
);

describe("desktop experience contract", () => {
  it("keeps Voidr identity present in idle and agentic states", () => {
    expect(appSource).toContain("<VoidrBrand />");
    expect(appSource).toContain("<VoidrMark size={30} active />");
    expect(designSystemSource).toContain('<svg className="vdr-logo"');
    expect(designSystemSource).not.toContain('src="./logo-light.svg"');
  });

  it("uses the complete local Space Grotesk family without a network fallback", () => {
    for (const weight of [300, 400, 500, 600, 700]) {
      expect(designSystemStyles).toContain(
        `@fontsource/space-grotesk/latin-${weight}.css`,
      );
    }
    expect(styleSource).toContain("font-synthesis: none");
    expect(styleSource).toContain("font-family: var(--font-sans)");
  });

  it("does not expose implementation jargon in the primary workflow", () => {
    for (const deprecatedCopy of [
      "Desktop alpha",
      "A capability é consumida",
      "Valida app, environment, readiness",
      ">Vincular Session<",
      ">Executar doctor<",
    ]) {
      expect(appSource).not.toContain(deprecatedCopy);
    }
  });

  it("makes Loops the operational Home with real tests, participants and evidence", () => {
    expect(appSource).toContain("useState<'loops' | 'capture'>('loops')");
    expect(appSource).toContain("<WorkspaceHome");
    expect(workspaceSource).toContain("workspace.listLoops(runtime)");
    expect(workspaceSource).toMatch(
      /workspace\s*\.listCycles\(runtime, selectedLoopId\)/,
    );
    expect(workspaceSource).toMatch(
      /workspace\s*\.getCycle\(\s*runtime,\s*selectedLoopId,\s*selectedCycleId,?\s*\)/,
    );
    expect(workspaceSource).toContain("Fazer meu teste");
    expect(workspaceSource).toContain("<LoopParticipantStack");
    expect(workspaceSource).toContain("loop.testCount");
    expect(workspaceSource).toContain("Feedback e evidências");
    expect(workspaceSource).toContain("feedbackEvidence");
    expect(workspaceSource).toContain("technicalEvidence");
    expect(workspaceSource).toContain("workspace-technical-signals");
    expect(workspaceSource).not.toContain("Destaques");
    expect(workspaceSource).not.toContain("VAP");
  });

  it("uses design-system tokens instead of raw colors in renderer styles", () => {
    expect(styleSource).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styleSource).toContain("var(--background)");
    expect(styleSource).toContain("var(--text-primary)");
  });

  it("reserves a branded titlebar safe area for macOS traffic lights", () => {
    expect(entrySource).toContain("document.documentElement.dataset.platform");
    expect(styleSource).toMatch(/data-platform='darwin'.*\.vdr-brand/);
    expect(styleSource).toContain("margin-left: 96px");
  });

  it("never persists the local development credential in renderer storage", () => {
    expect(appSource).toContain("serializeWorkspaceBinding(runtime)");
    expect(appSource).not.toContain("JSON.stringify(runtime)");
    expect(appSource).not.toContain("JSON.stringify(runtime));");
  });

  it("keeps the workspace scoped to the deployment and organization carried by a launch", () => {
    expect(appSource).toContain("runtimeForDeployment(");
    expect(appSource).toContain("launch.organizationId");
    expect(appSource).toContain("capture.acceptLaunch(launch, launchRuntime)");
    expect(appSource).toContain('Este convite não está mais disponível.');
    expect(appSource).toContain("setRuntime(launchRuntime)");
  });

  it("starts a Web test immediately and identifies its human owner during capture", () => {
    expect(mainSource).toContain(
      "if (status.stage === 'ready') status = await webCapture!.start()",
    );
    expect(appSource).toContain(
      "cycleParticipantLabel(cycleParticipant, cycleStartedAt)",
    );
    expect(appSource).toContain(
      "A captura começou automaticamente e o tempo já está contando.",
    );
    expect(appSource).toContain("Conclua o teste atual primeiro");
    expect(appSource).toContain("Este teste já está aberto");
    expect(appSource).toContain("statusHydrated");
    expect(appSource).toContain("if (acceptingLaunch.current)");
    expect(appSource).toContain("Teste de ${participantLabel}");
    expect(appSource).toContain('referrerPolicy="no-referrer"');
    expect(htmlSource).toContain("img-src 'self' data: https:");
  });

  it("claims harness receipt only after the authoritative acknowledgement", () => {
    expect(appSource).toContain("harnessDeliveryState === 'acknowledged'");
    expect(appSource).toContain("recebeu o contexto citado");
    expect(appSource).toContain(
      "Aguardando o ${agentName} confirmar o contexto",
    );
    expect(appSource).not.toContain(
      "recebeu a confirmação e já pode continuar",
    );
  });

  it("reserves native target space for notes and captured-context details", () => {
    expect(appSource).toContain("capture.setControlPanel(controlPanelMode)");
    expect(appSource).toContain("capture-shell-note");
    expect(appSource).toContain("capture-shell-evidence");
    expect(appSource).toContain("<EvidenceInspector");
    expect(styleSource).toContain(".capture-shell-note");
    expect(styleSource).toContain(".capture-shell-evidence");
    expect(styleSource).toContain(".dock-evidence");
    expect(appSource).toContain("capture-shell-voice");
    expect(styleSource).toContain(".dock-voice");
  });

  it("makes voice a visible record, review and confirm flow", () => {
    for (const phase of [
      "requesting",
      "recording",
      "stopping",
      "reviewing",
      "sending",
      "error",
      "success",
    ]) {
      expect(voiceFlowSource).toContain(`phase: '${phase}'`);
    }
    expect(appSource).toContain("Nível do microfone");
    expect(appSource).toContain("<code>{elapsed(elapsedMs)} / 02:00</code>");
    expect(appSource).toContain("Ouça antes de adicionar");
    expect(appSource).toContain("Só será enviada quando você confirmar.");
    expect(appSource).toContain("Gravar novamente");
    expect(appSource).toContain("Tentar novamente");
    expect(appSource).toContain("stopVoiceRef.current('escape')");
    expect(appSource).toContain("protectVoicePending");
    expect(appSource).toContain("Área da tela (opcional)");
    expect(appSource).toContain("Selecionar área");
    expect(appSource).toContain("Área selecionada");
    expect(appSource).toContain("Não identificamos fala nessa gravação");
    expect(appSource).toContain("capture.selectVoiceRegion(attempt)");
    expect(appSource).toContain("capture.clearVoiceRegion()");
    expect(appSource).toContain("voiceVisualMatchesSelection");
    expect(appSource).toContain("visualLocked");
    expect(voiceContract).toContain("Apenas **Descartar** destrói");
    expect(voiceContract).toContain("cancela apenas a seleção");
    expect(voiceContract).toContain("Retry não duplica");
  });

  it("matches the extension contract for element, region and screen notes", () => {
    expect(appSource).toContain(
      "onClick={() => void beginAnnotation('element')}",
    );
    expect(appSource).toContain(
      "onClick={() => void beginAnnotation('region')}",
    );
    expect(appSource).toContain(
      "onClick={() => void beginAnnotation('screen')}",
    );
    expect(appSource).toContain("capture.selectElement()");
    expect(appSource).toContain("capture.selectRegion()");
    expect(appSource).toContain("O que deve ser investigado?");
    expect(appSource).toContain(
      "Inclua esperado × observado quando ajudar · Enter salva",
    );
    expect(appSource).toContain("Salvar anotação");
    expect(appSource).toContain("disabled={busy || !note.trim()}");
    expect(appSource).toContain("capture.clearSelection()");
    expect(appSource).toContain("Cancelar seleção");
    expect(appSource).toContain("capture.onSelectionCancelled");
    expect(appSource).not.toContain("fallbackNote");
    expect(appSource).not.toContain("Elemento salvo");
    expect(appSource).not.toContain("Nenhuma nota era obrigatória");
    expect(styleSource).toContain(".dock-note-composer textarea");
  });

  it("models cancellation, return, draft recovery and single-flight saves explicitly", () => {
    for (const phase of [
      "closed",
      "choosing",
      "selecting",
      "composing",
      "saving",
    ]) {
      expect(annotationFlowSource).toContain(`phase: '${phase}'`);
    }
    expect(appSource).toContain("annotationSaveInFlight.current");
    expect(appSource).toContain(
      "annotationFlowRef.current.phase === 'choosing' ? 'closed' : 'choosing'",
    );
    expect(appSource).toContain("capture.onTargetPointerDown");
    expect(appSource).toContain("Você tem uma nota não salva");
    expect(appSource).toContain("Voltar para os tipos de nota");
    expect(appSource).toContain("Seu texto foi preservado.");
    expect(annotationContract).toContain(
      "Pressionar `Esc` na seleção de elemento",
    );
    expect(annotationContract).toContain("Duplo clique/`Enter` repetido");
  });

  it("makes every automatic evidence category inspectable from the recording dock", () => {
    expect(appSource).toContain("label: 'Requisições'");
    expect(appSource).toContain("title={`Ver ${label.toLowerCase()}`}");
    expect(appSource).toContain("signal.category === evidenceOpen");
    expect(appSource).toContain("método, status e duração");
  });

  it("presents four honest, status-driven finalization stages with delayed-state copy", () => {
    for (const label of [
      "Consolidando jornada",
      "Preservando captura",
      "Indexando evidências",
      "Preparando revisão",
    ]) {
      expect(presentationSource).toContain(label);
    }
    expect(appSource).toContain("stage === 'stopping' ? 0");
    expect(appSource).toContain("elapsedMs >= 15_000");
    expect(appSource).toContain("Captura segura.");
    expect(styleSource).toContain(".finalization-step.active");
  });
});
