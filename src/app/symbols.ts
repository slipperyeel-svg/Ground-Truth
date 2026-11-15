/**
 * NATO APP-6 unit symbols, drawn with the milsymbol library (PO decision,
 * DECISIONS.md 133) and added to the map as images.
 *
 * Symbol codes are APP-6 D / 2525 D 20-character SIDCs:
 *   version 10 · context 0 (reality) · standard identity (3 friend, 6 hostile) ·
 *   symbol set 10 (land unit) · status (0 present, 1 planned/anticipated/suspected:
 *   a dashed frame) · HQ/dummy (0 none, 1 feint/dummy, 2 HQ) · echelon
 *   (11 team, 13 section, 14 platoon/troop, 15 company/squadron) · entity
 *   (see UNIT_ENTITY: infantry, motorised infantry, armour, recce…) · modifiers 0000.
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

/**
 * Unit types and their APP-6 D land-unit entity codes (checked against milsymbol):
 * infantry 121100 (a cross); motorised infantry 121104 (cross with a vertical
 * line: used for Boxer, PO 15 Nov 2026); armour 120500 (the tank oval);
 * reconnaissance 121300 (one diagonal); motorised recce 121303 (diagonal and
 * vertical line); armoured recce 120501 (oval with a diagonal).
 */
export type UnitKind = 'infantry' | 'motorisedInfantry' | 'armour' | 'recce' | 'motorisedRecce' | 'armouredRecce';
export const UNIT_ENTITY: Record<UnitKind, string> = {
  infantry: '121100',
  motorisedInfantry: '121104',
  armour: '120500',
  recce: '121300',
  motorisedRecce: '121303',
  armouredRecce: '120501',
};

export interface UnitSpec {
  identity: Identity;
  echelon: Echelon;
  /** Default: infantry. */
  kind?: UnitKind;
  hq?: boolean;
  dummy?: boolean;
  /** Suspected (not confirmed): a dashed frame. */
  suspected?: boolean;
}

/** The APP-6 symbol code for a land unit (infantry unless `kind` says otherwise). */
export function sidc(u: UnitSpec): string {
  const identity = u.identity === 'friend' ? '3' : '6';
  const status = u.suspected ? '1' : '0';
  const hqDummy = u.dummy && u.hq ? '3' : u.dummy ? '1' : u.hq ? '2' : '0';
  return `100${identity}10${status}${hqDummy}${ECHELON[u.echelon]}${UNIT_ENTITY[u.kind ?? 'infantry']}0000`;
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
    size: 24,
    // Larger text beside the symbol (designation, higher formation): default 40 (PO, 15 Nov 2026).
    infoSize: 60,
    // APP-6 colours: friendly blue fill, hostile red fill.
    fill: true,
    // A little see-through, so map detail shows behind the symbol (PO, 15 Nov 2026).
    fillOpacity: 0.6,
    frame: true,
    ...labels,
  });
  const a = sym.getAnchor();
  if (!map.hasImage(name)) {
    const canvas = sym.asCanvas(3); // drawn at 3x so it stays sharp when enlarged on zoom
    const ctx = canvas.getContext('2d')!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    map.addImage(name, { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) }, { pixelRatio: 3 });
  }
  return { name, offset: [-a.x, -a.y] };
}

/**
 * APP-6 mine symbols as map images, in hostile red: "mine-unk" (open circle,
 * type not known), "mine-at" (filled circle, anti-tank) and "mine-ap"
 * (filled circle with two whiskers, anti-personnel).
 */
export function addMineImages(map: MapLibreMap): void {
  const ratio = 3, size = 22, r = 6;
  const draw = (name: string, filled: boolean, whiskers: boolean) => {
    if (map.hasImage(name)) return;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size * ratio;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.strokeStyle = ctx.fillStyle = '#c00';
    ctx.lineWidth = 2;
    const cx = size / 2, cy = size / 2 + (whiskers ? 3 : 0);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (filled) ctx.fill(); else { ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fill(); ctx.stroke(); }
    if (whiskers) {
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy - r + 1); ctx.lineTo(cx - 7, cy - r - 5);
      ctx.moveTo(cx + 3, cy - r + 1); ctx.lineTo(cx + 7, cy - r - 5);
      ctx.stroke();
    }
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    map.addImage(name, { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) }, { pixelRatio: ratio });
  };
  draw('mine-unk', false, false);
  draw('mine-at', true, false);
  draw('mine-ap', true, true);
}
