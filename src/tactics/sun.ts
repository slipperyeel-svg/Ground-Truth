/**
 * Sunrise, sunset and first/last light (civil twilight) for a place and
 * date, using NOAA's simplified solar equations (accurate to a minute or two,
 * which is plenty for a problem's "light remaining").
 */

export interface SunTimes {
  /** All as Date objects (UTC instants); null if the sun does not rise/set that day. */
  firstLight: Date | null;
  sunrise: Date | null;
  sunset: Date | null;
  lastLight: Date | null;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86_400_000) + 1;
}

/** Minutes after UTC midnight when the sun is at `zenithDeg` (rising if `rising`), or null. */
function eventMinutes(lat: number, lon: number, n: number, zenithDeg: number, rising: boolean): number | null {
  const g = ((2 * Math.PI) / 365) * (n - 1);
  const eqtime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosHa = Math.cos(rad(zenithDeg)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl);
  if (cosHa < -1 || cosHa > 1) return null;
  const ha = deg(Math.acos(cosHa));
  return rising ? 720 - 4 * (lon + ha) - eqtime : 720 - 4 * (lon - ha) - eqtime;
}

export function sunTimes(lat: number, lon: number, date: Date): SunTimes {
  const n = dayOfYear(date);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const at = (m: number | null) => (m === null ? null : new Date(midnight + m * 60_000));
  return {
    firstLight: at(eventMinutes(lat, lon, n, 96, true)),
    sunrise: at(eventMinutes(lat, lon, n, 90.833, true)),
    sunset: at(eventMinutes(lat, lon, n, 90.833, false)),
    lastLight: at(eventMinutes(lat, lon, n, 96, false)),
  };
}

/** Military-style local time, e.g. "0612". Uses the device's time zone (the user is at the place). */
export function hhmm(d: Date | null, timeZone?: string): string {
  if (!d) return '—';
  const s = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d);
  return s.replace(':', '');
}
