/**
 * smoke:read — read what a live outreach send ACTUALLY delivered, via Proton
 * Mail Bridge IMAP. This is the half the DB-side draft inspection can't show:
 * real rendering + deliverability of the email that landed in an inbox you own.
 *
 * Local ops tool (NOT part of the deployed app). Bridge creds come from the
 * gitignored .env (PROTON_BRIDGE_USERNAME / PROTON_BRIDGE_PASSWORD /
 * PROTON_BRIDGE_PORT). Bridge must be running locally.
 *
 * Usage (from the repo root):
 *   pnpm smoke:read                              # recent outreach emails in INBOX
 *   pnpm smoke:read --to lynx.sales@proton.me    # only mail delivered to one address
 *   pnpm smoke:read --from homeranger.app        # override the sender to search for
 *   pnpm smoke:read --limit 10 --html            # more results; dump each HTML to /tmp
 *   pnpm smoke:read --since 2026-06-01           # only since a date
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  buildBridgeImapConfig,
  senderAddress,
} from "@homeranger/backend-core/lib/mailbox/bridge-config";
import { analyzeOutreachBody } from "@homeranger/backend-core/lib/mailbox/outreach-body";

interface Args {
  to?: string;
  from: string;
  limit: number;
  since?: Date;
  dumpHtml: boolean;
  mailbox: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const limitRaw = get("--limit");
  const sinceRaw = get("--since");
  let since: Date | undefined;
  if (sinceRaw) {
    since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`--since "${sinceRaw}" is not a valid date (use YYYY-MM-DD).`);
    }
  }
  return {
    to: get("--to")?.toLowerCase(),
    // Default to the outreach sender (RESEND_FROM) if present locally, else the
    // sending domain. IMAP FROM-search is a substring match, so the domain works.
    from: (get("--from") ?? senderAddress(process.env.RESEND_FROM) ?? "homeranger.app").toLowerCase(),
    limit: limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10) || 5) : 5,
    since,
    dumpHtml: argv.includes("--html"),
    mailbox: get("--mailbox") ?? "INBOX",
  };
}

function snippet(text: string | undefined, n = 240): string {
  if (!text) return "(no text part)";
  return text.replace(/\s+/g, " ").trim().slice(0, n);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = buildBridgeImapConfig(process.env);

  console.log(
    `Reading ${args.mailbox} via Proton Bridge (${config.host}:${config.port}) as ${config.auth.user}`,
  );
  console.log(
    `Filter: from~"${args.from}"${args.to ? `, to="${args.to}"` : ""}${
      args.since ? `, since ${args.since.toISOString().slice(0, 10)}` : ""
    } (latest ${args.limit})\n`,
  );

  const client = new ImapFlow({ ...config, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(args.mailbox);
    try {
      const criteria: Record<string, unknown> = { from: args.from };
      if (args.to) criteria.to = args.to;
      if (args.since) criteria.since = args.since;

      const found = await client.search(criteria, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      if (uids.length === 0) {
        console.log(
          "No matching messages found. (Has the send happened yet? Check the From/To filters and that Bridge is synced.)",
        );
        return;
      }

      const wanted = uids.slice(-args.limit);
      console.log(`${uids.length} match(es); showing ${wanted.length}.\n`);

      let index = 0;
      for await (const message of client.fetch(
        wanted,
        { uid: true, source: true },
        { uid: true },
      )) {
        index += 1;
        const parsed = await simpleParser(message.source as Buffer);
        const to = Array.isArray(parsed.to)
          ? parsed.to.map((a) => a.text).join(", ")
          : parsed.to?.text ?? "";
        const html = typeof parsed.html === "string" ? parsed.html : "";
        // Shared analysis (em dash = AI tell; unsubscribe link must be present).
        const body = analyzeOutreachBody({ text: parsed.text, html });

        console.log(`#${index}  ${parsed.date?.toISOString() ?? "(no date)"}`);
        console.log(`  From:    ${parsed.from?.text ?? ""}`);
        console.log(`  To:      ${to}`);
        console.log(`  Subject: ${parsed.subject ?? ""}`);
        console.log(`  Text:    ${snippet(parsed.text)}`);
        console.log(
          `  HTML:    ${body.htmlLength ? `${body.htmlLength} chars` : "none"}` +
            `   em-dash: ${body.hasEmDash ? "PRESENT (AI tell!)" : "none"}` +
            `   unsubscribe: ${body.hasUnsubscribe ? "yes" : "MISSING"}`,
        );
        if (args.dumpHtml && html) {
          const path = `/tmp/smoke-read-${index}.html`;
          writeFileSync(path, html);
          console.log(`  HTML dumped: ${path}`);
        }
        console.log("");
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

main().catch((err: unknown) => {
  console.error("smoke:read failed:", err);
  process.exitCode = 1;
});
