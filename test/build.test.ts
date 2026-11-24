import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "../src/build.ts";
import type { BuildInput, Fetcher } from "../src/build.ts";
import { addDays } from "../src/time.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/virtuagym/${name}`, import.meta.url), "utf8");

const ORIGIN = "https://ymcamcdonald.virtuagym.com";
const weekUrl = (eventType: number, monday: string) =>
  `${ORIGIN}/classes/week/${monday}?event_type=${eventType}&embedded=1&pref_club=90765`;
const detailUrl = (id: string) => `${ORIGIN}/classes/class/${id}?embedded=1&pref_club=90765`;
const isDetailUrl = (url: string) => url.startsWith(`${ORIGIN}/classes/class/`);

// Monday 2026-11-23, noon in Toronto (EST, UTC-5). The window runs from Mon 2026-11-16
// (7 days back) to Sun 2026-12-13 (2 weeks after this one): week pages for Nov 16 and 23,
// Nov 30 and Dec 7.
const NOW = new Date("2026-11-23T17:00:00Z");
const WEEKS = ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"];

const SPACE_SLUGS = ["pool", "gyms", "studio-1", "studio-2"];

/** VirtuaGym's real page for a week with no Sessions: Community and Leadership has none at all. */
const EMPTY_WEEK = fixture("week-5-community-leadership-2026-11-23.html");

const CAPTURED_WEEKS: Record<string, string> = {
  [weekUrl(1, "2026-11-16")]: fixture("week-1-group-fitness-2026-11-16.html"),
  [weekUrl(1, "2026-11-23")]: fixture("week-1-group-fitness-2026-11-23.html"),
  [weekUrl(2, "2026-11-23")]: fixture("week-2-aquatics-2026-11-23.html"),
  [weekUrl(3, "2026-11-23")]: fixture("week-3-adult-recreational-sports-2026-11-23.html"),
  [weekUrl(4, "2026-11-23")]: fixture("week-4-child-youth-family-2026-11-23.html"),
};

// Sessions whose detail pages are captured.
const MUSCLEFIT_FRI = "401221148-682cd326b324f0-04288651"; // Fri 2026-11-20 06:30, Group Fitness
const AQUAFIT_MON = "1653640783-68a79873b24717-47199134"; // Mon 2026-11-23 08:00, Aquatics

/** Every page in the window: captured week pages, the empty page for the rest, and captured detail pages. */
function allPages(): Record<string, string> {
  const pages: Record<string, string> = {
    [detailUrl(MUSCLEFIT_FRI)]: fixture("detail-musclefit.html"),
    [detailUrl(AQUAFIT_MON)]: fixture("detail-aquafit.html"),
  };
  for (let eventType = 1; eventType <= 5; eventType++) {
    for (const week of WEEKS) pages[weekUrl(eventType, week)] = CAPTURED_WEEKS[weekUrl(eventType, week)] ?? EMPTY_WEEK;
  }
  return pages;
}

/** A minimal detail page in VirtuaGym's markup. */
const detailPage = (room: string, description: string) => `
  <div class="event-description-holder"><p>${description}</p></div>
  <div class="event-details-icons">
    <div class="event-details-icon"><div class="ui-tooltip-icon size-24 location"></div>
      <div class="icon-text">${room}</div></div>
  </div>`;

/**
 * Serves `pages`. Any other week page is an error. Any other detail page gets `otherDetail`,
 * or an error if it's null.
 */
function fakeFetcher(
  pages: Record<string, string> = allPages(),
  otherDetail: string | null = detailPage("Studio 2", "A Program."),
): Fetcher & { requested: string[] } {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    const page = pages[url] ?? (isDetailUrl(url) ? otherDetail : undefined);
    if (page == null) throw new Error(`Unexpected fetch: ${url}`);
    return page;
  };
  return Object.assign(fetcher, { requested });
}

const buildWith = (input: Partial<BuildInput> = {}) => build({ fetch: fakeFetcher(), now: NOW, ...input });

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

const feedIn = (feeds: Array<{ slug: string; ics: string }>, slug: string) => {
  const feed = feeds.find((f) => f.slug === slug);
  assert.ok(feed, `no ${slug} feed`);
  return feed;
};
const eventsIn = (feeds: Array<{ slug: string; ics: string }>, slug: string) => parseEvents(feedIn(feeds, slug).ics);
const allEvents = (feeds: Array<{ ics: string }>) => feeds.flatMap((f) => parseEvents(f.ics));
const uidOf = (sessionId: string) => `${sessionId}@ymca-calendar`;
const eventFor = (feeds: Array<{ slug: string; ics: string }>, slug: string, sessionId: string) => {
  const event = eventsIn(feeds, slug).find((e) => e.UID === `${sessionId}@ymca-calendar`);
  assert.ok(event, `Session ${sessionId} not in ${slug}`);
  return event;
};

