/**
 * Proton Mail Bridge IMAP config builder — the pure, unit-tested half of the
 * `smoke:read` mailbox reader (scripts/email-smoke-read.ts). Bridge runs a local
 * IMAP server that exposes the logged-in Proton account's mailboxes; the reader
 * polls it to confirm what a live outreach send ACTUALLY delivered (rendering,
 * deliverability) — the one thing the DB-side draft inspection can't show.
 *
 * Bridge specifics this encodes:
 *   - host defaults to 127.0.0.1 (Bridge listens locally only).
 *   - it speaks STARTTLS on the IMAP port, so `secure:false` (upgrade), not
 *     implicit TLS.
 *   - it presents a SELF-SIGNED certificate, so `tls.rejectUnauthorized:false`
 *     is required or the handshake fails. This is safe ONLY because the endpoint
 *     is loopback (no MITM surface on 127.0.0.1).
 *
 * Creds come from the environment (PROTON_BRIDGE_USERNAME/PASSWORD/PORT, kept in
 * the gitignored .env), never the repo. The shape returned matches imapflow's
 * ClientOptions so the script passes it straight through.
 */

/** The subset of imapflow ClientOptions the reader needs. */
export interface BridgeImapConfig {
  host: string;
  port: number;
  /** false → STARTTLS upgrade (Bridge), not implicit TLS. */
  secure: boolean;
  auth: { user: string; pass: string };
  /** Bridge ships a self-signed cert on loopback → must not reject it. */
  tls: { rejectUnauthorized: boolean };
}

export type BridgeEnv = Record<string, string | undefined>;

export function buildBridgeImapConfig(env: BridgeEnv): BridgeImapConfig {
  const user = env.PROTON_BRIDGE_USERNAME?.trim();
  // Do NOT trim the password — Bridge tokens are opaque and could be
  // whitespace-sensitive.
  const pass = env.PROTON_BRIDGE_PASSWORD;
  const portRaw = env.PROTON_BRIDGE_PORT?.trim();

  const missing: string[] = [];
  if (!user) missing.push("PROTON_BRIDGE_USERNAME");
  if (!pass) missing.push("PROTON_BRIDGE_PASSWORD");
  if (!portRaw) missing.push("PROTON_BRIDGE_PORT");
  if (missing.length > 0) {
    throw new Error(
      `Proton Bridge IMAP needs ${missing.join(", ")} in the environment (set them in .env).`,
    );
  }

  const port = Number.parseInt(portRaw as string, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`PROTON_BRIDGE_PORT is not a valid TCP port: ${portRaw}`);
  }

  // tls.rejectUnauthorized:false (below) trusts Bridge's self-signed cert, which
  // is ONLY safe on loopback (no MITM surface). Refuse a non-loopback override so
  // a .env copied onto a different network topology can't open a trust-all
  // channel to an arbitrary host.
  const host = env.PROTON_BRIDGE_HOST?.trim() || "127.0.0.1";
  if (!/^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/i.test(host)) {
    throw new Error(
      `PROTON_BRIDGE_HOST "${host}" is not a loopback address. This reader trusts Bridge's self-signed certificate, which is only safe on loopback (127.x.x.x / ::1 / localhost).`,
    );
  }
  return {
    host,
    port,
    secure: false,
    auth: { user: user as string, pass: pass as string },
    tls: { rejectUnauthorized: false },
  };
}

/**
 * Extract the bare address from a `From`/RESEND_FROM value so the reader can
 * search the inbox for the outreach sender:
 *   "HomeRanger <noreply@homeranger.app>" → "noreply@homeranger.app"
 *   "noreply@homeranger.app"              → "noreply@homeranger.app"
 * Returns null when there is no address-shaped token.
 */
export function senderAddress(from: string | undefined | null): string | null {
  if (!from) return null;
  const angle = from.match(/<([^>]+)>/);
  const candidate = (angle?.[1] ?? from).trim().toLowerCase();
  return candidate.includes("@") ? candidate : null;
}
