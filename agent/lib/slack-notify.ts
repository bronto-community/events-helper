import { getToken } from "@vercel/connect";

// Post to Slack as the bot, using the Vercel Connect app token (works in the
// deployed runtime and locally when VERCEL_OIDC_TOKEN is present). Best-effort:
// returns a result rather than throwing.

async function slackPost(body: Record<string, unknown>): Promise<{ ok: boolean; ts?: string; error?: string }> {
  try {
    const token = await getToken(process.env.SLACK_CONNECTOR || "slack/bronto-events-helper", {
      subject: { type: "app" },
    });
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    return { ok: Boolean(json.ok), ts: json.ts, error: json.ok ? undefined : json.error };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Post a plain-text message to a Slack channel or user id (DM). */
export function postToChannel(channelId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  return slackPost({ channel: channelId, text });
}

/** Post a Block Kit message (with a plain-text fallback) to a channel or user id (DM). */
export function postBlocks(
  channelId: string,
  blocks: unknown[],
  fallbackText: string,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  return slackPost({ channel: channelId, blocks, text: fallbackText });
}