/** The Session IDs a week page lists on a day ("DD-MM-YYYY"), or on any day. */
function idsOn(html: string, day = "\\d{2}-\\d{2}-\\d{4}"): string[] {
  const re = new RegExp(`<div id="([^"]+)"[^>]*class="class [^"]*internal-event-day-${day}"`, "g");
  return [...html.matchAll(re)].map((m) => m[1]!);
}

/** A copy of a week page moved `days` later, with its Session IDs prefixed so they're new Sessions. */
function movedWeek(html: string, days: number, idPrefix: string): string {
  return html
    .replace(/internal-event-day-(\d{2})-(\d{2})-(\d{4})/g, (_, d, m, y) => {
      const [yy, mm, dd] = addDays(`${y}-${m}-${d}`, days).split("-");
      return `internal-event-day-${dd}-${mm}-${yy}`;
    })
    .replace(/\b(\d{6,}-[0-9a-f]+-\d+)\b/g, `${idPrefix}$1`);
}

// --- Feeds and the window

test("fetches every Category's week pages across the window", async () => {
  const fetch = fakeFetcher();
  await buildWith({ fetch });
  const expected = [1, 2, 3, 4, 5].flatMap((t) => WEEKS.map((w) => weekUrl(t, w)));
  assert.deepEqual(fetch.requested.filter((u) => !isDetailUrl(u)).sort(), expected.sort());
});

