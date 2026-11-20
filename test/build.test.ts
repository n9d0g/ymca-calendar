import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "../src/build.ts";
import type { Fetcher } from "../src/build.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/virtuagym/${name}`, import.meta.url), "utf8");

const DETAIL_URL = /^https:\/\/ymcamcdonald\.virtuagym\.com\/classes\/class\/([^?]+)\?embedded=1&pref_club=90765$/;
const isDetailUrl = (url: string) => DETAIL_URL.test(url);

/** A minimal detail page in VirtuaGym's markup. */
const detailPage = (room: string, description: string) => `
  <div class="event-description-holder"><p>${description}</p></div>
  <div class="event-details-icons">
    <div class="event-details-icon"><div class="ui-tooltip-icon size-24 location"></div>
      <div class="icon-text">${room}</div></div>
  </div>`;

/**
 * Serves captured VirtuaGym pages. Any other week page is an error. Any other detail page
 * gets `otherDetail`, or an error if it's null.
 */
function fakeFetcher(
  pages: Record<string, string>,
  otherDetail: string | null = detailPage("Studio", "A Program."),
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

const GROUP_FITNESS_WEEK_OF_NOV_16 =
  "https://ymcamcdonald.virtuagym.com/classes/week/2026-11-16?event_type=1&embedded=1&pref_club=90765";

// Fri 2026-11-20 06:30 MuscleFit, whose detail page is captured in the fixtures.
const MUSCLEFIT_FRI = "401221148-682cd326b324f0-04288651";
const MUSCLEFIT_FRI_DETAIL = `https://ymcamcdonald.virtuagym.com/classes/class/${MUSCLEFIT_FRI}?embedded=1&pref_club=90765`;

// Friday 2026-11-20, noon in Toronto (EST, UTC-5).
const NOW = new Date("2026-11-20T17:00:00Z");

const run = () => {
  const fetch = fakeFetcher({
    [GROUP_FITNESS_WEEK_OF_NOV_16]: fixture("week-1-group-fitness-2026-11-16.html"),
    [MUSCLEFIT_FRI_DETAIL]: fixture("detail-musclefit.html"),
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
  assert.deepEqual(fetch.requested.filter((u) => !isDetailUrl(u)), [GROUP_FITNESS_WEEK_OF_NOV_16]);
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
  assert.match(muscleFit.DESCRIPTION!, /^Leader: Eduardo Gonzalez\\n\\n/);
});

test("shows the Room as the location and the Program description last, from the detail page", async () => {
  const events = parseEvents((await feedFor("group-fitness")).ics);
  const muscleFit = events.find((e) => e.UID === `${MUSCLEFIT_FRI}@ymca-calendar`);
  assert.ok(muscleFit, "Fri MuscleFit not found");
  assert.equal(muscleFit.LOCATION, "Gym 1 and 2");
  assert.match(
    muscleFit.DESCRIPTION!,
    /^Leader: Eduardo Gonzalez\\n\\nYMCA MuscleFit is a high-energy\\, strength-based group fitness class.*strength journey\.$/,
  );
});

test("trims the Room, as on the AquaFit detail page", async () => {
  // AquaFit's Room is "Pool " in its detail fixture.
  const fetch = fakeFetcher({
    [GROUP_FITNESS_WEEK_OF_NOV_16]: fixture("week-1-group-fitness-2026-11-16.html"),
    [MUSCLEFIT_FRI_DETAIL]: fixture("detail-aquafit.html"),
  });
  const { feeds } = await build({ fetch, now: NOW });
  const event = parseEvents(feeds[0]!.ics).find((e) => e.UID === `${MUSCLEFIT_FRI}@ymca-calendar`);
  assert.equal(event?.LOCATION, "Pool");
});

test("doesn't fetch the detail page of a Session already in the cache", async () => {
  const fetch = fakeFetcher({
    [GROUP_FITNESS_WEEK_OF_NOV_16]: fixture("week-1-group-fitness-2026-11-16.html"),
  });
  const detailCache = { [MUSCLEFIT_FRI]: { room: "Cached Room", description: "Cached description." } };
  const result = await build({ fetch, now: NOW, detailCache });
  assert.ok(!fetch.requested.includes(MUSCLEFIT_FRI_DETAIL));
  const event = parseEvents(result.feeds[0]!.ics).find((e) => e.UID === `${MUSCLEFIT_FRI}@ymca-calendar`);
  assert.equal(event?.LOCATION, "Cached Room");
  assert.deepEqual(result.detailCache[MUSCLEFIT_FRI], detailCache[MUSCLEFIT_FRI]);
});

test("returns a cache that serves the next run without any detail fetches", async () => {
  const first = await run().result;
  const fetch = fakeFetcher({ [GROUP_FITNESS_WEEK_OF_NOV_16]: fixture("week-1-group-fitness-2026-11-16.html") }, null);
  const second = await build({ fetch, now: NOW, detailCache: first.detailCache });
  assert.deepEqual(fetch.requested, [GROUP_FITNESS_WEEK_OF_NOV_16]);
  assert.equal(second.feeds[0]!.ics, first.feeds[0]!.ics);
});

test("drops cache entries for Sessions no longer listed", async () => {
  const { detailCache } = await build({
    fetch: run().fetch,
    now: NOW,
    detailCache: { "gone-session": { room: "Studio", description: null } },
  });
  assert.equal(detailCache["gone-session"], undefined);
  assert.ok(detailCache[MUSCLEFIT_FRI]);
});

test("publishes a Session without a Room when its detail page fails to load", async () => {
  const fetch = fakeFetcher(
    { [GROUP_FITNESS_WEEK_OF_NOV_16]: fixture("week-1-group-fitness-2026-11-16.html") },
    null, // every detail page fails
  );
  const { decision, feeds, detailCache } = await build({ fetch, now: NOW });
  assert.equal(decision, "publish");
  const event = parseEvents(feeds[0]!.ics).find((e) => e.UID === `${MUSCLEFIT_FRI}@ymca-calendar`);
  assert.ok(event, "Fri MuscleFit not found");
  assert.equal(event.LOCATION, undefined);
  assert.equal(event.DESCRIPTION, "Leader: Eduardo Gonzalez");
  assert.equal(detailCache[MUSCLEFIT_FRI], undefined, "a failed page isn't cached, so it's retried");
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
  assert.doesNotMatch(session.DESCRIPTION ?? "", /Leader/);
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

const weekFetcher = (otherDetail?: string | null) =>
  fakeFetcher({ [GROUP_FITNESS_WEEK_OF_NOV_16]: fixture("week-1-group-fitness-2026-11-16.html") }, otherDetail);

test("treats a missing state as a first run, with no warnings", async () => {
  const { decision, alerts, state } = await build({ fetch: weekFetcher(), now: NOW });
  assert.equal(decision, "publish");
  assert.deepEqual(alerts, []);
  assert.equal(state.failed, false);
  assert.ok(state.sessionCounts["group-fitness"]! > 0);
});

test("two consecutive successful runs produce no alerts", async () => {
  const first = await build({ fetch: weekFetcher(), now: NOW });
  const second = await build({ fetch: weekFetcher(), now: NOW, previousState: first.state });
  assert.deepEqual(first.alerts, []);
  assert.deepEqual(second.alerts, []);
  assert.deepEqual(second.state, first.state);
});

test("warns, and still publishes, when a Category's Session count more than halves", async () => {
  const { state: normal } = await build({ fetch: weekFetcher(), now: NOW });
  const count = normal.sessionCounts["group-fitness"]!;
  const previousState = { sessionCounts: { "group-fitness": count * 2 + 1 }, failed: false };

  const { decision, feeds, alerts, state } = await build({ fetch: weekFetcher(), now: NOW, previousState });
  assert.equal(decision, "publish");
  assert.equal(feeds.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "warning");
  assert.deepEqual(alerts[0]!.categories, ["Group Fitness"]);
  assert.match(alerts[0]!.message, /Group Fitness/);
  assert.equal(alerts[0]!.published, true);
  assert.equal(state.sessionCounts["group-fitness"], count, "the new count becomes the baseline");
});

test("doesn't warn when a Category's Session count falls by exactly half", async () => {
  const { state: normal } = await build({ fetch: weekFetcher(), now: NOW });
  const previousState = { sessionCounts: { "group-fitness": normal.sessionCounts["group-fitness"]! * 2 }, failed: false };
  const { alerts } = await build({ fetch: weekFetcher(), now: NOW, previousState });
  assert.deepEqual(alerts, []);
});

test("warns, and still publishes, when more than 10% of Sessions have no Room", async () => {
  const { decision, feeds, alerts } = await build({ fetch: weekFetcher(null), now: NOW }); // detail pages fail
  assert.equal(decision, "publish");
  assert.equal(feeds.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "warning");
  assert.match(alerts[0]!.message, /no Room/);
  assert.deepEqual(alerts[0]!.categories, ["Group Fitness"]);
  assert.equal(alerts[0]!.published, true);
});

test("doesn't warn when 10% or fewer of Sessions have no Room", async () => {
  // Online Sessions have no Room on VirtuaGym; a few of them are normal.
  const html = fixture("week-1-group-fitness-2026-11-16.html");
  const ids = [...html.matchAll(/<div id="([^"]+)"[^>]*class="class /g)].map((m) => m[1]!);
  const roomless = Math.floor(ids.length * 0.1);
  const pages: Record<string, string> = { [GROUP_FITNESS_WEEK_OF_NOV_16]: html };
  for (const id of ids.slice(0, roomless)) {
    pages[`https://ymcamcdonald.virtuagym.com/classes/class/${id}?embedded=1&pref_club=90765`] =
      '<div class="event-description-holder"><p>Online.</p></div>';
  }
  const { alerts } = await build({ fetch: fakeFetcher(pages), now: NOW });
  assert.ok(roomless > 0);
  assert.deepEqual(alerts, []);
});

test("records a failed run, keeping the last good counts", async () => {
  const good = await build({ fetch: weekFetcher(), now: NOW });
  const { decision, state } = await build({ fetch: fakeFetcher({}), now: NOW, previousState: good.state });
  assert.equal(decision, "hold-back");
  assert.deepEqual(state, { sessionCounts: good.state.sessionCounts, failed: true });
});

test("sends exactly one recovered alert on the first publish after a failed run", async () => {
  const good = await build({ fetch: weekFetcher(), now: NOW });
  const failed = await build({ fetch: fakeFetcher({}), now: NOW, previousState: good.state });
  const recovered = await build({ fetch: weekFetcher(), now: NOW, previousState: failed.state });
  const after = await build({ fetch: weekFetcher(), now: NOW, previousState: recovered.state });

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
  const { alerts } = await build({ fetch: fakeFetcher({}), now: NOW, previousState });
  assert.deepEqual(
    alerts.map((a) => a.severity),
    ["failure"],
  );
});
