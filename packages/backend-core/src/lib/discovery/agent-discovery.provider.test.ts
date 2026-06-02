import { describe, expect, it } from "vitest";
import { FakeAgentDiscoveryProvider } from "./agent-discovery.provider.js";

describe("FakeAgentDiscoveryProvider", () => {
  const provider = new FakeAgentDiscoveryProvider();

  it("returns deterministic business-domain agents derived from the region", async () => {
    const a = await provider.discover({ region: "Conwy County", outcodes: ["LL30"] });
    const b = await provider.discover({ region: "Conwy County", outcodes: ["LL30"] });
    expect(a).toEqual(b); // deterministic
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((agent) => agent.email.includes("@"))).toBe(true);
    // Business-domain (not free webmail) so the guard classifies corporate.
    expect(a.every((agent) => !/@(gmail|outlook|yahoo|hotmail)\./.test(agent.email))).toBe(true);
    expect(a[0]!.agencyName).toContain("Conwy County");
  });

  it("varies the agent set by region", async () => {
    const conwy = await provider.discover({ region: "Conwy County", outcodes: [] });
    const gwynedd = await provider.discover({ region: "Gwynedd", outcodes: [] });
    expect(conwy[0]!.email).not.toBe(gwynedd[0]!.email);
  });
});
