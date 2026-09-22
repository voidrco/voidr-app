import { describe, expect, it, vi } from "vitest";
import { restoreDraft } from "./draft.js";

const currentExample = {
  url: "https://example.com",
  steps: ["Confirme que o título está visível."],
  expected: [],
};

function storageWith(value) {
  return {
    getItem: vi.fn(() => JSON.stringify(value)),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
}

describe("restoreDraft", () => {
  it("replaces the previous Automation Exercise default", () => {
    const storage = storageWith({
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
      headed: true,
    });

    expect(restoreDraft(storage, currentExample)).toEqual({ ...currentExample, headed: true });
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it("preserves a journey created by the user", () => {
    const custom = { url: "https://produto.exemplo", steps: ["Faça login."], expected: [] };
    const storage = storageWith(custom);

    expect(restoreDraft(storage, currentExample)).toEqual(custom);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
