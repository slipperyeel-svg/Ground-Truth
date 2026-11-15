/**
 * Well-known training ground for problems set away from where the user is: the
 * Quick problem (read and answer at a desk) and the Problem of the day (the
 * same for everyone on a given date). All in England, so the 5 m LIDAR covers
 * them. First list (PO, 15 Nov 2026): PO to add or change sites.
 */
export interface Site {
  name: string;
  lat: number;
  lon: number;
}

export const SITES: Site[] = [
  { name: 'Westdown, Salisbury Plain', lat: 51.2541, lon: -1.9075 },
  { name: 'Larkhill, Salisbury Plain', lat: 51.2, lon: -1.85 },
  { name: 'Imber, Salisbury Plain', lat: 51.2365, lon: -2.0505 },
  { name: 'Sidbury Hill, Salisbury Plain', lat: 51.2575, lon: -1.6905 },
  { name: 'Copehill Down, Salisbury Plain', lat: 51.2105, lon: -1.9655 },
  { name: 'Otterburn ranges, Northumberland', lat: 55.27, lon: -2.2 },
  { name: 'Catterick training area, North Yorkshire', lat: 54.355, lon: -1.85 },
];

/** A whole number from a day's date (e.g. "2026-11-15"), the same on every device. */
export function dateSeed(day: string): number {
  let h = 2166136261;
  for (const ch of day) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h >>> 0;
}

/** Today's date in the UK, as YYYY-MM-DD: the Problem of the day changes at midnight UK time. */
export function ukDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The Problem of the day: the site, the seed and the time it is set for (0700 UK time). */
export function problemOfTheDay(day: string): { site: Site; seed: number; now: number } {
  const seed = dateSeed(day);
  const site = SITES[seed % SITES.length];
  // 0700 UK time on that day: 0700 UTC in winter, 0600 UTC in summer.
  const [y, m, d] = day.split('-').map(Number);
  const utc7 = Date.UTC(y, m - 1, d, 7);
  const ukHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(new Date(utc7)));
  return { site, seed, now: utc7 - (ukHour - 7) * 3_600_000 };
}
