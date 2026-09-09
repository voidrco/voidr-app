import { describe, expect, it } from "vitest";
import { isVoidrTeamEmail } from "./diagnostic-access";

describe("diagnostic access", () => {
  it("allows authenticated Voidr team addresses", () => {
    expect(isVoidrTeamEmail("qa@voidr.co")).toBe(true);
    expect(isVoidrTeamEmail("  ERIK@VOIDR.CO ")).toBe(true);
  });

  it("keeps customer and lookalike domains out", () => {
    expect(isVoidrTeamEmail("qa@customer.com")).toBe(false);
    expect(isVoidrTeamEmail("qa@voidr.co.example.com")).toBe(false);
    expect(isVoidrTeamEmail(undefined)).toBe(false);
  });
});