test("publishes one Feed per Space, each with its calendar name", async () => {
  const { feeds } = await buildWith();
  assert.deepEqual(
    feeds.map((f) => f.filename),
    SPACE_SLUGS.map((s) => `${s}.ics`),
  );
  const names = feeds.map((f) => f.ics.match(/\r\nX-WR-CALNAME:(.*)\r\n/)?.[1]);
  assert.deepEqual(names, [
    "YMCA McDonald · Pool",
    "YMCA McDonald · Gyms",
    "YMCA McDonald · Studio 1",
    "YMCA McDonald · Studio 2",
  ]);
  for (const feed of feeds) {
    assert.match(feed.ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(feed.ics, /\r\nEND:VCALENDAR\r\n$/);
  }
});

test("includes every real Session in the window and ignores filler slots", async () => {
  const { feeds } = await buildWith();
  const realSessions = (html: string) => html.match(/openScheduleModal\('\/classes\/class\//g)?.length ?? 0;
  const expected = Object.values(CAPTURED_WEEKS).reduce((n, html) => n + realSessions(html), 0);
  const events = allEvents(feeds);
  assert.equal(events.length, expected);
  assert.equal(new Set(events.map((e) => e.UID)).size, events.length, "no Session is in two Feeds");
  assert.ok(events.every((e) => e.SUMMARY && e.DTSTART && e.DTEND));
});

test("excludes Sessions more than 7 days old", async () => {
  // On Tue 2026-11-24 the window starts on Tue 2026-11-17.
  const { feeds } = await buildWith({ now: new Date("2026-11-24T17:00:00Z") });
  const uids = new Set(allEvents(feeds).map((e) => e.UID));
  const html = fixture("week-1-group-fitness-2026-11-16.html");
  const monday = idsOn(html, "16-11-2026");
  const tuesday = idsOn(html, "17-11-2026");
  assert.ok(monday.length > 0 && tuesday.length > 0);
  assert.ok(monday.every((id) => !uids.has(`${id}@ymca-calendar`)), "Mon 2026-11-16 is outside the window");
  assert.ok(tuesday.every((id) => uids.has(`${id}@ymca-calendar`)), "Tue 2026-11-17 is inside the window");
});

test("excludes Sessions beyond 2 weeks after the current week", async () => {
  // Serve the Dec 7 page with Sessions spread from Sun Dec 13 (last day in) to Sat Dec 19.
  const html = movedWeek(fixture("week-1-group-fitness-2026-11-23.html"), 20, "x");
  const fetch = fakeFetcher({ ...allPages(), [weekUrl(1, "2026-12-07")]: html });
  const { feeds } = await buildWith({ fetch });
  const uids = new Set(allEvents(feeds).map((e) => e.UID));
  const lastDay = idsOn(html, "13-12-2026");
  const beyond = idsOn(html).filter((id) => !lastDay.includes(id));
  assert.ok(lastDay.length > 0 && beyond.length > 0);
  assert.ok(lastDay.every((id) => uids.has(`${id}@ymca-calendar`)), "Sun 2026-12-13 is inside the window");
  assert.ok(beyond.every((id) => !uids.has(`${id}@ymca-calendar`)), "after Sun 2026-12-13 is outside");
});

test("publishes an empty Community and Leadership Category without holding back", async () => {
  const { decision, alerts } = await buildWith();
  assert.equal(decision, "publish");
  assert.deepEqual(alerts, []);
});

test("publishes a Space's Feed even when it has no Sessions", async () => {
  const { decision, feeds, alerts } = await buildWith();
  assert.equal(decision, "publish");
  assert.deepEqual(alerts, []);
  assert.equal(eventsIn(feeds, "studio-1").length, 0);
});

test("lists a Feed's events in start order", async () => {
  const { feeds } = await buildWith();
  const starts = eventsIn(feeds, "studio-2").map((e) => e.DTSTART!);
  assert.ok(starts.length > 1);
  assert.deepEqual(starts, [...starts].sort());
});

// --- Spaces

test("gathers a Space's Sessions from every Category", async () => {
  const { feeds } = await buildWith({ fetch: fakeFetcher(allPages(), detailPage("Gym 2", "A Program.")) });
  const categories = new Set(eventsIn(feeds, "gyms").map((e) => e.DESCRIPTION!.match(/Category: ([^\\]+)/)?.[1]));
  assert.deepEqual([...categories].sort(), [
    "Adult Recreational Sports",
    "Aquatics",
    "Child Youth and Family Programs",
    "Group Fitness",
  ]);
});

test("puts Gym 1, Gym 2, and Gym 1 and 2 Sessions in the Gyms Feed, each showing its own Room", async () => {
  const html = fixture("week-3-adult-recreational-sports-2026-11-23.html");
  const [a, b] = idsOn(html);
  const pages = { ...allPages(), [detailUrl(a!)]: detailPage("Gym 1", "x"), [detailUrl(b!)]: detailPage("Gym 2", "x") };
  const { feeds } = await buildWith({ fetch: fakeFetcher(pages) });
  assert.equal(eventFor(feeds, "gyms", a!).LOCATION, "Gym 1");
  assert.equal(eventFor(feeds, "gyms", b!).LOCATION, "Gym 2");
  assert.equal(eventFor(feeds, "gyms", MUSCLEFIT_FRI).LOCATION, "Gym 1 and 2");
});

test("puts Strength and Conditioning Room Sessions in the Studio 2 Feed, keeping their Room", async () => {
  const [id] = idsOn(fixture("week-1-group-fitness-2026-11-23.html")).filter((i) => i !== MUSCLEFIT_FRI);
  const pages = { ...allPages(), [detailUrl(id!)]: detailPage("Strength and Conditioning Room", "x") };
  const { feeds, alerts } = await buildWith({ fetch: fakeFetcher(pages) });
  assert.deepEqual(alerts, []);
  assert.equal(eventFor(feeds, "studio-2", id!).LOCATION, "Strength and Conditioning Room");
});

test("puts Pickleball League in the Gyms Feed, though VirtuaGym gives it no Room", async () => {
  const league = "1483451459-6aecd6a5617659-40640508"; // Pickleball League (18+yrs) ⓡ
  const pages = { ...allPages(), [detailUrl(league)]: '<div class="event-description-holder"><p>League.</p></div>' };
  const { feeds, alerts } = await buildWith({ fetch: fakeFetcher(pages) });
  assert.deepEqual(alerts, []);
  const event = eventFor(feeds, "gyms", league);
  assert.equal(event.SUMMARY, "Pickleball League (18+yrs) ⓡ");
  assert.equal(event.LOCATION, undefined);
});

test("puts Pickleball League in the Gyms Feed even when its detail page fails to load", async () => {
  const league = "1483451459-6aecd6a5617659-40640508";
  const served = fakeFetcher();
  const fetch: Fetcher = async (url) => {
    if (url === detailUrl(league)) throw new Error("503 Service Unavailable");
    return served(url);
  };
  const { feeds } = await buildWith({ fetch });
  assert.ok(eventFor(feeds, "gyms", league));
});

test("warns, and leaves the Session out, when its Room is in no Space", async () => {
  const [id] = idsOn(fixture("week-2-aquatics-2026-11-23.html")).filter((i) => i !== AQUAFIT_MON);
  const pages = { ...allPages(), [detailUrl(id!)]: detailPage("Gym 3", "x") };
  const { decision, feeds, alerts } = await buildWith({ fetch: fakeFetcher(pages) });
  assert.equal(decision, "publish");
  assert.ok(allEvents(feeds).every((e) => e.UID !== uidOf(id!)));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "warning");
  assert.match(alerts[0]!.message, /Gym 3/);
  assert.deepEqual(alerts[0]!.categories, ["Aquatics"]);
  assert.equal(alerts[0]!.published, true);
});

// --- Events

test("maps a Session to an event in Toronto time, with its Leader and Category", async () => {
  const { feeds } = await buildWith();
  const muscleFit = eventFor(feeds, "gyms", MUSCLEFIT_FRI);
  assert.equal(muscleFit.SUMMARY, "MuscleFit");
  assert.equal(muscleFit.DTSTART, "20261120T113000Z");
  assert.equal(muscleFit.DTEND, "20261120T121500Z");
  assert.match(muscleFit.DESCRIPTION!, /^Leader: Eduardo Gonzalez\\nCategory: Group Fitness\\n\\n/);
});

test("shows the Room as the location and the Program description last, from the detail page", async () => {
  const { feeds } = await buildWith();
  const muscleFit = eventFor(feeds, "gyms", MUSCLEFIT_FRI);
  assert.equal(muscleFit.LOCATION, "Gym 1 and 2");
  assert.match(
    muscleFit.DESCRIPTION!,
    /\\n\\nYMCA MuscleFit is a high-energy\\, strength-based group fitness class.*strength journey\.$/,
  );
});

test("keeps ⓢ in the title and says Sign-up required, with AquaFit in the Pool", async () => {
  const { feeds } = await buildWith();
  const aquaFit = eventFor(feeds, "pool", AQUAFIT_MON);
  assert.equal(aquaFit.SUMMARY, "AquaFit (Combo) ⓢ");
  assert.equal(aquaFit.LOCATION, "Pool");
  assert.match(aquaFit.DESCRIPTION!, /^Leader: Nick Wilcox\\nCategory: Aquatics\\nSign-up required\\n\\nYMCA AquaFit/);
});

test("says Registration required for a ⓡ Program", async () => {
  const { feeds } = await buildWith();
  const lessons = allEvents(feeds).filter((e) => e.SUMMARY === "Swimming Lessons ⓡ");
  assert.ok(lessons.length > 0, "no Swimming Lessons ⓡ");
  for (const e of lessons) {
    assert.match(e.DESCRIPTION!, /Category: Aquatics\\nRegistration required\\n/);
    assert.doesNotMatch(e.DESCRIPTION!, /Sign-up/);
  }
});

test("names the Category in every event's description", async () => {
  const { feeds } = await buildWith();
  const weeks: Array<[string, string]> = [
    ["week-1-group-fitness-2026-11-23.html", "Group Fitness"],
    ["week-2-aquatics-2026-11-23.html", "Aquatics"],
    ["week-3-adult-recreational-sports-2026-11-23.html", "Adult Recreational Sports"],
    ["week-4-child-youth-family-2026-11-23.html", "Child Youth and Family Programs"],
  ];
  const byUid = new Map(allEvents(feeds).map((e) => [e.UID, e]));
  for (const [file, name] of weeks) {
    const ids = idsOn(fixture(file));
    assert.ok(ids.length > 0, `no ${name} Sessions`);
    for (const id of ids) assert.match(byUid.get(uidOf(id))?.DESCRIPTION ?? "", new RegExp(`Category: ${name}`), id);
  }
});

test("gives each Session a UID from its VirtuaGym Session ID, stable across runs", async () => {
  const first = (await buildWith()).feeds.flatMap((f) => parseEvents(f.ics));
  const second = (await buildWith()).feeds.flatMap((f) => parseEvents(f.ics));
  assert.ok(first.length > 0);
  assert.deepEqual(
    first.map((e) => e.UID),
    second.map((e) => e.UID),
  );
  assert.ok(first.some((e) => e.UID === "1477028746-682ccc7d853f29-74220417@ymca-calendar"));
  assert.equal(new Set(first.map((e) => e.UID)).size, first.length, "UIDs must be unique");
});

test("omits the Leader line when VirtuaGym lists no Leader", async () => {
  // Blank the Leader of one specific Session: Wed 2026-11-18 MuscleFit.
  const html = fixture("week-1-group-fitness-2026-11-16.html").replace(
    /(<div id="1299926966-682cd055cc38a7-29770412"[\s\S]*?<i>)Eduardo Gonzalez(<\/i>)/,
    "$1$2",
  );
  const fetch = fakeFetcher({ ...allPages(), [weekUrl(1, "2026-11-16")]: html });
  const { feeds } = await buildWith({ fetch });
  const session = eventFor(feeds, "studio-2", "1299926966-682cd055cc38a7-29770412");
  assert.match(session.DESCRIPTION!, /^Category: Group Fitness/);
});

// --- Detail cache

test("doesn't fetch the detail page of a Session already in the cache", async () => {
  const fetch = fakeFetcher();
  const detailCache = { [MUSCLEFIT_FRI]: { room: "Studio 1", description: "Cached description." } };
  const result = await buildWith({ fetch, detailCache });
  assert.ok(!fetch.requested.includes(detailUrl(MUSCLEFIT_FRI)));
  assert.equal(eventFor(result.feeds, "studio-1", MUSCLEFIT_FRI).LOCATION, "Studio 1");
  assert.deepEqual(result.detailCache[MUSCLEFIT_FRI], detailCache[MUSCLEFIT_FRI]);
});

test("returns a cache that serves the next run without any detail fetches", async () => {
  const first = await buildWith();
  const fetch = fakeFetcher(allPages(), null);
  const second = await buildWith({ fetch, detailCache: first.detailCache });
  assert.ok(fetch.requested.every((u) => !isDetailUrl(u)));
  assert.deepEqual(
    second.feeds.map((f) => f.ics),
    first.feeds.map((f) => f.ics),
  );
});

test("drops cache entries for Sessions no longer listed", async () => {
  const { detailCache } = await buildWith({
    detailCache: { "gone-session": { room: "Studio", description: null } },
  });
  assert.equal(detailCache["gone-session"], undefined);
  assert.ok(detailCache[MUSCLEFIT_FRI]);
});

test("leaves a Session out of every Feed when its detail page fails to load", async () => {
  const served = fakeFetcher();
  const fetch: Fetcher = async (url) => {
    if (url === detailUrl(MUSCLEFIT_FRI)) throw new Error("503 Service Unavailable");
    return served(url);
  };
  const { decision, feeds, detailCache } = await buildWith({ fetch });
  assert.equal(decision, "publish");
  assert.ok(allEvents(feeds).every((e) => e.UID !== uidOf(MUSCLEFIT_FRI)));
  assert.equal(detailCache[MUSCLEFIT_FRI], undefined, "a failed page isn't cached, so it's retried");
});

// --- Hold back

test("publishes with no alerts on an ordinary success", async () => {
  const { decision, alerts } = await buildWith();
  assert.equal(decision, "publish");
  assert.deepEqual(alerts, []);
});

test("holds back with a failure alert when a Category has no Sessions this week", async () => {
  // A page whose markup no longer matches, as after a VirtuaGym redesign.
  const fetch = fakeFetcher({ ...allPages(), [weekUrl(2, "2026-11-23")]: "<html><body><p>Schedule</p></body></html>" });
  const { decision, feeds, alerts } = await buildWith({ fetch });
  assert.equal(decision, "hold-back");
  assert.deepEqual(feeds, []);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "failure");
  assert.deepEqual(alerts[0]!.categories, ["Aquatics"]);
  assert.equal(alerts[0]!.published, false);
});

test("holds back when this week is empty even if last week had Sessions", async () => {
  const fetch = fakeFetcher({ ...allPages(), [weekUrl(1, "2026-11-23")]: EMPTY_WEEK });
  const { decision, alerts } = await buildWith({ fetch });
  assert.equal(decision, "hold-back");
  assert.deepEqual(alerts[0]!.categories, ["Group Fitness"]);
});

test("holds back with a failure alert when a week page can't be fetched", async () => {
  const pages = allPages();
  delete pages[weekUrl(3, "2026-11-30")];
  const { decision, feeds, alerts } = await buildWith({ fetch: fakeFetcher(pages) });
  assert.equal(decision, "hold-back");
  assert.deepEqual(feeds, []);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "failure");
  assert.deepEqual(alerts[0]!.categories, ["Adult Recreational Sports"]);
  assert.match(alerts[0]!.message, /Unexpected fetch/);
  assert.equal(alerts[0]!.published, false);
});

