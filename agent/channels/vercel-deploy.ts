import crypto from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import { type DeploymentEvent, notifyProductionDeploy } from "../lib/deploy-notify.js";
import { errorAttributes, log } from "../lib/log.js";

// Receives Vercel's `deployment.succeeded` webhook and announces the deploy
// (Slack notice + Bronto deployment event). This is the whole reason production
// deploys can be left to Vercel's Git integration: the announcement is no longer
// something the deploy script has to do on its way out.
//
// Why the agent serves this rather than a CI job: posting to Slack goes through
// Vercel Connect, which needs an OIDC token. The deployed runtime has one; a
// laptop or CI job needs `vercel env pull` and the token expires. See
// lib/deploy-notify.ts.
//
// Setup (one-time): create a team webhook at Settings → Webhooks, scoped to this
// project, subscribed to "Deployment Succeeded", pointed at
// https://<app>/vercel/deploy-hook. Put the secret it shows you into
// VERCEL_WEBHOOK_SECRET. Note that authored channel routes mount at the path given
// here, not under eve's reserved /eve/v1 prefix.
//
// The route is public — SSO deployment protection is off so Slack and Connect can
// reach the app — so every request must carry a valid signature. Vercel signs the
// raw body with HMAC-SHA1 and sends the hex digest in `x-vercel-signature`.

const WEBHOOK_SECRET = process.env.VERCEL_WEBHOOK_SECRET;

type VercelWebhookBody = {
  type?: string;
  payload?: {
    target?: string | null;
    deployment?: { id?: string; url?: string; meta?: Record<string, string> };
    links?: { deployment?: string };
    project?: { id?: string };
  };
};

function signatureMatches(rawBody: string, headerSignature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha1", secret).update(rawBody).digest("hex");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (headerSignature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(headerSignature), Buffer.from(expected));
}

export default defineChannel({
  routes: [
    POST("/vercel/deploy-hook", async (req, { waitUntil }) => {
      if (!WEBHOOK_SECRET) {
        // Fail closed: without the secret we cannot tell Vercel apart from anyone
        // else who found the URL.
        log.error("vercel deploy webhook hit but VERCEL_WEBHOOK_SECRET is unset");
        return Response.json({ error: "Webhook not configured." }, { status: 503 });
      }

      const rawBody = await req.text();
      const headerSignature = req.headers.get("x-vercel-signature");
      if (!headerSignature || !signatureMatches(rawBody, headerSignature, WEBHOOK_SECRET)) {
        log.warn("vercel deploy webhook rejected: bad signature");
        return Response.json({ error: "Invalid signature." }, { status: 403 });
      }

      let body: VercelWebhookBody;
      try {
        body = JSON.parse(rawBody) as VercelWebhookBody;
      } catch (err) {
        log.warn("vercel deploy webhook body was not JSON", errorAttributes(err));
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }

      // The webhook is scoped to production deploys of this project, but the
      // subscription can be widened by accident in the dashboard, so re-check here.
      if (body.type !== "deployment.succeeded" || body.payload?.target !== "production") {
        return Response.json({ ok: true, skipped: body.type ?? "unknown" });
      }

      const deployment = body.payload.deployment;
      if (!deployment?.id) {
        return Response.json({ ok: true, skipped: "no-deployment-id" });
      }

      const meta = deployment.meta ?? {};
      const event: DeploymentEvent = {
        deploymentId: deployment.id,
        url: deployment.url,
        commit: meta.githubCommitSha,
        branch: meta.githubCommitRef,
        commitMessage: meta.githubCommitMessage,
        inspectorUrl: body.payload.links?.deployment,
      };

      log.info("production deployment succeeded", {
        "deployment.id": event.deploymentId,
        ...(event.commit ? { "vcs.ref.head.revision": event.commit } : {}),
        ...(event.branch ? { "vcs.ref.head.name": event.branch } : {}),
      });

      // Answer Vercel immediately; a slow Slack or Bronto call must not turn into a
      // webhook timeout and a redelivery.
      waitUntil(
        notifyProductionDeploy(event).catch((err: unknown) => {
          log.error("deploy notification threw", {
            ...errorAttributes(err),
            "deployment.id": event.deploymentId,
          });
        }),
      );

      return Response.json({ ok: true });
    }),
  ],
});
