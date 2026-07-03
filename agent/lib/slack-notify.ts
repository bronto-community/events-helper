import { getToken } from "@vercel/connect";

// Post a message to a Slack channel as the bot, using the Vercel Connect app
// token (works in the deployed runtime and locally when VERCEL_OIDC_TOKEN is
// present). Used for operator/ops-channel notifications (source scans, etc.),
// the same channel the deploy notifier posts to. Best-effort: returns a result
// rather than throwing.
export async function postToChannel(
  channelId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
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
      body: JSON.stringify({ channel: channelId, text }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    return { ok: Boolean(body.ok), error: body.ok ? undefined : body.error };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
