import { z } from "zod";
import { isTrustedWebUrl } from "@voidr/capture-contracts";

export const loopCodeHandoffInputSchema = z.object({
  platformUrl: z.string().url(),
  loopId: z.string().trim().min(1).max(200),
  cycleId: z.string().uuid(),
  destination: z.enum(["cycle", "consolidated"]).optional(),
  agent: z.enum(["codex", "cursor", "claude_code"]).optional(),
});

export type LoopCodeHandoffInput = z.infer<typeof loopCodeHandoffInputSchema>;

export function buildLoopCodeHandoffUrl(input: LoopCodeHandoffInput): string {
  const parsed = loopCodeHandoffInputSchema.parse(input);
  const base = new URL(parsed.platformUrl);
  if (!isTrustedWebUrl(base.toString()) || base.username || base.password) {
    throw new Error("Platform URL inválida.");
  }
  const destination =
    parsed.destination === "consolidated"
      ? new URL(
          `/loops/${encodeURIComponent(parsed.loopId)}/consolidated`,
          base,
        )
      : new URL(
          `/loops/${encodeURIComponent(parsed.loopId)}/cycles/${encodeURIComponent(parsed.cycleId)}`,
          base,
        );
  if (parsed.destination === "consolidated") {
    destination.searchParams.set("handoff", "1");
    destination.searchParams.set("cycle", parsed.cycleId);
    destination.searchParams.set("agent", parsed.agent ?? "codex");
  }
  return destination.toString();
}
