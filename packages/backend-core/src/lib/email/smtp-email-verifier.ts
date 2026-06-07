/**
 * Real SMTP deliverability probe (network adapter — coverage-excluded in
 * vitest.config.ts, like the other socket/provider shells). It does an MX lookup
 * then a turn-based SMTP conversation up to RCPT TO, reading the reply code and
 * mapping it via the pure classifyRcptCode. It NEVER sends DATA — no email is
 * delivered, this only asks the recipient's mail server whether the mailbox
 * exists. Every failure path (no MX, connect refused, timeout, protocol error)
 * resolves to "unknown" so a probe outage never blocks legitimate outreach.
 *
 * Requires outbound TCP :25, which the processor NetworkPolicy must allow
 * (allow-homeranger-processor egress). Selected only when EMAIL_VERIFY_FAKE!=1.
 */
import net from "node:net";
import { resolveMx } from "node:dns/promises";
import { emailDomain } from "./email-domain.js";
import {
  classifyRcptCode,
  type EmailDeliverability,
  type EmailVerifier,
} from "./email-verifier.js";

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface SmtpEmailVerifierOptions {
  timeoutMs?: number;
  heloName?: string;
  mailFrom?: string;
}

export class SmtpEmailVerifier implements EmailVerifier {
  private readonly timeoutMs: number;
  private readonly heloName: string;
  private readonly mailFrom: string;

  constructor(opts: SmtpEmailVerifierOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? intEnv("EMAIL_VERIFY_TIMEOUT_MS", 8000);
    this.heloName =
      opts.heloName ?? (process.env.EMAIL_VERIFY_HELO || "homeranger.app");
    this.mailFrom =
      opts.mailFrom ??
      (process.env.EMAIL_VERIFY_MAIL_FROM || "verify@homeranger.app");
  }

  async verify(email: string): Promise<EmailDeliverability> {
    const target = email.trim().toLowerCase();
    const domain = emailDomain(target);
    if (!domain) {
      return "unknown";
    }
    let host: string;
    try {
      const records = await resolveMx(domain);
      host =
        records.length > 0
          ? records.sort((a, b) => a.priority - b.priority)[0]!.exchange
          : domain; // no MX → implicit MX (the domain's A record)
    } catch {
      // NXDOMAIN / SERVFAIL / no MX — can't probe, stay conservative (sendable).
      return "unknown";
    }
    return this.probe(host, target);
  }

  private probe(host: string, target: string): Promise<EmailDeliverability> {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port: 25 });
      socket.setEncoding("utf8");
      socket.setTimeout(this.timeoutMs);

      let buf = "";
      let onReply: ((code: number | null) => void) | null = null;
      let finished = false;

      const finish = (verdict: EmailDeliverability): void => {
        if (finished) {
          return;
        }
        finished = true;
        try {
          socket.write("QUIT\r\n");
        } catch {
          // best-effort; we are tearing down anyway
        }
        socket.destroy();
        resolve(verdict);
      };

      const nextReply = (): Promise<number | null> =>
        new Promise((res) => {
          onReply = res;
        });

      socket.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          // "NNN-text" is a continuation; "NNN text" (or bare "NNN") is final.
          const match = /^(\d{3})([ -]?)/.exec(line);
          if (match && match[2] !== "-") {
            const code = Number(match[1]);
            const cb = onReply;
            onReply = null;
            cb?.(Number.isFinite(code) ? code : null);
          }
        }
      });
      socket.on("timeout", () => finish("unknown"));
      socket.on("error", () => finish("unknown"));
      socket.on("close", () => finish("unknown"));

      void (async () => {
        const greeting = await nextReply();
        if (greeting === null || greeting >= 400) {
          return finish("unknown");
        }
        socket.write(`EHLO ${this.heloName}\r\n`);
        const ehlo = await nextReply();
        if (ehlo === null || ehlo >= 400) {
          return finish("unknown");
        }
        socket.write(`MAIL FROM:<${this.mailFrom}>\r\n`);
        const mailFrom = await nextReply();
        if (mailFrom === null || mailFrom >= 400) {
          return finish("unknown");
        }
        socket.write(`RCPT TO:<${target}>\r\n`);
        const rcpt = await nextReply();
        return finish(classifyRcptCode(rcpt));
      })();
    });
  }
}
