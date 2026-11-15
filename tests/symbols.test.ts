import { describe, expect, it } from 'vitest';
import { sidc } from '../src/app/symbols';

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
});