// --- Run state, soft warnings and recovery

const offline = () => fakeFetcher({}); // every fetch throws

test("treats a missing state as a first run, with no warnings", async () => {
  const { decision, alerts, state } = await buildWith();
  assert.equal(decision, "publish");
  assert.deepEqual(alerts, []);
  assert.equal(state.failed, false);
  assert.equal(state.sessionCounts["group-fitness"], idsOn(fixture("week-1-group-fitness-2026-11-23.html")).length);
  assert.equal(state.sessionCounts["community-leadership"], 0);
});

test("two consecutive successful runs produce no alerts", async () => {
  const first = await buildWith();
  const second = await buildWith({ previousState: first.state });
  assert.deepEqual(first.alerts, []);
  assert.deepEqual(second.alerts, []);
  assert.deepEqual(second.state, first.state);
});

test("warns, and still publishes, when a Category's Session count more than halves", async () => {
  const { state: normal } = await buildWith();
  const count = normal.sessionCounts.aquatics!;
  const previousState = { sessionCounts: { ...normal.sessionCounts, aquatics: count * 2 + 1 }, failed: false };

  const { decision, feeds, alerts, state } = await buildWith({ previousState });
  assert.equal(decision, "publish");
  assert.equal(feeds.length, 4);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "warning");
  assert.deepEqual(alerts[0]!.categories, ["Aquatics"]);
  assert.match(alerts[0]!.message, /Aquatics/);
  assert.equal(alerts[0]!.published, true);
  assert.equal(state.sessionCounts.aquatics, count, "the new count becomes the baseline");
});

