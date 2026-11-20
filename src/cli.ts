import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "./build.ts";
import type { Fetcher } from "./build.ts";

const USER_AGENT = "Mozilla/5.0 (compatible; ymca-calendar/1.0)";

const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
};

const outDir = process.argv[2] ?? "public";
const { feeds } = await build({ fetch: httpFetcher, now: new Date() });

await mkdir(outDir, { recursive: true });
for (const feed of feeds) {
  await writeFile(join(outDir, feed.filename), feed.ics);
  const count = feed.ics.match(/^BEGIN:VEVENT\r?$/gm)?.length ?? 0;
  console.log(`${feed.filename}: ${count} Sessions`);
}
