import { describe, expect, it } from 'vitest';
import { newRack, type SimEvent } from '../src/core/physics';
import {
  DEFAULT_RULES,
  applyOutcome,
  judgeShot,
  newGame,
  type GameState,
  type Group,
} from '../src/core/rules';

const contact = (id: number, t = 0.1): SimEvent => ({
  t,
  type: 'ball',
  a: 0,
  b: id,
  speed: 1,
});
const rail = (id: number, t = 0.2): SimEvent => ({ t, type: 'rail', id, speed: 1 });
const pocket = (id: number, t = 0.3): SimEvent => ({ t, type: 'pocket', id });

function state(groups: [Group, Group] = ['solids', 'stripes'], over: Partial<GameState> = {}) {
  const s = newGame(newRack());
  s.onBreak = false;
  s.groups = groups;
  s.turn = 0;
  return Object.assign(s, over);
}

function clearSolids(s: GameState): GameState {
  for (const b of s.balls) {
    if (b.id >= 1 && b.id <= 7) b.pocketed = true;
  }
  return s;
}

describe('european ruleset', () => {
  const onBreak = () => {
    const s = newGame(newRack());
    s.onBreak = true;
    return s;
  };

  it('fouls a break that neither pots nor drives two balls to a cushion', () => {
    const out = judgeShot(onBreak(), [contact(1), rail(1)], DEFAULT_RULES);
    expect(out.foul).toBe(true);
    expect(out.foulReason).toMatch(/two to a cushion/);
  });

  it('accepts a break that drives two balls to a cushion', () => {
    const out = judgeShot(onBreak(), [contact(1), rail(1), rail(2)], DEFAULT_RULES);
    expect(out.foul).toBe(false);
  });

  it('lets the break off with only one ball moving under american rules', () => {
    const rules = { ...DEFAULT_RULES, ruleset: 'american' as const };
    const out = judgeShot(onBreak(), [contact(1), rail(1)], rules);
    expect(out.foul).toBe(false);
  });

  it('gives the opponent two visits after a foul', () => {
    const s = state();
    const out = judgeShot(s, [contact(1), pocket(0)], DEFAULT_RULES);
    expect(out.foul).toBe(true);
    expect(out.carry).toBe(2);
  });

  it('keeps the turn on the first miss of a carried visit', () => {
    const s = state(['solids', 'stripes'], { carry: 2 });
    const out = judgeShot(s, [contact(1), rail(1)], DEFAULT_RULES);
    applyOutcome(s, out, s.balls);
    expect(s.turn).toBe(0);
    expect(s.carry).toBe(1);
  });

  it('hands the turn over on the second miss', () => {
    const s = state(['solids', 'stripes'], { carry: 1 });
    const out = judgeShot(s, [contact(1), rail(1)], DEFAULT_RULES);
    applyOutcome(s, out, s.balls);
    expect(s.turn).toBe(1);
    expect(s.carry).toBe(0);
  });
});

describe('fouls', () => {
  it('accepts a legal pot', () => {
    const out = judgeShot(state(), [contact(1), pocket(1)], DEFAULT_RULES);
    expect(out.foul).toBe(false);
    expect(out.continues).toBe(true);
  });

  it('flags hitting the wrong group first', () => {
    // A solids player must not hit a stripe first.
    const out = judgeShot(state(), [contact(10), rail(10)], DEFAULT_RULES);
    expect(out.foul).toBe(true);
    expect(out.foulReason).toBe('wrong ball first');
  });

  it('flags a shot that hits nothing', () => {
    const out = judgeShot(state(), [], DEFAULT_RULES);
    expect(out.foul).toBe(true);
    expect(out.foulReason).toBe('no ball hit');
  });

  it('flags a shot with no rail and no pot', () => {
    const out = judgeShot(state(), [contact(2)], DEFAULT_RULES);
    expect(out.foul).toBe(true);
    expect(out.foulReason).toBe('no rail after contact');
  });

  it('accepts a shot that reaches a rail after contact', () => {
    const out = judgeShot(state(), [contact(2), rail(5, 0.5)], DEFAULT_RULES);
    expect(out.foul).toBe(false);
    expect(out.continues).toBe(false);
  });

  it('flags a scratch', () => {
    const out = judgeShot(state(), [contact(1), pocket(0)], DEFAULT_RULES);
    expect(out.foul).toBe(true);
    expect(out.foulReason).toBe('scratch');
  });

  it('does not accept hitting the 8 first on an open table', () => {
    const out = judgeShot(state(['open', 'open']), [contact(8), rail(8)], DEFAULT_RULES);
    expect(out.foul).toBe(true);
  });

  it('requires the 8 once the group is cleared', () => {
    const s = clearSolids(state());
    const wrong = judgeShot(s, [contact(3), rail(3)], DEFAULT_RULES);
    expect(wrong.foul).toBe(true);
    const right = judgeShot(s, [contact(8), pocket(8)], DEFAULT_RULES);
    expect(right.foul).toBe(false);
  });
});

describe('the 8 ball', () => {
  it('wins when the group is already cleared', () => {
    const s = clearSolids(state());
    const out = judgeShot(s, [contact(8), pocket(8)], DEFAULT_RULES);
    expect(out.win).toBe(0);
  });

  it('loses when it goes down early', () => {
    const out = judgeShot(state(), [contact(1), pocket(8)], DEFAULT_RULES);
    expect(out.win).toBe(1);
  });

  it('loses when it goes down on a foul', () => {
    const s = clearSolids(state());
    const out = judgeShot(s, [contact(3), pocket(8)], DEFAULT_RULES);
    expect(out.win).toBe(1);
  });
});

describe('the break', () => {
  it('re-racks if the 8 drops', () => {
    const s = state(['open', 'open'], { onBreak: true });
    const out = judgeShot(s, [contact(1), pocket(8)], DEFAULT_RULES);
    expect(out.rerack).toBe(true);
    expect(out.win).toBe(null);
  });

  it('keeps the table open after a pot', () => {
    const s = state(['open', 'open'], { onBreak: true });
    const out = judgeShot(s, [contact(1), pocket(3)], DEFAULT_RULES);
    expect(out.foul).toBe(false);
    expect(s.groups[0]).toBe('open');
  });
});

describe('groups', () => {
  it('are handed out on the first legal pot', () => {
    const s = state(['open', 'open']);
    judgeShot(s, [contact(9), pocket(9)], DEFAULT_RULES);
    expect(s.groups[0]).toBe('stripes');
    expect(s.groups[1]).toBe('solids');
  });

  it('stay open after a pot on the break', () => {
    const s = state(['open', 'open'], { onBreak: true });
    judgeShot(s, [contact(2), pocket(2)], DEFAULT_RULES);
    expect(s.groups[0]).toBe('open');
  });
});
