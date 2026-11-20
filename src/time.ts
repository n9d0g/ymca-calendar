/** Calendar dates are "YYYY-MM-DD" strings; times of day are "HH:MM" (24-hour). */

export const CENTRE_TIME_ZONE = "America/Toronto";

/** The calendar date in `timeZone` at instant `now`. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** The UTC instant of wall-clock `date` + `time` in `timeZone`. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const asIfUtc = Date.parse(`${date}T${time}:00Z`);
  // Two passes settle the offset correctly on either side of a DST change.
  let utc = asIfUtc - offsetMs(new Date(asIfUtc), timeZone);
  utc = asIfUtc - offsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

function offsetMs(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = name?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0; // "GMT" with no offset
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/** "06:30 am" → "06:30"; "12:15 pm" → "12:15"; "12:00 am" → "00:00". */
export function to24Hour(time12: string): string {
  const m = time12.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) throw new Error(`Unrecognised time: "${time12}"`);
  let hour = Number(m[1]) % 12;
  if (m[3]!.toLowerCase() === "pm") hour += 12;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}
