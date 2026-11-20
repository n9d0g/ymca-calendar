import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "../src/build.ts";
import type { Fetcher } from "../src/build.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/virtuagym/${name}`, import.meta.url), "utf8");

/** Serves captured VirtuaGym pages; any URL not listed is a test failure. */
function fakeFetcher(pages: Record<string, string>): Fetcher & { requested: string[] } {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    const page = pages[url];
    if (page === undefined) throw new Error(`Unexpected fetch: ${url}`);
    return page;
  };
  return Object.assign(fetcher, { requested });
}

const GROUP_FITNESS_WEEK_OF_NOV_16 =
  "https://ymcamcdonald.virtuagym.com/classes/week/2026-11-16?event_type=1&embedded=1&pref_club=90765";

// Friday 2026-11-20, noon in Toronto (EST, UTC-5).
const NOW = new Date("2026-11-20T17:00:00Z");

const run = () => {
  const fetch = fakeFetcher({
    [GROUP_FITNESS_WEEK_OF_NOV_16]: fixture("week-1-group-fitness-2026-11-16.html"),
  });
  return { fetch, result: build({ fetch, now: NOW }) };
};

/** Minimal iCalendar reader: unfolds lines and returns each VEVENT as a property map. */
function parseEvents(ics: string): Array<Record<string, string>> {
  const lines = ics.replace(/\r\n[ \t]/g, "").split("\r\n");
  const events: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT" && current) {
      events.push(current);
      current = null;
    } else if (current) {
      const i = line.indexOf(":");
      current[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return events;
}

const feedFor = async (slug: string) => {
  const { result } = run();
  const feed = (await result).feeds.find((f) => f.slug === slug);
  assert.ok(feed, `no ${slug} feed`);
  return feed;
};

test("fetches the current Toronto week's Group Fitness page", async () => {
  const { fetch, result } = run();
  await result;
  assert.deepEqual(fetch.requested, [GROUP_FITNESS_WEEK_OF_NOV_16]);
});

test("publishes a Group Fitness Feed with a calendar name", async () => {
  const feed = await feedFor("group-fitness");
  assert.equal(feed.filename, "group-fitness.ics");
  assert.match(feed.ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(feed.ics, /\r\nX-WR-CALNAME:YMCA McDonald · Group Fitness\r\n/);
  assert.match(feed.ics, /\r\nEND:VCALENDAR\r\n$/);
});

test("maps a Session to an event in Toronto time, with its Leader", async () => {
  const events = parseEvents((await feedFor("group-fitness")).ics);
  const muscleFit = events.find(
    (e) => e.SUMMARY === "MuscleFit" && e.DTSTART === "20261120T113000Z",
  );
  assert.ok(muscleFit, "MuscleFit on Fri 2026-11-20 06:30 Toronto not found");
  assert.equal(muscleFit.DTEND, "20261120T121500Z");
  assert.equal(muscleFit.DESCRIPTION, "Leader: Eduardo Gonzalez");
});

test("gives each Session a UID from its VirtuaGym Session ID, stable across runs", async () => {
  const first = parseEvents((await feedFor("group-fitness")).ics);
  const second = parseEvents((await feedFor("group-fitness")).ics);
  assert.ok(first.length > 0);
  assert.deepEqual(
    first.map((e) => e.UID),
    second.map((e) => e.UID),
  );
  assert.ok(first.some((e) => e.UID === "1477028746-682ccc7d853f29-74220417@ymca-calendar"));
  assert.equal(new Set(first.map((e) => e.UID)).size, first.length, "UIDs must be unique");
});

test("ignores filler slots and includes every real Session", async () => {
  const html = fixture("week-1-group-fitness-2026-11-16.html");
  const realSessions = html.match(/openScheduleModal\('\/classes\/class\//g)?.length ?? 0;
  const events = parseEvents((await feedFor("group-fitness")).ics);
  assert.equal(events.length, realSessions);
  assert.ok(events.every((e) => e.SUMMARY && e.DTSTART && e.DTEND));
});

test("omits the Leader line when VirtuaGym lists no Leader", async () => {
  // Blank the Leader of one specific Session: Wed 2026-11-18 MuscleFit.
  const html = fixture("week-1-group-fitness-2026-11-16.html").replace(
    /(<div id="1299926966-682cd055cc38a7-29770412"[\s\S]*?<i>)Eduardo Gonzalez(<\/i>)/,
    "$1$2",
  );
  const fetch = fakeFetcher({ [GROUP_FITNESS_WEEK_OF_NOV_16]: html });
  const { feeds } = await build({ fetch, now: NOW });
  const events = parseEvents(feeds[0]!.ics);
  const session = events.find((e) => e.UID === "1299926966-682cd055cc38a7-29770412@ymca-calendar");
  assert.ok(session, "Wed 2026-11-18 MuscleFit not found");
  assert.equal(session.DESCRIPTION, undefined);
});

test("publishes with no alerts on an ordinary success", async () => {
  const { result } = run();
  const { decision, alerts } = await result;
  assert.equal(decision, "publish");
  assert.deepEqual(alerts, []);
});

test("holds back with a failure alert when a Category has no Sessions this week", async () => {
  // A page whose markup no longer matches, as after a VirtuaGym redesign.
  const fetch = fakeFetcher({ [GROUP_FITNESS_WEEK_OF_NOV_16]: "<html><body><p>Schedule</p></body></html>" });
  const { decision, feeds, alerts } = await build({ fetch, now: NOW });
  assert.equal(decision, "hold-back");
  assert.deepEqual(feeds, []);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "failure");
  assert.deepEqual(alerts[0]!.categories, ["Group Fitness"]);
  assert.equal(alerts[0]!.published, false);
});

test("holds back with a failure alert when a week page can't be fetched", async () => {
  const fetch = fakeFetcher({}); // every fetch throws
  const { decision, feeds, alerts } = await build({ fetch, now: NOW });
  assert.equal(decision, "hold-back");
  assert.deepEqual(feeds, []);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "failure");
  assert.deepEqual(alerts[0]!.categories, ["Group Fitness"]);
  assert.match(alerts[0]!.message, /Unexpected fetch/);
  assert.equal(alerts[0]!.published, false);
});
