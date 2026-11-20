import type { Alert } from "./build.ts";

/** Discord rejects message content over 2000 characters. */
const MAX_CONTENT = 2000;

const HEADINGS: Record<Alert["severity"], string> = {
  failure: "🔴 YMCA Feeds: failure",
  warning: "🟡 YMCA Feeds: warning",
  recovered: "🟢 YMCA Feeds: recovered",
};

export function formatAlert(alert: Alert, runUrl: string | undefined): string {
  const lines = [`**${HEADINGS[alert.severity]}**`, alert.message];
  if (alert.categories.length > 0) lines.push(`Categories: ${alert.categories.join(", ")}`);
  lines.push(alert.published ? "Feeds were published." : "Feeds were held back; the last good Feeds stay live.");
  if (runUrl) lines.push(`Run: ${runUrl}`);
  const content = lines.join("\n");
  return content.length <= MAX_CONTENT ? content : `${content.slice(0, MAX_CONTENT - 1)}…`;
}

/**
 * Posts each alert to a Discord webhook, with no @mentions.
 * Without a webhook URL, logs that alerting is skipped and does nothing.
 * Never throws: a failed alert must not change the outcome of the run.
 */
export async function postAlerts(
  alerts: Alert[],
  { webhookUrl, runUrl }: { webhookUrl: string | undefined; runUrl: string | undefined },
): Promise<void> {
  if (alerts.length === 0) return;
  if (!webhookUrl) {
    console.log(`DISCORD_WEBHOOK_URL is not set; skipping ${alerts.length} alert(s).`);
    return;
  }
  for (const alert of alerts) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: formatAlert(alert, runUrl), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) console.error(`Discord alert failed: ${res.status} ${res.statusText}`);
    } catch (err) {
      console.error(`Discord alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The URL of the current GitHub Actions run, if running in one. */
export function actionsRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}
