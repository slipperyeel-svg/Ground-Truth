/**
 * Scenario text for a section defence the user must plan against. A first
 * draft for the PO to review; every fact in it comes from the computed layout.
 *
 * What the user is told about the enemy is a scenario option (PO decision,
 * DECISIONS.md 82): the exact position, the grid square only, or only that
 * the enemy are blocking the advance somewhere ahead.
 */
import type { Grid, Point } from '../terrain/grid';
import { localToLatLon } from '../terrain/elevation';
import { gridRef } from '../geo/gridref';
import { POSTURES, type Intel, type SectionLayout } from './sectionDefence';

export interface SectionScenarioText {
  title: string;
  situation: string;
  enemy: string;
  mission: string;
  requirement: string[];
  timeAllowed: string;
  /** Directing-staff notes: hidden until the user has made their plan. */
  dsNotes: string[];
  dataNote: string;
}

const DIR = (bearing: number) => ['north', 'east', 'south', 'west'][Math.round(bearing / 90) % 4];

function ref(g: Grid, p: Point, figures: 3 | 4 = 3): string {
  const c = g.meta.centre;
  if (!c) return `(${Math.round(p.x)} m E, ${Math.round(p.y)} m N of the centre)`;
  const ll = localToLatLon(c, p.x, p.y);
  return gridRef(ll.lat, ll.lon, figures).ref;
}

/** Four-figure grid square, e.g. "SU 07 51", from a six-figure reference. */
function gridSquare(g: Grid, p: Point): string {
  const six = ref(g, p, 3).split(' ');
  if (six.length === 3) return `${six[0]} ${six[1].slice(0, 2)} ${six[2].slice(0, 2)}`;
  if (six.length === 4) return `${six[0]} ${six[1]} ${six[2].slice(0, 2)} ${six[3].slice(0, 2)}`; // MGRS
  return six.join(' ');
}

export function writeSectionScenario(g: Grid, s: SectionLayout, intel: Intel, start: Point = { x: 0, y: 0 }): SectionScenarioText {
  const spec = POSTURES[s.posture];
  const dir = DIR(s.advanceBearingDeg);
  const from = DIR((s.advanceBearingDeg + 180) % 360);
  const along = s.routeKind === 'road' ? 'along the road' : s.routeKind === 'track' ? 'along the track' : 'across country';
  const strength = `an enemy section (about ${spec.strength} men with a machine gun)`;

  const enemy =
    intel === 'exact'
      ? `${cap(strength)} is ${spec.description} at ${ref(g, s.position)}, facing ${from}, to block movement ${dir}.`
      : intel === 'area'
        ? `${cap(strength)} is believed to be ${spec.description} in grid square ${gridSquare(g, s.position)}, to block movement ${dir}.`
        : `Enemy are believed to be blocking movement ${dir} somewhere ahead of you. Strength unknown: probably a section.`;

  const requirement = [
    ...(intel === 'exact' ? [] : ['Decide where the enemy section is most likely to be, and why. Walk to where you could see it from.']),
    'Choose your forming-up point, your fire support position and your assault route, and walk the route you would use.',
    'Identify the dead ground you will use, and where your platoon will be exposed to the enemy.',
    'Give your outline orders for the attack.',
  ];

  const ds: string[] = [];
  ds.push(`Enemy section (${spec.label.toLowerCase()}) centred at ${ref(g, s.position, 4)}.`);
  for (const t of s.teams) ds.push(`${t.label}: ${ref(g, t.point, 4)}.`);
  ds.push(...s.reasons);
  if (s.alternatives.length) {
    ds.push(`Other good positions the enemy could have used: ${s.alternatives.map((a) => ref(g, a.point)).join('; ')}.`);
  }
  ds.push(`How the direction was chosen: ${s.log.join(' ')}`);

  const m = g.meta;
  const dataNote =
    `Ground: ${m.source}, about ${m.sourceResolutionM} m. Enemy layout computed from the ground, the mapped features and ` +
    `line of sight (analysed at ${s.maskCellM} m); its scoring weights are first guesses. ` +
    'Check access on the ground before walking to any position.';

  return {
    title: `Section defence — your platoon advancing ${dir}`,
    situation: `Your platoon is advancing ${dir} ${along} from ${ref(g, start)}.`,
    enemy,
    mission: `Clear the enemy to allow the advance to continue ${dir}.`,
    requirement,
    timeAllowed: '30 minutes.',
    dsNotes: ds,
    dataNote,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
