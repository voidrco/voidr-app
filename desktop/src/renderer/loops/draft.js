const deprecatedExamples = [
  {
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
  },
  {
    url: "https://automationexercise.com/products",
    steps: [
      'Busque pelo produto "Blue Top".',
      'Abra os detalhes do produto "Blue Top".',
      "Preencha a quantidade com 3.",
      "Adicione o produto ao carrinho.",
      "Abra o carrinho.",
      'Confirme que "Blue Top" aparece com quantidade 3.',
      'Remova o produto "Blue Top" do carrinho.',
      "Confirme que o carrinho está vazio.",
    ],
    expected: [],
  },
  {
    url: "https://example.com",
    steps: [
      'Confirme que o título "Example Domain" está visível.',
      'Abra o link "More information".',
      'Confirme que a página apresenta informações sobre domínios reservados.',
    ],
    expected: [],
  },
];

function normalizeLines(value) {
  return (Array.isArray(value) ? value.join("\n") : String(value ?? "")).trim();
}

function emptyProductUrl(example) {
  return { ...example, url: "" };
}

export function restoreDraft(storage, example) {
  const saved = storage.getItem("voidr-loops-draft");
  if (!saved) return emptyProductUrl(example);
  try {
    const draft = JSON.parse(saved);
    if (!draft || typeof draft !== "object") throw new Error("Invalid draft");
    const deprecated = deprecatedExamples.some((candidate) =>
      draft.url === candidate.url
      && normalizeLines(draft.steps) === normalizeLines(candidate.steps)
      && normalizeLines(draft.expected) === normalizeLines(candidate.expected));
    if (!deprecated) return draft;
    const migrated = { ...emptyProductUrl(example), headed: draft.headed === true };
    storage.setItem("voidr-loops-draft", JSON.stringify(migrated));
    return migrated;
  } catch {
    storage.removeItem("voidr-loops-draft");
    return example;
  }
}
