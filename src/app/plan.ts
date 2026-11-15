/**
 * The user's plan for a problem (PO, 15 Nov 2026): a route, marked positions
 * and written answers. Kept on the phone (browser storage) so a reload or a
 * long walk does not lose it, and exportable as plain text for an instructor
 * or syndicate.
 */

import type { DevelopedSituation } from '../tactics/planEvents';

export type LatLon = { lat: number; lon: number };

export interface PlanMarkLL extends LatLon {
  kind: string;
  label: string;
}

export interface PlanState {
  route: LatLon[];
  marks: PlanMarkLL[];
  /** Answers to the requirement questions, in order. */
  answers: string[];
  /** Answers to the questions when the situation develops. */
  answers2: string[];
  /** What was added, in order, for Undo. */
  history: ('route' | 'mark')[];
  /** The situation as it developed on the route marked (worked out once, then fixed). */
  developed?: DevelopedSituation;
}

/** Enough to set exactly the same problem again (same ground, enemy, task and times). */
export interface ProblemKey {
  lat: number;
  lon: number;
  seed: number;
  task: string;
  info: string;
  detail: string;
  /** The "now" the problem was written for (ms since 1970). */
  now: number;
}

export interface SavedPlan {
  v: 1;
  problem: ProblemKey;
  plan: PlanState;
  savedAt: number;
}

export const emptyPlan = (): PlanState => ({ route: [], marks: [], answers: [], answers2: [], history: [] });

const KEY = 'ground-truth.plan.v1';

export function savePlan(problem: ProblemKey, plan: PlanState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, problem, plan, savedAt: Date.now() } satisfies SavedPlan));
  } catch {
    // Storage blocked (private browsing etc.): the plan still works, it just is not kept.
  }
}

export function loadSavedPlan(): SavedPlan | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedPlan;
    return s && s.v === 1 && s.problem && s.plan ? s : null;
  } catch {
    return null;
  }
}

/** Label for a new mark: "OP", then "OP 2", "OP 3"… */
export function nextLabel(plan: PlanState, kind: string): string {
  const n = plan.marks.filter((m) => m.kind === kind).length;
  return n ? `${kind} ${n + 1}` : kind;
}

export function addRoutePoint(plan: PlanState, p: LatLon): void {
  plan.route.push({ lat: p.lat, lon: p.lon });
  plan.history.push('route');
}

export function addMark(plan: PlanState, kind: string, p: LatLon): PlanMarkLL {
  const m = { kind, label: nextLabel(plan, kind), lat: p.lat, lon: p.lon };
  plan.marks.push(m);
  plan.history.push('mark');
  return m;
}

export function undo(plan: PlanState): void {
  const last = plan.history.pop();
  if (last === 'route') plan.route.pop();
  else if (last === 'mark') plan.marks.pop();
}

export function removeMark(plan: PlanState, index: number): void {
  plan.marks.splice(index, 1);
  // Drop the matching history entry (the index-th 'mark') so Undo stays in step.
  let seen = -1;
  const h = plan.history.findIndex((x) => x === 'mark' && ++seen === index);
  if (h >= 0) plan.history.splice(h, 1);
}

export function isEmpty(plan: PlanState): boolean {
  return !plan.route.length && !plan.marks.length && !plan.answers.some((a) => a.trim()) && !plan.answers2.some((a) => a.trim());
}

/** The plan as a plain-text record, with the problem it answers. */
export function planReport(args: {
  title: string;
  problemText: { heading: string; lines: string[] }[];
  questions: string[];
  questions2: string[] | null;
  plan: PlanState;
  ref: (p: LatLon) => string;
  facts: { route: string[]; positions: { label: string; facts: string[] }[] } | null;
  when: Date;
}): string {
  const { plan, ref } = args;
  const out: string[] = [];
  out.push(`GROUND TRUTH: ${args.title}`);
  out.push(`Recorded ${args.when.toLocaleString('en-GB')}`);
  out.push('');
  for (const block of args.problemText) {
    out.push(block.heading.toUpperCase());
    for (const l of block.lines) out.push(l);
    out.push('');
  }
  out.push('MY PLAN');
  if (plan.route.length) out.push(`Route: ${plan.route.map(ref).join(' → ')}`);
  else out.push('Route: not marked');
  if (plan.marks.length) for (const m of plan.marks) out.push(`${m.label}: ${ref(m)}`);
  else out.push('Positions: none marked');
  out.push('');
  out.push('MY ANSWERS');
  args.questions.forEach((q, i) => {
    out.push(`${i + 1}. ${q}`);
    out.push(plan.answers[i]?.trim() || '(no answer)');
    out.push('');
  });
  if (args.questions2) {
    out.push('WHEN THE SITUATION DEVELOPED');
    args.questions2.forEach((q, i) => {
      out.push(`${i + 1}. ${q}`);
      out.push(plan.answers2[i]?.trim() || '(no answer)');
      out.push('');
    });
  }
  if (args.facts) {
    out.push('MY PLAN AGAINST THE GROUND TRUTH (computed facts)');
    for (const f of args.facts.route) out.push(f);
    for (const p of args.facts.positions) {
      out.push(`${p.label}:`);
      for (const f of p.facts) out.push(`  ${f}`);
    }
    out.push('');
  }
  return out.join('\n');
}
