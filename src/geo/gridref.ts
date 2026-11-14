/**
 * Grid references.
 *  - In Great Britain: British National Grid (OSGB36), e.g. "SU 123 456".
 *  - Elsewhere: MGRS, e.g. "31U DQ 123 456".
 *
 * Figures are truncated, not rounded, as when reading a map: "SU 123 456"
 * means the 100 m square whose south-west corner is at 12300 E, 45600 N.
 *
 * WGS84 → OSGB36 uses proj4's standard 7-parameter transformation, good to
 * about 5 m. That is fine for six- and eight-figure references (100 m and
 * 10 m squares), though an eight-figure reference can be one square out
 * near a square edge. See DECISIONS.md.
 */
import proj4 from 'proj4';

const WGS84 = 'EPSG:4326';
const BNG =
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy ' +
  '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';

export interface EastingNorthing {
  easting: number;
  northing: number;
}

export function toBNG(lat: number, lon: number): EastingNorthing {
  const [easting, northing] = proj4(WGS84, BNG, [lon, lat]);
  return { easting, northing };
}

export function fromBNG(easting: number, northing: number): { lat: number; lon: number } {
  const [lon, lat] = proj4(BNG, WGS84, [easting, northing]);
  return { lat, lon };
}

/**
 * Rough test for Great Britain (including the Isle of Man, Scilly and the
 * Scottish islands), excluding the island of Ireland, which uses its own grid.
 * Approximate at the Irish Sea; good enough to choose a grid system.
 */
export function inGreatBritain(lat: number, lon: number): boolean {
  if (lat < 49.8 || lat > 61 || lon < -8.7 || lon > 1.8) return false;
  const kintyreOrIslands = lat > 55.25 && lon > -6.0;
  const ireland = lat >= 51.4 && lat <= 55.45 && lon < -5.35 && !kintyreOrIslands;
  return !ireland;
}

/** Two-letter 100 km square for a BNG easting/northing, or null if off the grid. */
export function bngSquareLetters(e: number, n: number): string | null {
  if (e < 0 || n < 0 || e >= 700000 || n >= 1300000) return null;
  const e100k = Math.floor(e / 100000);
  const n100k = Math.floor(n / 100000);
  let l1 = 19 - n100k - ((19 - n100k) % 5) + Math.floor((e100k + 10) / 5);
  let l2 = (((19 - n100k) * 5) % 25) + (e100k % 5);
  if (l1 > 7) l1++; // the grid letters skip "I"
  if (l2 > 7) l2++;
  return String.fromCharCode(65 + l1) + String.fromCharCode(65 + l2);
}

/** Truncate a within-square coordinate (0–99999 m) to `digits` figures. */
function figures(v: number, digits: number): string {
  const within = Math.floor(v) % 100000;
  return String(Math.floor(within / 10 ** (5 - digits))).padStart(digits, '0');
}

/** BNG grid reference with 3, 4 or 5 figures each way (six-, eight-, ten-figure). */
export function bngGridRef(e: number, n: number, figuresEach: 3 | 4 | 5 = 3): string | null {
  const sq = bngSquareLetters(e, n);
  if (!sq) return null;
  return `${sq} ${figures(e, figuresEach)} ${figures(n, figuresEach)}`;
}

// ---------- UTM / MGRS ----------

export interface UTM {
  zone: number;
  hemisphere: 'N' | 'S';
  easting: number;
  northing: number;
}

export function utmZone(lat: number, lon: number): number {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  // Exceptions: south-west Norway and Svalbard.
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return zone;
}

export function toUTM(lat: number, lon: number): UTM {
  const zone = utmZone(lat, lon);
  const south = lat < 0;
  const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
  const [easting, northing] = proj4(WGS84, def, [lon, lat]);
  return { zone, hemisphere: south ? 'S' : 'N', easting, northing };
}

export function fromUTM(u: UTM): { lat: number; lon: number } {
  const def = `+proj=utm +zone=${u.zone}${u.hemisphere === 'S' ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
  const [lon, lat] = proj4(def, WGS84, [u.easting, u.northing]);
  return { lat, lon };
}

const BAND_LETTERS = 'CDEFGHJKLMNPQRSTUVWXX';
const COLUMN_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';

/** MGRS reference, e.g. "18S UJ 234 064". Only valid between 80°S and 84°N. */
export function mgrsGridRef(lat: number, lon: number, figuresEach: 3 | 4 | 5 = 3): string | null {
  if (lat < -80 || lat > 84) return null;
  const u = toUTM(lat, lon);
  const band = BAND_LETTERS[Math.floor((lat + 80) / 8)];
  const col = COLUMN_SETS[(u.zone - 1) % 3][Math.floor(u.easting / 100000) - 1];
  const rowIndex = (Math.floor(u.northing / 100000) + (u.zone % 2 === 0 ? 5 : 0)) % 20;
  const row = ROW_LETTERS[rowIndex];
  return `${u.zone}${band} ${col}${row} ${figures(u.easting, figuresEach)} ${figures(u.northing, figuresEach)}`;
}

/** The right grid reference for wherever this is. */
export function gridRef(lat: number, lon: number, figuresEach: 3 | 4 = 3): { system: 'BNG' | 'MGRS'; ref: string } {
  if (inGreatBritain(lat, lon)) {
    const { easting, northing } = toBNG(lat, lon);
    const ref = bngGridRef(easting, northing, figuresEach);
    if (ref) return { system: 'BNG', ref };
  }
  return { system: 'MGRS', ref: mgrsGridRef(lat, lon, figuresEach) ?? 'off grid' };
}