test("doesn't warn when a Category's Session count falls by exactly half", async () => {
  const { state: normal } = await buildWith();
  const previousState = { sessionCounts: { ...normal.sessionCounts, aquatics: normal.sessionCounts.aquatics! * 2 }, failed: false };
  const { alerts } = await buildWith({ previousState });
  assert.deepEqual(alerts, []);
});

test("warns, and still publishes, when more than 10% of Sessions have no Room", async () => {
  const { decision, feeds, alerts } = await buildWith({ fetch: fakeFetcher(allPages(), null) }); // detail pages fail
  assert.equal(decision, "publish");
  assert.equal(feeds.length, 4);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "warning");
  assert.match(alerts[0]!.message, /no Room/);
  assert.deepEqual(alerts[0]!.categories, [
    "Group Fitness",
    "Aquatics",
    "Adult Recreational Sports",
    "Child Youth and Family Programs",
  ]);
  assert.equal(alerts[0]!.published, true);
});

test("doesn't warn when 10% or fewer of Sessions have no Room", async () => {
  // Online Sessions have no Room on VirtuaGym; a few of them are normal.
  const pages = allPages();
  const ids = [...new Set(Object.values(CAPTURED_WEEKS).flatMap((html) => idsOn(html)))];
  const roomless = ids.filter((id) => id !== MUSCLEFIT_FRI && id !== AQUAFIT_MON).slice(0, Math.floor(ids.length * 0.1));
  for (const id of roomless) pages[detailUrl(id)] = '<div class="event-description-holder"><p>Online.</p></div>';
  const { alerts } = await buildWith({ fetch: fakeFetcher(pages) });
  assert.ok(roomless.length > 0);
  assert.deepEqual(alerts, []);
});

test("records a failed run, keeping the last good counts", async () => {
  const good = await buildWith();
  const { decision, state } = await buildWith({ fetch: offline(), previousState: good.state });
  assert.equal(decision, "hold-back");
  assert.deepEqual(state, { sessionCounts: good.state.sessionCounts, failed: true });
});

test("sends exactly one recovered alert on the first publish after a failed run", async () => {
  const good = await buildWith();
  const failed = await buildWith({ fetch: offline(), previousState: good.state });
  const recovered = await buildWith({ previousState: failed.state });
  const after = await buildWith({ previousState: recovered.state });

  assert.equal(recovered.decision, "publish");
  assert.deepEqual(
    recovered.alerts.map((a) => a.severity),
    ["recovered"],
  );
  assert.equal(recovered.alerts[0]!.published, true);
  assert.equal(recovered.state.failed, false);
  assert.deepEqual(after.alerts, []);
});

test("doesn't send a recovered alert while still failing", async () => {
  const previousState = { sessionCounts: {}, failed: true };
  const { alerts } = await buildWith({ fetch: offline(), previousState });
  assert.deepEqual(
    alerts.map((a) => a.severity),
    ["failure"],
  );
});
