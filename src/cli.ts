import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, crashAlert } from "./build.ts";
import type { Alert, Fetcher } from "./build.ts";
import { actionsRunUrl, postAlerts } from "./discord.ts";

const USER_AGENT = "Mozilla/5.0 (compatible; ymca-calendar/1.0)";

const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
};

const alerting = {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
  runUrl: actionsRunUrl(process.env),
};

const logAlerts = (alerts: Alert[]) => {
  for (const a of alerts) console.error(`[${a.severity}] ${a.categories.join(", ")} ${a.message}`.trim());
};

const outDir = process.argv[2] ?? "public";

try {
  const { decision, feeds, alerts } = await build({ fetch: httpFetcher, now: new Date() });
  logAlerts(alerts);

  if (decision === "hold-back") {
    await postAlerts(alerts, alerting);
    console.error("Held back: no Feeds written.");
    process.exitCode = 1;
  } else {
    await mkdir(outDir, { recursive: true });
    for (const feed of feeds) {
      await writeFile(join(outDir, feed.filename), feed.ics);
      const count = feed.ics.match(/^BEGIN:VEVENT\r?$/gm)?.length ?? 0;
      console.log(`${feed.filename}: ${count} Sessions`);
    }
    await postAlerts(alerts, alerting);
  }
} catch (err) {
  console.error(err);
  await postAlerts([crashAlert(err)], alerting);
  process.exitCode = 1;
}
