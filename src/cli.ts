import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build, crashAlert } from "./build.ts";
import type { Alert, DetailCache, Fetcher, RunState } from "./build.ts";
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

/** Where run-to-run data lives; the workflow restores and saves this directory via the Actions cache. */
const STATE_DIR = process.env.STATE_DIR ?? ".state";
const DETAIL_CACHE_FILE = join(STATE_DIR, "detail-cache.json");
const RUN_STATE_FILE = join(STATE_DIR, "run-state.json");

/** A missing or unreadable file means a first run. */
async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

const previousState = await loadJson<RunState | undefined>(RUN_STATE_FILE, undefined);
if (!previousState) console.log("No previous run state: treating this as a first run.");

try {
  const { decision, feeds, alerts, detailCache, state } = await build({
    fetch: httpFetcher,
    now: new Date(),
    detailCache: await loadJson<DetailCache>(DETAIL_CACHE_FILE, {}),
    ...(previousState ? { previousState } : {}),
  });
  await saveJson(DETAIL_CACHE_FILE, detailCache);
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
  // Saved last: a crash before this point is recorded as a failed run below.
  await saveJson(RUN_STATE_FILE, state);
} catch (err) {
  console.error(err);
  await postAlerts([crashAlert(err)], alerting);
  await saveJson(RUN_STATE_FILE, {
    sessionCounts: previousState?.sessionCounts ?? {},
    failed: true,
  } satisfies RunState).catch(() => {});
  process.exitCode = 1;
}
