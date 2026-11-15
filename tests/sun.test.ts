import { describe, expect, it } from 'vitest';
import { hhmm, sunTimes } from '../src/tactics/sun';

describe('sun times', () => {
  it('matches published times for Salisbury Plain on 15 Nov 2026 (about 0727 rise, 1620 set GMT)', () => {
    const s = sunTimes(51.25, -1.9, new Date(Date.UTC(2026, 10, 15, 12)));
    expect(hhmm(s.sunrise, 'Europe/London')).toMatch(/^07[23]\d$/);
    expect(hhmm(s.sunset, 'Europe/London')).toMatch(/^16[12]\d$/);
    // First light is about 35–40 minutes before sunrise in November.
    const gap = (s.sunrise!.getTime() - s.firstLight!.getTime()) / 60000;
    expect(gap).toBeGreaterThan(30);
    expect(gap).toBeLessThan(45);
  });

  it('handles midsummer (British Summer Time)', () => {
    const s = sunTimes(51.25, -1.9, new Date(Date.UTC(2026, 5, 21, 12)));
    expect(hhmm(s.sunrise, 'Europe/London')).toMatch(/^04[45]\d$/);
    expect(hhmm(s.sunset, 'Europe/London')).toMatch(/^21[23]\d$/);
  });
});
