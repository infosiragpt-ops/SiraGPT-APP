// Slack Incoming Webhook helper — Block-kit formatted notifier.
//
// This module is intentionally NOT auto-wired into the app. It exposes
// pure functions so callers (settings page, agent runners, server
// actions) can opt-in explicitly:
//
//   import { sendSlackBlocks, buildSlackBlocks } from "@/lib/integrations/slack";
//   await sendSlackBlocks(webhookUrl, buildSlackBlocks({ title, body }));
//
// All transport goes through fetch; the module is isomorphic-safe as
// long as the runtime provides globalThis.fetch (Next.js server +
// modern browsers both qualify).

export type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji?: boolean } }
  | { type: "section"; text: { type: "mrkdwn" | "plain_text"; text: string } }
  | { type: "divider" }
  | { type: "context"; elements: Array<{ type: "mrkdwn" | "plain_text"; text: string }> };

export interface SlackMessageBody {
  text: string;
  blocks: SlackBlock[];
}

export interface BuildBlocksInput {
  title: string;
  body?: string;
  fields?: Array<{ label: string; value: string }>;
  footer?: string;
}

/**
 * Build a canonical Block-kit message body from a small data bag.
 * The `text` field is included as a fallback for clients that don't
 * render blocks (e.g. notification previews).
 */
export function buildSlackBlocks(input: BuildBlocksInput): SlackMessageBody {
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: input.title.slice(0, 150), emoji: false } },
  ];
  if (input.body) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: input.body.slice(0, 2900) } });
  }
  if (input.fields && input.fields.length) {
    const lines = input.fields
      .slice(0, 10)
      .map((f) => `*${f.label}:* ${f.value}`)
      .join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: lines } });
  }
  if (input.footer) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: input.footer.slice(0, 200) }] });
  }
  return { text: input.title, blocks };
}

/**
 * POST a pre-built Slack body to an Incoming Webhook URL. Returns the
 * raw HTTP status; Slack's webhook surface returns plain text "ok" on
 * success, no JSON, so we don't bother parsing the body.
 */
export async function sendSlackBlocks(
  webhookUrl: string,
  body: SlackMessageBody,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {}
): Promise<{ ok: boolean; status: number }> {
  if (!webhookUrl) throw new Error("webhookUrl required");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);
  const fetchFn = opts.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience: ship a one-shot notification given a title + body.
 */
export async function notifySlack(
  webhookUrl: string,
  title: string,
  body?: string
): Promise<{ ok: boolean; status: number }> {
  return sendSlackBlocks(webhookUrl, buildSlackBlocks({ title, body }));
}
