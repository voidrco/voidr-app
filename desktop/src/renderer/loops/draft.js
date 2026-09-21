const legacyExample = {
  url: "https://assets.voidr.co/customers/itau-credito-rural-mock",
  steps: [
    "Busque o produtor Fazenda Santa Helena.",
    "Consulte os limites e o rating do produtor.",
    "Abra a simulação de crédito.",
    "Preencha o valor solicitado com 200000.",
    "Selecione o prazo de 24 meses e a finalidade Custeio agrícola, mantendo o desconto em zero.",
    "Simule o crédito.",
    "Abra a revisão da proposta.",
    "Envie a proposta. Pare antes do desembolso.",
    "Confirme que a proposta foi enviada com sucesso e que existe um protocolo.",
  ],
  expected: ["Proposta enviada com sucesso", "Protocolo CR-"],
};

function normalizeLines(value) {
  return (Array.isArray(value) ? value.join("\n") : String(value ?? "")).trim();
}

export function restoreDraft(storage, example) {
  const saved = storage.getItem("voidr-loops-draft");
  if (!saved) return example;
  try {
    const draft = JSON.parse(saved);
    if (!draft || typeof draft !== "object") throw new Error("Invalid draft");
    const legacy = draft.url === legacyExample.url
      && normalizeLines(draft.steps) === normalizeLines(legacyExample.steps)
      && normalizeLines(draft.expected) === normalizeLines(legacyExample.expected);
    if (!legacy) return draft;
    const migrated = { ...example, headed: draft.headed === true };
    storage.setItem("voidr-loops-draft", JSON.stringify(migrated));
    return migrated;
  } catch {
    storage.removeItem("voidr-loops-draft");
    return example;
  }
}
