import { describe, it, expect } from "vitest";
import { checkAirGap, describeAirGap, activeInterfaces } from "./airgap.js";

describe("air-gap check", () => {
  it("reports the machine's real interfaces without throwing", () => {
    const c = checkAirGap();
    expect(typeof c.airGapped).toBe("boolean");
    expect(Array.isArray(c.interfaces)).toBe(true);
    expect(c.airGapped).toBe(c.interfaces.length === 0);
  });

  it("never claims isolation is proven", () => {
    const c = checkAirGap();
    expect(c.caveat).toMatch(/not proof of isolation/);
    expect(describeAirGap({ airGapped: true, interfaces: [], caveat: c.caveat })).toMatch(/not proof of isolation/);
  });

  it("names the interfaces when a network path exists", () => {
    const s = describeAirGap({
      airGapped: false,
      interfaces: [{ name: "en0", address: "192.168.1.20", family: "IPv4" }],
      caveat: "x",
    });
    expect(s).toMatch(/LIVE NETWORK PATH/);
    expect(s).toContain("en0 192.168.1.20");
  });

  it("summarises rather than dumping: routable addresses first, the rest counted", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `utun${i}`, address: `fe80::${i}`, family: "IPv6" }));
    const s = describeAirGap({
      airGapped: false,
      interfaces: [...many, { name: "en0", address: "10.0.0.42", family: "IPv4" }],
      caveat: "x",
    });
    expect(s).toContain("en0 10.0.0.42");   // the one that matters is named
    expect(s).toMatch(/and 20 more/);        // the link-local noise is counted
    expect(s.length).toBeLessThan(200);
  });

  it("ignores loopback: an isolated machine still has one", () => {
    // activeInterfaces filters internal addresses, so 127.0.0.1 never appears.
    expect(activeInterfaces().some((i) => i.address === "127.0.0.1" || i.address === "::1")).toBe(false);
  });
});
