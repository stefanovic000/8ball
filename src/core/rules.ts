import type { Ball, SimEvent } from './physics';
import { BALL_R, HALF_L, HALF_W, TABLE_L } from './constants';

export type Side = 0 | 1;
export type Group = 'open' | 'solids' | 'stripes';

export type Ruleset = 'european' | 'american';

export type Rules = {
  /**
   * European blackball: two shots after a foul, and a break that must pot or
   * drive two object balls to a cushion. American: ball in hand, one shot.
   */
  ruleset: Ruleset;
  /** Seconds per shot, 0 disables the clock. */
  shotClock: number;
  /** Requires the pocket to be chosen before the shot. */
  calledPockets: boolean;
  ballInHand: 'anywhere' | 'behind';
};

export const DEFAULT_RULES: Rules = {
  ruleset: 'european',
  shotClock: 30,
  calledPockets: false,
  ballInHand: 'behind',
};

export type GameState = {
  balls: Ball[];
  turn: Side;
  groups: [Group, Group];
  /** True until the break shot has been taken. */
  onBreak: boolean;
  ballInHand: boolean;
  /** Pocket the shooter called, if called pockets are on. */
  called: number | null;
  over: { winner: Side; reason: string } | null;
  message: string;
  /** Increments so the UI can tell two "no message" states apart. */
  seq: number;
};

export type ShotOutcome = {
  foul: boolean;
  foulReason: string;
  pocketed: number[];
  cuePocketed: boolean;
  /** Pocketed balls that go back on the table. */
  respot: number[];
  win: Side | null;
  rerack: boolean;
  continues: boolean;
};

export const groupOf = (id: number): Group =>
  id === 0 || id === 8 ? 'open' : id < 8 ? 'solids' : 'stripes';

export const ballsLeft = (balls: Ball[], g: Group): number =>
  balls.filter((b) => !b.pocketed && groupOf(b.id) === g).length;

export const headString = -HALF_L + TABLE_L / 4;

/**
 * Whether ball-in-hand placement is restricted to behind the head string.
 *
 * This is a property of the room's rules alone. It used to be tied to the break
 * on the client, which meant the restriction only ever applied to the opening
 * shot and an ordinary foul let the cue ball be placed anywhere.
 */
export const behindLineOnly = (rules: Rules): boolean => rules.ballInHand === 'behind';

export function newGame(balls: Ball[]): GameState {
  return {
    balls,
    turn: 0,
    groups: ['open', 'open'],
    onBreak: true,
    ballInHand: false,
    called: null,
    over: null,
    message: '',
    seq: 0,
  };
}

function firstCuContact(events: SimEvent[]): { id: number; t: number } | null {
  for (const e of events) {
    if (e.type !== 'ball') continue;
    if (e.a === 0) return { id: e.b, t: e.t };
    if (e.b === 0) return { id: e.a, t: e.t };
  }
  return null;
}

/**
 * Applies a finished shot to the game state.
 *
 * Kept separate from the physics so the rules can be tested without simulating
 * anything - you hand it a list of events and it tells you what the referee
 * would have said.
 */
