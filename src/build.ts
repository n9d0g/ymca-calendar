import { renderCalendar } from "./ics.ts";
import type { CalendarEvent } from "./ics.ts";
import { CENTRE_TIME_ZONE, addDays, localDate, mondayOf, zonedToUtc } from "./time.ts";
import { detailUrl, parseDetail, parseWeek, weekUrl } from "./virtuagym.ts";
import type { ListedSession, SessionDetail } from "./virtuagym.ts";

/** Fetches a URL and returns its body as text. */
export type Fetcher = (url: string) => Promise<string>;

/** Detail-page results by Session ID, kept between runs so each Session's page is fetched once. */
export type DetailCache = Record<string, SessionDetail>;

/** What one run remembers for the next. */
export interface RunState {
  /** Sessions this week per Category slug, from the last run that published. */
  sessionCounts: Record<string, number>;
  /** Whether the last run held back or crashed. */
  failed: boolean;
}

export interface BuildInput {
  fetch: Fetcher;
  now: Date;
  /** The previous run's detail cache; empty on a first run or after the cache is lost. */
  detailCache?: DetailCache;
  /** The previous run's state; absent on a first run or after the state is lost. */
  previousState?: RunState;
}

export interface Feed {
  slug: string;
  filename: string;
  ics: string;
}

/** "publish" replaces the live Feeds; "hold-back" keeps the last good ones live. */
export type Decision = "publish" | "hold-back";

export interface Alert {
  severity: "failure" | "warning" | "recovered";
  /** What happened, in a sentence or two. */
  message: string;
  /** Names of the affected Categories, if any. */
  categories: string[];
  /** Whether this run's Feeds were published. */
  published: boolean;
}

export interface BuildResult {
  decision: Decision;
  /** The Feeds to publish; empty when held back. */
  feeds: Feed[];
  /** Alerts to send; empty on an ordinary success. */
  alerts: Alert[];
  /** The detail cache to keep for the next run; on publish, it holds only this run's Sessions. */
  detailCache: DetailCache;
  /** The state to keep for the next run. */
  state: RunState;
}

interface Category {
  eventType: number;
  slug: string;
  name: string;
  /** True for a Category that legitimately has no Sessions, so an empty week isn't a failure. */
  mayBeEmpty?: boolean;
}

const CATEGORIES: Category[] = [
  { eventType: 1, slug: "group-fitness", name: "Group Fitness" },
  { eventType: 2, slug: "aquatics", name: "Aquatics" },
  { eventType: 3, slug: "adult-recreational-sports", name: "Adult Recreational Sports" },
  { eventType: 4, slug: "child-youth-family", name: "Child Youth and Family Programs" },
  // Has had no Sessions on VirtuaGym at all (checked out to January 2027). The other
  // four Categories still catch a markup break, which would empty all of them.
  { eventType: 5, slug: "community-leadership", name: "Community and Leadership", mayBeEmpty: true },
];

/** Days of past Sessions kept, so last week's don't vanish from calendars the moment they end. */
const DAYS_BACK = 7;

/** Weeks after the current one to publish. VirtuaGym projects recurring Sessions forever. */
const WEEKS_AHEAD = 2;

/** How often subscribers are asked to re-fetch; matches the publishing schedule. */
const REFRESH_HOURS = 6;

/** Detail pages fetched at once, to stay polite to VirtuaGym. */
const DETAIL_CONCURRENCY = 4;

/** A Category losing more than this share of its Sessions since the last run is suspicious. */
const COUNT_DROP_THRESHOLD = 0.5;

/** More than this share of Sessions without a Room suggests detail pages are failing. */
const MISSING_ROOM_THRESHOLD = 0.1;

/**
 * Builds one Feed per Category from VirtuaGym, covering the past 7 days, the
 * current week and the next 2 weeks in Centre time.
 *
 * Holds back, with a failure alert, if any Category finds no Sessions this week
 * or can't be fetched or parsed: publishing then would wipe subscribers' calendars.
 *
 * Publishes with a warning when a Category's Session count more than halves since the
 * last run, or when more than ~10% of Sessions have no Room. Sends one "recovered" alert
 * on the first publish after a failed run. An ordinary success sends nothing.
 */
