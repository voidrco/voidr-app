import { describe, expect, it } from "vitest";
import { buildLoopCodeHandoffUrl } from "./code-handoff";

const cycleId = "11111111-1111-4111-8111-111111111111";

describe("buildLoopCodeHandoffUrl", () => {
  it("creates a consolidation handoff with identifiers only", () => {
    const value = buildLoopCodeHandoffUrl({
      platformUrl: "https://app.voidr.co",
      loopId: "lts_checkout",
      cycleId,
      destination: "consolidated",
      agent: "cursor",
    });
    expect(value).toBe(
      `https://app.voidr.co/loops/lts_checkout/consolidated?handoff=1&cycle=${cycleId}&agent=cursor`,
    );
    expect(value).not.toMatch(/token|secret|authorization/i);
  });

  it("rejects credentials embedded in the platform URL", () => {
    expect(() =>
      buildLoopCodeHandoffUrl({
        platformUrl: "https://token:secret@app.voidr.co",
        loopId: "lts_checkout",
        cycleId,
        destination: "consolidated",
      }),
    ).toThrow("Platform URL inválida");
  });
});
