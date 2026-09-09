import { describe, expect, it } from "vitest";
import {
  parseDesktopCaptureLaunch,
  parseDesktopProtocolLink,
  parseDesktopWorkspaceLink,
  parseLoopLaunch,
} from "./deep-link";

describe("desktop Loop bootstrap", () => {
  const reportedLink = "voidr://capture/loops/lts_1b8c167cfb2247d4863801953fc14d8a/cycles/12de63f9-4d32-4c25-a1a6-530e34e14839?organization=org_XpZs54aP8Oop8qUz&surface=web&deployment=production&v=1&attempt=3fbf4a47-5c5d-4a54-9371-9d68ba60f405";
  it("accepts the production invitation reported by the customer", () => {
    expect(parseDesktopCaptureLaunch(reportedLink)).toMatchObject({
      organizationId: "org_XpZs54aP8Oop8qUz", deployment: "production",
      loopId: "lts_1b8c167cfb2247d4863801953fc14d8a", cycleId: "12de63f9-4d32-4c25-a1a6-530e34e14839",
      attemptId: "3fbf4a47-5c5d-4a54-9371-9d68ba60f405",
    });
  });
  it("rejects malformed and duplicated attempt ids", () => {
    expect(() => parseDesktopCaptureLaunch(reportedLink + "&attempt=3fbf4a47-5c5d-4a54-9371-9d68ba60f405")).toThrow();
    expect(() => parseDesktopCaptureLaunch(reportedLink.replace("3fbf4a47-5c5d-4a54-9371-9d68ba60f405", "garbage"))).toThrow();
  });

  it("parses a secret-free workspace switch from the Web platform", () => {
    expect(
      parseDesktopWorkspaceLink(
        "voidr://workspace/connect?organization=org_XpZs54aP8Oop8qUz&deployment=staging&v=1",
      ),
    ).toEqual({
      version: "VOIDR-WORKSPACE-LINK/1",
      organizationId: "org_XpZs54aP8Oop8qUz",
      deployment: "staging",
    });
    expect(
      parseDesktopProtocolLink(
        "voidr://workspace/connect?organization=org_XpZs54aP8Oop8qUz&deployment=staging&v=1",
      ).kind,
    ).toBe("workspace");
  });

  it("rejects secrets and malformed workspace switches", () => {
    for (const value of [
      "voidr://workspace/connect?organization=org_itau&deployment=staging&v=1&token=secret",
      "voidr://workspace/connect?organization=itau&deployment=staging&v=1",
      "voidr://workspace/connect?organization=org_itau&deployment=preview&v=1",
      "voidr://workspace/connect?organization=org_itau&deployment=production&preview=branch&v=1",
      "voidr://workspace/connect?organization=org_itau&deployment=staging&v=1#secret",
    ]) {
      expect(() => parseDesktopWorkspaceLink(value)).toThrow();
    }
  });

  it("parses the secret-free operating-system handoff", () => {
    expect(
      parseDesktopCaptureLaunch(
        "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1&attempt=11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual({
      version: "VOIDR-CAPTURE-LAUNCH/1",
      organizationId: "org_itau",
      loopId: "lts_checkout",
      cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
      attemptId: "11111111-1111-4111-8111-111111111111",
      surface: "web",
      access: "organization",
      deployment: "local",
    });
  });

  it("binds a production launch to the trusted remote runtime without carrying endpoints", () => {
    const parsed = parseDesktopCaptureLaunch(
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&deployment=production&v=1",
    );
    expect(parsed.deployment).toBe("production");
    expect(JSON.stringify(parsed)).not.toMatch(/api\.voidr|collector|https?:/i);
  });

  it("preserves revalidation lineage in the secret-free handoff", () => {
    const parsed = parseDesktopCaptureLaunch(
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&deployment=staging&round=lr_2&assignment=lra_7&v=1",
    );
    expect(parsed.roundId).toBe("lr_2");
    expect(parsed.assignmentId).toBe("lra_7");
    expect(JSON.stringify(parsed)).not.toMatch(
      /token|authorization|api-staging/i,
    );
  });

  it("accepts a preview launch without carrying endpoints", () => {
    const parsed = parseDesktopCaptureLaunch(
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&deployment=preview&preview=release-capture&v=1",
    );
    expect(parsed.deployment).toBe("preview");
    expect(parsed.previewSlug).toBe("release-capture");
    expect(JSON.stringify(parsed)).not.toMatch(
      /api-preview|collector-staging|https?:/i,
    );
  });

  it("accepts capture attempts and revalidation together with all preview participant parameters", () => {
    const parsed = parseDesktopCaptureLaunch(
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1&deployment=preview&preview=release-capture&access=participant&attempt=11111111-1111-4111-8111-111111111111&round=lr_2&assignment=lra_7",
    );
    expect(parsed).toEqual({
      version: "VOIDR-CAPTURE-LAUNCH/1",
      organizationId: "org_itau",
      loopId: "lts_checkout",
      cycleId: "88ad0919-9754-4787-8a43-fc4bf79e52bd",
      surface: "web",
      deployment: "preview",
      previewSlug: "release-capture",
      access: "participant",
      attemptId: "11111111-1111-4111-8111-111111111111",
      roundId: "lr_2",
      assignmentId: "lra_7",
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /token|secret|authorization|https?:/i,
    );
  });

  it("rejects duplicate or invalid attempt and revalidation parameters", () => {
    const base =
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1";
    for (const query of [
      "&attempt=not-a-uuid&round=lr_2&assignment=lra_7",
      "&attempt=11111111-1111-4111-8111-111111111111&round=&assignment=lra_7",
      "&attempt=11111111-1111-4111-8111-111111111111&round=lr_2&assignment=",
      "&attempt=11111111-1111-4111-8111-111111111111&attempt=22222222-2222-4222-8222-222222222222",
      "&round=lr_2&round=lr_3&assignment=lra_7",
      "&round=lr_2&assignment=lra_7&assignment=lra_8",
      "&attempt=11111111-1111-4111-8111-111111111111&round=lr_2&assignment=lra_7&token=secret",
    ]) {
      expect(() => parseDesktopCaptureLaunch(base + query)).toThrow();
    }
  });

  it("accepts a staging launch without carrying endpoints", () => {
    const parsed = parseDesktopCaptureLaunch(
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&deployment=staging&v=1",
    );
    expect(parsed.deployment).toBe("staging");
    expect(JSON.stringify(parsed)).not.toMatch(
      /api-staging|collector-staging|https?:/i,
    );
  });

  it("marks an external participant launch without carrying an access token", () => {
    const parsed = parseDesktopCaptureLaunch(
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1&access=participant",
    );
    expect(parsed.access).toBe("participant");
    expect(JSON.stringify(parsed)).not.toMatch(
      /bearer|access_token|authorization/i,
    );
  });

  it("rejects extra parameters, fragments and unsupported surfaces", () => {
    for (const value of [
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1&token=secret",
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=voice&v=1",
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1#secret",
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?surface=web&v=1",
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1&access=admin",
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&deployment=preview&v=1",
      "voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&deployment=preview&preview=https%3A%2F%2Fevil.example&v=1",
    ]) {
      expect(() => parseDesktopCaptureLaunch(value)).toThrow();
    }
  });

  it("consumes a v1 capability without returning it in the target URL", () => {
    const token = "secret-capability-that-never-reaches-the-renderer";
    const envelope = Buffer.from(
      JSON.stringify({ token, originalHash: "#checkout" }),
    ).toString("base64url");
    const parsed = parseLoopLaunch(
      `http://localhost:8080/?voidr_record=1&voidr_mode=loop-test&voidr_bootstrap=v1&voidr_scenario_id=lts_1#voidr-loop-v1=${envelope}`,
    );
    expect(parsed.token).toBe(token);
    expect(parsed.safeUrl).toBe("http://localhost:8080/#checkout");
    expect(parsed.safeUrl).not.toContain("voidr_");
  });

  it("fails closed on a malformed secure fragment", () => {
    expect(() =>
      parseLoopLaunch(
        "http://localhost:8080/?voidr_mode=loop-test&voidr_bootstrap=v1&voidr_scenario_id=lts_1#voidr-loop-v1=bad%60",
      ),
    ).toThrow();
  });
});
