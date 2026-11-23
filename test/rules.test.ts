import { describe, expect, it } from 'vitest';
import { newRack, type SimEvent } from '../src/core/physics';
import {
  DEFAULT_RULES,
  applyOutcome,
  isValidPlacement,
  judgeShot,
  newGame,
  respotPoint,
  type GameState,
  type Group,
} from '../src/core/rules';
import { BALL_R, TABLE_L } from '../src/core/constants';

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

  it('gives the turn and a ball in hand after a foul, nothing more', () => {
    const s = state();
    const out = judgeShot(s, [contact(1), pocket(0)], DEFAULT_RULES);
    expect(out.foul).toBe(true);
    applyOutcome(s, out, s.balls);
    expect(s.turn).toBe(1);
    expect(s.ballInHand).toBe(true);
  });

  it('does not give the opponent a second shot for the same foul', () => {
    // A foul costs the turn once. The next visit is a normal single shot.
    const s = state();
    const foul = judgeShot(s, [contact(1), pocket(0)], DEFAULT_RULES);
    applyOutcome(s, foul, s.balls);
    expect(s.turn).toBe(1);

    const miss = judgeShot(s, [contact(1), rail(1)], DEFAULT_RULES);
    applyOutcome(s, miss, s.balls);
    expect(s.turn).toBe(0);
  });
});

describe('breaks and respot', () => {
  const breakState = () => {
    const s = newGame(newRack());
    s.onBreak = true;
    return s;
  };

  it('fouls an american break that hits nothing', () => {
    const out = judgeShot(breakState(), [], { ...DEFAULT_RULES, ruleset: 'american' });
    expect(out.foul).toBe(true);
    expect(out.foulReason).toMatch(/no ball hit/);
  });

  it('still lets an american break off with contact and no pot', () => {
    const out = judgeShot(breakState(), [contact(1), rail(1)], {
      ...DEFAULT_RULES,
      ruleset: 'american',
    });
    expect(out.foul).toBe(false);
  });

  it('res pots the 8 on the foot spot when it is free', () => {
    const balls = newRack();
    // The rack's apex sits on the foot spot, so clear the table first.
    for (const b of balls) if (b.id !== 0) b.pocketed = true;
    const spot = respotPoint(balls);
    expect(spot.x).toBeCloseTo(TABLE_L / 4, 6);
    expect(spot.y).toBeCloseTo(0, 6);
    expect(isValidPlacement(balls, spot.x, spot.y, false)).toBe(true);
  });

  it('finds a clear respot when the foot spot is taken', () => {
    const balls = newRack();
    for (const b of balls) if (b.id !== 0) b.pocketed = true;
    const blocker = balls.find((b) => b.id === 1)!;
    blocker.pocketed = false;
    blocker.p = { x: TABLE_L / 4, y: 0 };
    const spot = respotPoint(balls);
    expect(Math.hypot(spot.x - blocker.p.x, spot.y - blocker.p.y)).toBeGreaterThanOrEqual(
      BALL_R * 2,
    );
    expect(isValidPlacement(balls, spot.x, spot.y, false)).toBe(true);
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
