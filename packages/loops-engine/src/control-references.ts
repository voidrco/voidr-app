const REFERENCE = /\((?:seletor(?: de refer[eê]ncia| auxiliar)?|refer[eê]ncia(?: t[eé]cnica| auxiliar)?|selector(?: hint| reference)?)\s*:\s*([^\n]+?)\)(?=\s*(?:[.;,]|$|e\s))/gi;

export function selectorReferences(instruction: string) {
  return [...new Set([...instruction.matchAll(REFERENCE)]
    .map(match => match[1]!.trim().replace(/^[`"']|[`"']$/g, "")))]
    .filter(value => value.length > 0 && value.length <= 500).slice(0, 5);
}

export function withoutSelectorReferences(instruction: string) {
  return instruction.replace(REFERENCE, "");
}
