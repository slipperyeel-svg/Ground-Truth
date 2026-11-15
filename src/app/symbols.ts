/**
 * NATO APP-6 unit symbols, drawn with the milsymbol library (PO decision,
 * DECISIONS.md 133) and added to the map as images.
 *
 * Symbol codes are APP-6 D / 2525 D 20-character SIDCs:
 *   version 10 · context 0 (reality) · standard identity (3 friend, 6 hostile) ·
 *   symbol set 10 (land unit) · status (0 present, 1 planned/anticipated/suspected:
 *   a dashed frame) · HQ/dummy (0 none, 1 feint/dummy, 2 HQ) · echelon
 *   (11 team, 13 section, 14 platoon, 15 company) · entity 121100 (infantry) ·
 *   modifiers 0000.
 */
import * as msModule from 'milsymbol';
import type { Map as MapLibreMap } from 'maplibre-gl';

// milsymbol is published as a CommonJS bundle; depending on the bundler its
// functions arrive directly or under "default".
const ms = ((msModule as unknown as { default?: typeof msModule }).default ?? msModule) as typeof msModule;
ms.setStandard('APP6');

export type Identity = 'friend' | 'hostile';
export type Echelon = 'team' | 'section' | 'platoon' | 'company';

const ECHELON: Record<Echelon, string> = { team: '11', section: '13', platoon: '14', company: '15' };

export interface UnitSpec {
  identity: Identity;
  echelon: Echelon;
  hq?: boolean;
  dummy?: boolean;
  /** Suspected (not confirmed): a dashed frame. */
  suspected?: boolean;
}

/** The APP-6 symbol code for an infantry unit. */
export function sidc(u: UnitSpec): string {
  const identity = u.identity === 'friend' ? '3' : '6';
  const status = u.suspected ? '1' : '0';
  const hqDummy = u.dummy && u.hq ? '3' : u.dummy ? '1' : u.hq ? '2' : '0';
  return `100${identity}10${status}${hqDummy}${ECHELON[u.echelon]}1211000000`;
}

/** Add a symbol image to the map (once) and return its name and the offset that puts its anchor on the point. */
export function ensureSymbol(
  map: MapLibreMap,
  u: UnitSpec,
  text: { designation?: string; higher?: string } = {},
): { name: string; offset: [number, number] } {
  const code = sidc(u);
  const name = `app6-${code}-${text.designation ?? ''}-${text.higher ?? ''}`;
  // Only pass labels that exist: milsymbol fails on a label set to undefined.
  const labels: Record<string, string> = {};
  if (text.designation) labels.uniqueDesignation = text.designation;
  if (text.higher) labels.higherFormation = text.higher;
  const sym = new ms.Symbol(code, {
    size: 16,
    // APP-6 colours: friendly blue fill, hostile red fill.
    fill: true,
    frame: true,
    ...labels,
  });
  const a = sym.getAnchor();
  if (!map.hasImage(name)) {
    const canvas = sym.asCanvas(2);
    const ctx = canvas.getContext('2d')!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    map.addImage(name, { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) }, { pixelRatio: 2 });
  }
  return { name, offset: [-a.x, -a.y] };
}
