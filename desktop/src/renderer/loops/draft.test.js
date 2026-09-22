import { describe, expect, it, vi } from "vitest";
import { restoreDraft } from "./draft.js";

const currentExample = {
  url: "https://seu-produto.com",
  steps: [
    "Acesse a tela de login.",
    "Entre com um usuário de teste.",
    "Abra a página de pedidos.",
    "Confirme que a lista de pedidos está visível.",
  ],
  expected: [],
};

const emptyProductUrlExample = { ...currentExample, url: "" };

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

    expect(restoreDraft(storage, currentExample)).toEqual({ ...emptyProductUrlExample, headed: true });
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it("replaces the previous Example Domain default", () => {
    const storage = storageWith({
      url: "https://example.com",
      steps: [
        'Confirme que o título "Example Domain" está visível.',
        'Abra o link "More information".',
        'Confirme que a página apresenta informações sobre domínios reservados.',
      ],
      expected: [],
    });

    expect(restoreDraft(storage, currentExample)).toEqual({ ...emptyProductUrlExample, headed: false });
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it("starts with an empty product URL and keeps the example steps", () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(restoreDraft(storage, currentExample)).toEqual(emptyProductUrlExample);
  });

  it("preserves a journey created by the user", () => {
    const custom = { url: "https://produto.exemplo", steps: ["Faça login."], expected: [] };
    const storage = storageWith(custom);

    expect(restoreDraft(storage, currentExample)).toEqual(custom);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
