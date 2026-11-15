import { describe, expect, it } from 'vitest';
import { sidc, UNIT_ENTITY, type UnitKind } from '../src/app/symbols';
import * as msModule from 'milsymbol';

const ms = ((msModule as unknown as { default?: typeof msModule }).default ?? msModule) as typeof msModule;
ms.setStandard('APP6');

describe('APP-6 symbol codes', () => {
  it('codes friendly and hostile infantry at each echelon', () => {
    expect(sidc({ identity: 'friend', echelon: 'platoon' })).toBe('10031000141211000000');
    expect(sidc({ identity: 'hostile', echelon: 'section' })).toBe('10061000131211000000');
    expect(sidc({ identity: 'hostile', echelon: 'team' })).toBe('10061000111211000000');
  });
  it('marks suspected (dashed frame), dummies and headquarters', () => {
    expect(sidc({ identity: 'hostile', echelon: 'section', suspected: true })).toBe('10061010131211000000');
    expect(sidc({ identity: 'hostile', echelon: 'section', dummy: true })).toBe('10061001131211000000');
    expect(sidc({ identity: 'friend', echelon: 'company', hq: true })).toBe('10031002151211000000');
  });
  it('every code is 20 characters', () => {
    for (const echelon of ['team', 'section', 'platoon', 'company'] as const) expect(sidc({ identity: 'friend', echelon })).toHaveLength(20);
  });
  it('codes mechanised infantry (Boxer), motorised infantry, armour and recce', () => {
    expect(sidc({ identity: 'friend', echelon: 'platoon', kind: 'mechanisedInfantry' })).toBe('10031000141211020000');
    expect(sidc({ identity: 'friend', echelon: 'platoon', kind: 'motorisedInfantry' })).toBe('10031000141211040000');
    expect(sidc({ identity: 'friend', echelon: 'company', kind: 'armour' })).toBe('10031000151205000000');
    expect(sidc({ identity: 'hostile', echelon: 'platoon', kind: 'recce' })).toBe('10061000141213000000');
    expect(sidc({ identity: 'friend', echelon: 'platoon', kind: 'motorisedRecce' })).toBe('10031000141213030000');
    expect(sidc({ identity: 'friend', echelon: 'platoon', kind: 'armouredRecce' })).toBe('10031000141205010000');
  });
  it('the symbol library accepts every unit type', () => {
    for (const kind of Object.keys(UNIT_ENTITY) as UnitKind[])
      for (const identity of ['friend', 'hostile'] as const)
        expect(new ms.Symbol(sidc({ identity, echelon: 'platoon', kind })).isValid()).toBe(true);
  });
});
