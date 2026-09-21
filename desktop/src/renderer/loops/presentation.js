const outcomes = {
  unverified: "Não há evidência confiável para concluir esta verificação.",
  completed: "Todos os passos da jornada foram concluídos.",
  cancelled: "A jornada foi interrompida.",
  blocked: "O produto impediu a continuação deste passo. Confira os dados informados.",
  assertion_failed: "Não foi possível confirmar o resultado esperado neste passo. Consulte a evidência.",
  uncertain: "Não foi possível determinar como continuar este passo. Consulte as evidências.",
  stalled: "O passo não avançou após novas tentativas. Consulte as evidências.",
  step_limit: "A jornada atingiu o limite de tentativas antes de concluir todos os passos.",
};

export const outcomeMessage = status => outcomes[status] ?? "Não foi possível concluir a jornada. Consulte as evidências e tente novamente.";

export function activityMessage(event) {
  if (event.type === "recovery") return "Reavaliando a página para continuar este passo.";
  if (event.type === "assertion") {
    const label = event.assertion.status === "passed" ? "Verificação confirmada" : event.assertion.status === "unverified" ? "Não foi possível verificar" : "Divergência encontrada";
    return `${label}: ${event.assertion.instruction}`;
  }
  return event.executed === false ? "A interação não foi concluída. Reavaliando a página." : event.message;
}
