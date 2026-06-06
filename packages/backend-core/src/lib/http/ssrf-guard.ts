/**
 * SSRF private-IP guard for the in-process discovery fetcher. PURE + unit-tested
 * (no DNS, no network) so the security decision is provable. The provider
 * resolves each fetch target — and every redirect hop — to its IP(s) and refuses
 * to fetch when any resolves private/link-local/loopback. This blocks a Serper
 * result (or a 30x redirect from one) from reaching internal cluster services or
 * a cloud metadata endpoint (169.254.169.254).
 */
import { isIP } from "node:net";

/**
 * True if `ip` is a private, loopback, link-local, or otherwise non-public
 * address that the fetcher must refuse. FAIL-SAFE: anything not parseable as a
 * public IP returns true (block) — the caller only ever passes resolved
 * addresses, so an unparseable value means "don't fetch".
 */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    return isPrivateIpv4(ip);
  }
  if (kind === 6) {
    return isPrivateIpv6(ip.toLowerCase());
  }
  return true; // not a valid IP literal → block
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true; // loopback / unspecified
  if (ip.startsWith("fe80")) return true; // link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7 ULA
  // IPv4-mapped (::ffff:a.b.c.d) — defer to the v4 check.
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    return isPrivateIpv4(mapped[1]!);
  }
  return false;
}
