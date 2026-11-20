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

export interface BuildResult {
  feeds: Feed[];
}

interface Category {
  eventType: number;
  slug: string;
  name: string;
}

const CATEGORIES: Category[] = [{ eventType: 1, slug: "group-fitness", name: "Group Fitness" }];

/** How often subscribers are asked to re-fetch; matches the publishing schedule. */
const REFRESH_HOURS = 6;

/** Builds one Feed per Category from the Centre's current week on VirtuaGym. */
export async function build({ fetch, now }: BuildInput): Promise<BuildResult> {
  const monday = mondayOf(localDate(now, CENTRE_TIME_ZONE));
  const sunday = addDays(monday, 6);

  const feeds: Feed[] = [];
  for (const category of CATEGORIES) {
    const sessions = parseWeek(await fetch(weekUrl(category.eventType, monday))).filter(
      (s) => s.date >= monday && s.date <= sunday,
    );
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
  return { feeds };
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
