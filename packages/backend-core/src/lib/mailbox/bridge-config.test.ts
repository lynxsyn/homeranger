import { describe, expect, it } from "vitest";
import { buildBridgeImapConfig, senderAddress } from "./bridge-config.js";

const VALID = {
  PROTON_BRIDGE_USERNAME: "lynx@proton.me",
  PROTON_BRIDGE_PASSWORD: "bridge-token-abc",
  PROTON_BRIDGE_PORT: "1143",
};

describe("buildBridgeImapConfig", () => {
  it("lists every missing Bridge variable in the error", () => {
    expect(() => buildBridgeImapConfig({})).toThrow(
      /PROTON_BRIDGE_USERNAME.*PROTON_BRIDGE_PASSWORD.*PROTON_BRIDGE_PORT/,
    );
    expect(() =>
      buildBridgeImapConfig({ PROTON_BRIDGE_USERNAME: "u", PROTON_BRIDGE_PORT: "1143" }),
    ).toThrow(/PROTON_BRIDGE_PASSWORD/);
  });

  it("builds a loopback STARTTLS config that trusts the self-signed cert", () => {
    expect(buildBridgeImapConfig(VALID)).toEqual({
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      auth: { user: "lynx@proton.me", pass: "bridge-token-abc" },
      tls: { rejectUnauthorized: false },
    });
  });

  it("honours a PROTON_BRIDGE_HOST override and trims the username", () => {
    const cfg = buildBridgeImapConfig({
      ...VALID,
      PROTON_BRIDGE_USERNAME: "  lynx@proton.me  ",
      PROTON_BRIDGE_HOST: "127.0.0.2",
    });
    expect(cfg.host).toBe("127.0.0.2");
    expect(cfg.auth.user).toBe("lynx@proton.me");
  });

  it("refuses a non-loopback host (trust-all cert is loopback-only)", () => {
    expect(() =>
      buildBridgeImapConfig({ ...VALID, PROTON_BRIDGE_HOST: "192.168.1.50" }),
    ).toThrow(/loopback/);
    expect(() =>
      buildBridgeImapConfig({ ...VALID, PROTON_BRIDGE_HOST: "mail.example.com" }),
    ).toThrow(/loopback/);
  });

  it("does not trim the password (Bridge tokens are opaque)", () => {
    const cfg = buildBridgeImapConfig({ ...VALID, PROTON_BRIDGE_PASSWORD: " tok en " });
    expect(cfg.auth.pass).toBe(" tok en ");
  });

  it("rejects a non-numeric or out-of-range port", () => {
    expect(() => buildBridgeImapConfig({ ...VALID, PROTON_BRIDGE_PORT: "nope" })).toThrow(
      /valid TCP port/,
    );
    expect(() => buildBridgeImapConfig({ ...VALID, PROTON_BRIDGE_PORT: "0" })).toThrow(
      /valid TCP port/,
    );
    expect(() =>
      buildBridgeImapConfig({ ...VALID, PROTON_BRIDGE_PORT: "70000" }),
    ).toThrow(/valid TCP port/);
  });
});

describe("senderAddress", () => {
  it("extracts the bare address from a display-name From", () => {
    expect(senderAddress("HomeRanger <noreply@homeranger.app>")).toBe(
      "noreply@homeranger.app",
    );
    expect(senderAddress("noreply@homeranger.app")).toBe("noreply@homeranger.app");
    expect(senderAddress("  NoReply@HomeRanger.app  ")).toBe(
      "noreply@homeranger.app",
    );
  });

  it("returns null when there is no address", () => {
    expect(senderAddress("")).toBeNull();
    expect(senderAddress(null)).toBeNull();
    expect(senderAddress("HomeRanger")).toBeNull();
  });
});
