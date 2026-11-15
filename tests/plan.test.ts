import { describe, expect, it } from 'vitest';
import * as Plan from '../src/app/plan';

const p = (lat: number, lon: number) => ({ lat, lon });

describe('the user plan', () => {
  it('numbers repeated positions and undoes in order', () => {
    const plan = Plan.emptyPlan();
    Plan.addMark(plan, 'OP', p(51, -1.9));
    Plan.addRoutePoint(plan, p(51.001, -1.9));
    Plan.addMark(plan, 'OP', p(51.002, -1.9));
    expect(plan.marks.map((m) => m.label)).toEqual(['OP', 'OP 2']);
    Plan.undo(plan);
    expect(plan.marks).toHaveLength(1);
    Plan.undo(plan);
    expect(plan.route).toHaveLength(0);
    Plan.undo(plan);
    expect(Plan.isEmpty(plan)).toBe(true);
  });

  it('keeps Undo in step after a position is removed from the list', () => {
    const plan = Plan.emptyPlan();
    Plan.addMark(plan, 'FUP', p(51, -1.9));
    Plan.addRoutePoint(plan, p(51.001, -1.9));
    Plan.addMark(plan, 'Fire support', p(51.002, -1.9));
    Plan.removeMark(plan, 0);
    expect(plan.history).toEqual(['route', 'mark']);
    Plan.undo(plan);
    expect(plan.marks).toHaveLength(0);
    expect(plan.route).toHaveLength(1);
  });

  it('writes a plain-text record with the answers and any facts', () => {
    const plan = Plan.emptyPlan();
    Plan.addRoutePoint(plan, p(51, -1.9));
    Plan.addRoutePoint(plan, p(51.01, -1.9));
    Plan.addMark(plan, 'OP', p(51.01, -1.9));
    plan.answers[0] = 'Left flank, using the dead ground.';
    const text = Plan.planReport({
      title: 'Secure ground beyond',
      problemText: [{ heading: 'Situation', lines: ['The BG is advancing north.'] }],
      questions: ['How will you secure it?', 'Give your outline orders.'],
      questions2: null,
      plan,
      ref: (q) => `${q.lat.toFixed(3)} ${q.lon.toFixed(3)}`,
      facts: { route: ['Your route: 1.1 km long.'], positions: [{ label: 'OP', facts: ['No enemy position could see it.'] }] },
      when: new Date(Date.UTC(2026, 10, 15, 9, 0)),
    });
    expect(text).toMatch(/SITUATION\nThe BG is advancing north\./);
    expect(text).toMatch(/Route: 51\.000 -1\.900 → 51\.010 -1\.900/);
    expect(text).toMatch(/OP: 51\.010 -1\.900/);
    expect(text).toMatch(/1\. How will you secure it\?\nLeft flank, using the dead ground\./);
    expect(text).toMatch(/2\. Give your outline orders\.\n\(no answer\)/);
    expect(text).toMatch(/GROUND TRUTH \(computed facts\)[\s\S]*No enemy position could see it\./);
  });
});
