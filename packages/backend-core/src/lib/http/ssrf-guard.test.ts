/**
 * Unit tests for the SSRF private-IP guard used by the in-process discovery
 * fetcher. Security-critical: the provider resolves each fetch target (and every
 * redirect hop) to an IP and refuses to fetch when isPrivateIp() is true, so a
 * Serper result that points at (or 30x-redirects to) an internal/link-local
 * address can't be used to reach the cluster network or a cloud metadata IMDS.
 */
import { describe, expect, it } from "vitest";
import { isPrivateIp } from "./ssrf-guard.js";

describe("isPrivateIp", () => {
  it("blocks IPv4 private / loopback / link-local ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "10.255.255.255",
      "127.0.0.1",
      "169.254.169.254", // cloud IMDS / link-local
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("blocks IPv6 loopback / link-local / ULA + IPv4-mapped privates", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("allows public IPv6 (incl IPv4-mapped public)", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("fail-safe: blocks anything that is not a parseable public IP", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});