export async function build({
  fetch,
  now,
  detailCache = {},
  previousState,
}: BuildInput): Promise<BuildResult> {
  const today = localDate(now, CENTRE_TIME_ZONE);
  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  const windowStart = addDays(today, -DAYS_BACK);
  const windowEnd = addDays(sunday, 7 * WEEKS_AHEAD);
  const weeks: string[] = [];
  for (let week = mondayOf(windowStart); week <= windowEnd; week = addDays(week, 7)) weeks.push(week);

  const feeds: Feed[] = [];
  const nextCache: DetailCache = {};
  const sessionCounts: Record<string, number> = {};
  const dropped: Array<{ category: string; from: number; to: number }> = [];
  const withoutRoom: string[] = [];
  let sessionTotal = 0;
  let missingRooms = 0;
  const empty: string[] = [];
  const errored: Array<{ category: string; error: string }> = [];

  for (const category of CATEGORIES) {
    const sessions: ListedSession[] = [];
    try {
      const seen = new Set<string>();
      for (const week of weeks) {
        for (const s of parseWeek(await fetch(weekUrl(category.eventType, week)))) {
          if (s.date < windowStart || s.date > windowEnd || seen.has(s.id)) continue;
          seen.add(s.id);
          sessions.push(s);
        }
      }
    } catch (err) {
      errored.push({ category: category.name, error: errorMessage(err) });
      continue;
    }
    // This week is the health check: past weeks can thin out and future ones may not be scheduled yet.
    const thisWeek = sessions.filter((s) => s.date >= monday && s.date <= sunday).length;
    if (thisWeek === 0 && !category.mayBeEmpty) {
      empty.push(category.name);
      continue;
    }
    const details = await fetchDetails(sessions, fetch, detailCache, nextCache);

    sessionCounts[category.slug] = thisWeek;
    const previousCount = previousState?.sessionCounts[category.slug];
    if (previousCount !== undefined && thisWeek < previousCount * (1 - COUNT_DROP_THRESHOLD)) {
      dropped.push({ category: category.name, from: previousCount, to: thisWeek });
    }
    const missing = sessions.filter((s) => !details.get(s.id)?.room).length;
    if (missing > 0) withoutRoom.push(category.name);
    sessionTotal += sessions.length;
    missingRooms += missing;
    feeds.push({
      slug: category.slug,
      filename: `${category.slug}.ics`,
      ics: renderCalendar({
        name: `YMCA McDonald · ${category.name}`,
        timeZone: CENTRE_TIME_ZONE,
        refreshHours: REFRESH_HOURS,
        stamp: now,
        events: sessions.map((s) => toEvent(s, category, details.get(s.id))),
      }),
    });
  }

  const alerts: Alert[] = [];
  if (empty.length > 0) {
    alerts.push({
      severity: "failure",
      message: `No Sessions found for the week of ${monday}. VirtuaGym may have changed its markup or be down.`,
      categories: empty,
      published: false,
    });
  }
  if (errored.length > 0) {
    alerts.push({
      severity: "failure",
      message: errored.map((e) => `${e.category}: ${e.error}`).join("\n"),
      categories: errored.map((e) => e.category),
      published: false,
    });
  }

  if (alerts.length > 0) {
    return {
      decision: "hold-back",
      feeds: [],
      alerts,
      // Keep the old entries too: a broken Category's Sessions will likely be back next run.
      detailCache: { ...detailCache, ...nextCache },
      // Keep the last good counts, so the next publish is compared against them.
      state: { sessionCounts: previousState?.sessionCounts ?? {}, failed: true },
    };
  }

  if (previousState?.failed) {
    alerts.push({
      severity: "recovered",
      message: "The Feeds published again after a failed run.",
      categories: [],
      published: true,
    });
  }
  if (dropped.length > 0) {
    alerts.push({
      severity: "warning",
      message: `Session count fell by more than half since the last run: ${dropped
        .map((d) => `${d.category} (${d.from} → ${d.to})`)
        .join(", ")}.`,
      categories: dropped.map((d) => d.category),
      published: true,
    });
  }
  if (sessionTotal > 0 && missingRooms / sessionTotal > MISSING_ROOM_THRESHOLD) {
    alerts.push({
      severity: "warning",
      message: `${missingRooms} of ${sessionTotal} Sessions have no Room. Detail pages may be failing.`,
      categories: withoutRoom,
      published: true,
    });
  }

  return {
    decision: "publish",
    feeds,
    alerts,
    detailCache: nextCache,
    state: { sessionCounts, failed: false },
  };
}

/**
 * Looks up each Session's detail, from the cache or by fetching its detail page.
 * A page that fails to load leaves that Session without detail and uncached, so the next run retries it.
 */
async function fetchDetails(
  sessions: ListedSession[],
  fetch: Fetcher,
  cache: DetailCache,
  nextCache: DetailCache,
): Promise<Map<string, SessionDetail>> {
  const found = new Map<string, SessionDetail>();
  const queue = sessions.map((s) => s.id).filter((id, i, ids) => ids.indexOf(id) === i);
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      let detail = cache[id];
      if (!detail) {
        try {
          detail = parseDetail(await fetch(detailUrl(id)));
        } catch {
          continue;
        }
      }
      found.set(id, detail);
      nextCache[id] = detail;
    }
  };
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  return found;
}

/** The failure alert for an error thrown outside the build, e.g. while writing Feeds. */
export function crashAlert(err: unknown): Alert {
  return {
    severity: "failure",
    message: `The build crashed: ${errorMessage(err)}`,
    categories: [],
    published: false,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toEvent(s: ListedSession, category: Category, detail: SessionDetail | undefined): CalendarEvent {
  const facts = [
    s.leader ? `Leader: ${s.leader}` : null,
    `Category: ${category.name}`,
    s.program.includes("ⓢ") ? "Sign-up required" : null,
    s.program.includes("ⓡ") ? "Registration required" : null,
  ].filter((line) => line !== null);
  const description = [facts.join("\n"), detail?.description ?? null]
    .filter((part) => part !== null)
    .join("\n\n");
  return {
    uid: `${s.id}@ymca-calendar`,
    start: zonedToUtc(s.date, s.start, CENTRE_TIME_ZONE),
    end: zonedToUtc(s.date, s.end, CENTRE_TIME_ZONE),
    summary: s.program,
    ...(detail?.room ? { location: detail.room } : {}),
    ...(description ? { description } : {}),
  };
}
