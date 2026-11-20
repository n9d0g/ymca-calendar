import { renderCalendar } from "./ics.ts";
import type { CalendarEvent } from "./ics.ts";
import { CENTRE_TIME_ZONE, addDays, localDate, mondayOf, zonedToUtc } from "./time.ts";
import { parseWeek, weekUrl } from "./virtuagym.ts";
import type { ListedSession } from "./virtuagym.ts";

/** Fetches a URL and returns its body as text. */
export type Fetcher = (url: string) => Promise<string>;

export interface BuildInput {
  fetch: Fetcher;
  now: Date;
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
}

interface Category {
  eventType: number;
  slug: string;
  name: string;
}

const CATEGORIES: Category[] = [{ eventType: 1, slug: "group-fitness", name: "Group Fitness" }];

/** How often subscribers are asked to re-fetch; matches the publishing schedule. */
const REFRESH_HOURS = 6;

/**
 * Builds one Feed per Category from the Centre's current week on VirtuaGym.
 *
 * Holds back, with a failure alert, if any Category finds no Sessions this week
 * or can't be fetched or parsed: publishing then would wipe subscribers' calendars.
 */
export async function build({ fetch, now }: BuildInput): Promise<BuildResult> {
  const monday = mondayOf(localDate(now, CENTRE_TIME_ZONE));
  const sunday = addDays(monday, 6);

  const feeds: Feed[] = [];
  const empty: string[] = [];
  const errored: Array<{ category: string; error: string }> = [];

  for (const category of CATEGORIES) {
    let sessions: ListedSession[];
    try {
      sessions = parseWeek(await fetch(weekUrl(category.eventType, monday))).filter(
        (s) => s.date >= monday && s.date <= sunday,
      );
    } catch (err) {
      errored.push({ category: category.name, error: errorMessage(err) });
      continue;
    }
    if (sessions.length === 0) {
      empty.push(category.name);
      continue;
    }
    feeds.push({
      slug: category.slug,
      filename: `${category.slug}.ics`,
      ics: renderCalendar({
        name: `YMCA McDonald · ${category.name}`,
        timeZone: CENTRE_TIME_ZONE,
        refreshHours: REFRESH_HOURS,
        stamp: now,
        events: sessions.map(toEvent),
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

  return alerts.length > 0
    ? { decision: "hold-back", feeds: [], alerts }
    : { decision: "publish", feeds, alerts };
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

function toEvent(s: ListedSession): CalendarEvent {
  return {
    uid: `${s.id}@ymca-calendar`,
    start: zonedToUtc(s.date, s.start, CENTRE_TIME_ZONE),
    end: zonedToUtc(s.date, s.end, CENTRE_TIME_ZONE),
    summary: s.program,
    ...(s.leader ? { description: `Leader: ${s.leader}` } : {}),
  };
}