export function judgeShot(
  state: GameState,
  events: SimEvent[],
  rules: Rules,
): ShotOutcome {
  const pocketed = events.filter((e) => e.type === 'pocket').map((e) => e.id);
  const cuePocketed = pocketed.includes(0);
  const objectPocketed = pocketed.filter((id) => id !== 0);
  const contact = firstCuContact(events);

  const out: ShotOutcome = {
    foul: false,
    foulReason: '',
    pocketed: objectPocketed,
    cuePocketed,
    respot: [],
    win: null,
    rerack: false,
    continues: false,
  };

  const me = state.turn;
  const myGroup = state.groups[me];

  if (state.onBreak) {
    const eight = objectPocketed.includes(8);
    if (eight) {
      out.rerack = true;
      return out;
    }
    if (cuePocketed) {
      out.foul = true;
      out.foulReason = 'scratch on the break';
    } else if (!contact) {
      // A break has to at least reach a ball, whichever ruleset is in play.
      out.foul = true;
      out.foulReason = 'no ball hit on the break';
    } else if (rules.ruleset === 'european' && objectPocketed.length === 0) {
      // Blackball asks more of a break than "something moved".
      const railed = new Set<number>();
      for (const e of events) {
        if (e.type === 'rail' && e.id !== 0) railed.add(e.id);
      }
      if (railed.size < 2) {
        out.foul = true;
        out.foulReason = 'break must pot a ball or drive two to a cushion';
      }
    }
    out.continues = !out.foul && objectPocketed.length > 0;
    return out;
  }

  if (cuePocketed) {
    out.foul = true;
    out.foulReason = 'scratch';
  } else if (!contact) {
    out.foul = true;
    out.foulReason = 'no ball hit';
  } else if (myGroup === 'open') {
    if (contact.id === 8) {
      out.foul = true;
      out.foulReason = 'hit the 8 first on an open table';
    }
  } else if (ballsLeft(state.balls, myGroup) === 0) {
    // Group cleared, so the 8 is the only legal ball.
    if (contact.id !== 8) {
      out.foul = true;
      out.foulReason = 'must hit the 8';
    }
  } else if (myGroup !== groupOf(contact.id)) {
    out.foul = true;
    out.foulReason = 'wrong ball first';
  }

  // After contact something has to reach a cushion, unless a ball dropped.
  if (!out.foul && objectPocketed.length === 0) {
    const railAfter = events.some(
      (e) => e.type === 'rail' && contact !== null && e.t > contact.t,
    );
    if (!railAfter) {
      out.foul = true;
      out.foulReason = 'no rail after contact';
    }
  }

  // The 8 decided the game.
  if (objectPocketed.includes(8)) {
    const cleared = myGroup !== 'open' && ballsLeft(state.balls, myGroup) === 0;
    if (cleared && !out.foul) {
      out.win = me;
    } else {
      out.win = (1 - me) as Side;
    }
    return out;
  }

  if (rules.calledPockets && !out.foul && objectPocketed.length > 0) {
    if (state.called === null) {
      out.foul = true;
      out.foulReason = 'no pocket called';
    }
  }

  // Assign groups on the first legal pot with an open table.
  if (
    !out.foul &&
    myGroup === 'open' &&
    state.groups[1 - me] === 'open' &&
    objectPocketed.length > 0
  ) {
    const g = groupOf(objectPocketed[0]);
    if (g !== 'open') {
      state.groups[me] = g;
      state.groups[1 - me] = g === 'solids' ? 'stripes' : 'solids';
    }
  }

  if (!out.foul) {
    out.continues = objectPocketed.some((id) => {
      const g = groupOf(id);
      return state.groups[me] === 'open' || g === state.groups[me] || id === 8;
    });
  }

  return out;
}

export function applyOutcome(
  state: GameState,
  out: ShotOutcome,
  balls: Ball[],
): void {
  state.balls = balls;
  state.onBreak = false;
  state.seq++;

  if (out.win !== null) {
    state.over = {
      winner: out.win,
      reason: out.win === state.turn ? 'pocketed the 8' : 'pocketed the 8 early',
    };
    return;
  }

  if (out.foul) {
    // A foul is the turn, a ball in hand, and nothing else.
    state.turn = (1 - state.turn) as Side;
    state.ballInHand = true;
    state.message = out.foulReason;
    state.called = null;
    return;
  }

  state.ballInHand = false;
  state.called = null;

  if (!out.continues) {
    state.turn = (1 - state.turn) as Side;
  }
  state.message = '';
}

export function isValidPlacement(
  balls: Ball[],
  x: number,
  y: number,
  allowBehindOnly: boolean,
): boolean {
  if (Math.abs(x) > HALF_L - BALL_R * 1.05 || Math.abs(y) > HALF_W - BALL_R * 1.05) return false;
  if (allowBehindOnly && x > headString) return false;
  for (const b of balls) {
    if (b.id === 0 || b.pocketed) continue;
    if (Math.hypot(b.p.x - x, b.p.y - y) < BALL_R * 2 + 0.001) return false;
  }
  return true;
}

/**
 * Where a potted 8 goes back in Practice: the foot spot if it is free,
 * otherwise the nearest clear point along the long axis. Deterministic, so a
 * repeated shot respots to the same place.
 *
 * The 8 must still be marked pocketed when this is called; the ball being
 * respotted is skipped by `isValidPlacement` either way.
 */
export function respotPoint(balls: Ball[]): { x: number; y: number } {
  const foot = { x: TABLE_L / 4, y: 0 };
  if (isValidPlacement(balls, foot.x, foot.y, false)) return foot;
  for (let i = 1; i <= 60; i++) {
    for (const d of [0.02 * i, -0.02 * i]) {
      const p = { x: foot.x + d, y: foot.y };
      if (isValidPlacement(balls, p.x, p.y, false)) return p;
    }
  }
  return foot;
}
