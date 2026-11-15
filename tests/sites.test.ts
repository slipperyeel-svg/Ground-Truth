import { describe, expect, it } from 'vitest';
import { problemOfTheDay, SITES, ukDay } from '../src/app/sites';

describe('problem of the day', () => {
  it('is the same for everyone on a date, and changes from day to day', () => {
    const a = problemOfTheDay('2026-11-15'), b = problemOfTheDay('2026-11-15'), c = problemOfTheDay('2026-11-16');
    expect(a).toEqual(b);
    expect(c.seed).not.toBe(a.seed);
    expect(SITES).toContain(a.site);
  });
  it('is set for 0700 UK time, winter and summer', () => {
    const hour = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    expect(hour(problemOfTheDay('2026-11-15').now)).toBe('07:00');
    expect(hour(problemOfTheDay('2026-07-01').now)).toBe('07:00');
  });
  it('dates by UK time', () => {
    expect(ukDay(new Date(Date.UTC(2026, 6, 1, 23, 30)))).toBe('2026-07-02'); // 0030 BST
  });
});
