import * as cheerio from "cheerio";
import { to24Hour } from "./time.ts";

/** McDonald Family YMCA's VirtuaGym club id (see ADR-0001). */
export const CLUB_ID = "90765";
const ORIGIN = "https://ymcamcdonald.virtuagym.com";

/** A Session as listed on a VirtuaGym week page. */
export interface ListedSession {
  /** VirtuaGym's per-occurrence Session ID. */
  id: string;
  program: string;
  date: string; // YYYY-MM-DD, Centre-local
  start: string; // HH:MM, Centre-local
  end: string; // HH:MM, Centre-local
  leader: string | null;
}

export function weekUrl(eventType: number, monday: string): string {
  return `${ORIGIN}/classes/week/${monday}?event_type=${eventType}&embedded=1&pref_club=${CLUB_ID}`;
}

/** Parses the Sessions on a week page, skipping the empty filler slots VirtuaGym pads columns with. */
export function parseWeek(html: string): ListedSession[] {
  const $ = cheerio.load(html);
  const sessions: ListedSession[] = [];
  $("div.class[id]").each((_, el) => {
    const node = $(el);
    const id = node.attr("id")?.trim() ?? "";
    const program = node.find(".classname").first().text().trim();
    if (!id || !program) return;

    const day = node.attr("class")?.match(/internal-event-day-(\d{2})-(\d{2})-(\d{4})/);
    if (!day) throw new Error(`Session ${id} has no day marker`);
    const [start, end] = node.find(".time").first().text().split("-").map((t) => to24Hour(t));
    if (!start || !end) throw new Error(`Session ${id} has no time range`);

    const leader = node.find(".instructor").first().text().trim();
    sessions.push({
      id,
      program,
      date: `${day[3]}-${day[2]}-${day[1]}`,
      start,
      end,
      leader: leader || null,
    });
  });
  return sessions;
}
