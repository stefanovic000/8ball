import {
  BALL_I,
  BALL_M,
  BALL_R,
  E_BALL,
  E_RAIL,
  G,
  MAX_CUE_SPEED,
  MU_BALL,
  MU_RAIL,
  MU_ROLL,
  MU_SLIDE,
  RAIL_H,
  REST_V,
  REST_W,
  SIM_MAX_STEPS,
  SIM_MAX_TIME,
  SLIP_EPS,
  SPIN_DECAY_TAU,
  SQUIRT_PER_R,
} from './constants';
import {
  clamp,
  cross3,
  dot3,
  len3,
  qIdentity,
  qIntegrate,
  rot2,
  scale3,
  sub3,
  v3,
  add3,
  type Quat,
  type V2,
  type V3,
} from './math';
import { CUSHIONS, JAWS, JAW_RADIUS, leftTheTable, type Cushion } from './table';

export type Ball = {
  id: number; // 0 is the cue ball
  p: V2;
  v: V2;
  w: V3;
  /** Orientation. Purely visual, but the renderer needs it. */
  q: Quat;
  rolling: boolean;
  pocketed: boolean;
};

export type SimEvent =
  | { t: number; type: 'ball'; a: number; b: number; speed: number }
  | { t: number; type: 'rail'; id: number; speed: number }
  | { t: number; type: 'jaw'; id: number; speed: number }
  | { t: number; type: 'pocket'; id: number };

/**
 * One recorded moment of the table, used for playback.
 *
 * The simulation runs in one go and the client replays the frames afterwards
 * rather than stepping the physics per animation frame. Same numbers both
 * times, and playback speed is independent of the physics.
 */
export type Frame = {
  t: number;
  /** Per ball: x, y, quaternion xyzw. */
  data: Float32Array;
  /** Bit i set means ball i is off the table. */
  pocketed: number;
};

export type Shot = {
  /** Radians. Direction the cue is pointing. */
  aim: number;
  /** 0..1 */
  power: number;
  /** Tip offset in units of the ball radius. x = side, y = vertical. */
  spin: V2;
};

export const makeBall = (id: number, x: number, y: number): Ball => ({
  id,
  p: { x, y },
  v: { x: 0, y: 0 },
  w: { x: 0, y: 0, z: 0 },
  q: qIdentity(),
  rolling: true,
  pocketed: false,
});

const RACK_SPACING = 2 * BALL_R + 0.0004;

/**
 * Standard 8-ball rack: 1 on the apex, 8 in the middle, one solid and one
 * stripe in the back corners.
 */
export function newRack(): Ball[] {
  const layout = [
    [1],
    [2, 9],
    [10, 8, 3],
    [11, 4, 12, 5],
    [6, 13, 7, 14, 15],
  ];
  const balls: Ball[] = [makeBall(0, -0.635, 0)];
  const dx = RACK_SPACING * Math.sqrt(3) * 0.5;
  const apexX = 0.635;
  let row = 0;
  for (const line of layout) {
    for (let i = 0; i < line.length; i++) {
      const x = apexX + row * dx;
      const y = (i - (line.length - 1) / 2) * RACK_SPACING;
      balls.push(makeBall(line[i], x, y));
    }
    row++;
  }
  return balls;
}

export function cloneBalls(balls: Ball[]): Ball[] {
  return balls.map((b) => ({
    id: b.id,
    p: { ...b.p },
    v: { ...b.v },
    w: { ...b.w },
    q: { ...b.q },
    rolling: b.rolling,
    pocketed: b.pocketed,
  }));
}

/** Contact point velocity, projected onto the cloth. Slow slip means rolling. */
function slip(b: Ball): V2 {
  return { x: b.v.x - b.w.y * BALL_R, y: b.v.y + b.w.x * BALL_R };
}

function slipSpeed(b: Ball): number {
  const u = slip(b);
  return Math.hypot(u.x, u.y);
}

function atRest(b: Ball): boolean {
  return (
    Math.hypot(b.v.x, b.v.y) < REST_V &&
    slipSpeed(b) < REST_V &&
    Math.abs(b.w.z) < REST_W
  );
}

/**
 * Cue strike.
 *
 * One impulse at an offset contact point produces both the linear velocity and
 * the spin. Nothing is faked on top: hitting above centre really does leave the
 * ball with more spin than rolling needs, which is why it then runs forward.
 */
export function applyShot(cue: Ball, shot: Shot): void {
  const power = clamp(shot.power, 0, 1);
  let a = clamp(shot.spin.x, -0.5, 0.5);
  let b = clamp(shot.spin.y, -0.5, 0.5);
  const off = Math.hypot(a, b);
  if (off > 0.5) {
    // miscue limit: the tip would slide off the ball
    a = (a / off) * 0.5;
    b = (b / off) * 0.5;
  }

  const speed = MAX_CUE_SPEED * power;
  const d: V2 = { x: Math.cos(shot.aim), y: Math.sin(shot.aim) };
  const side: V2 = { x: -d.y, y: d.x };

  const A = a * BALL_R;
  const B = b * BALL_R;
  const h = Math.sqrt(Math.max(0, BALL_R * BALL_R - A * A - B * B));

  // Contact point on the back of the ball, in world space.
  const c = v3(-d.x * h + side.x * A, -d.y * h + side.y * A, B);

  const j = BALL_M * speed;
  const J = v3(d.x * j, d.y * j, 0);

  cue.v = { x: d.x * speed, y: d.y * speed };
  cue.w = scale3(cross3(c, J), 1 / BALL_I);
  cue.rolling = false;

  // Squirt: the tip shoves the ball off-line in the opposite direction to the
  // side of the tip offset. About 3 degrees at maximum english.
  cue.v = rot2(cue.v, -a * SQUIRT_PER_R);
}

function integrateBall(b: Ball, dt: number): void {
  const u = slip(b);
  const us = Math.hypot(u.x, u.y);

  // Sliding or rolling is derived from the slip, never trusted from the flag.
  // A collision can change velocity in an instant while the spin stays put,
  // and that is exactly the moment a ball starts sliding again.
  if (us > SLIP_EPS) {
    b.rolling = false;
    const ax = (-MU_SLIDE * G * u.x) / us;
    const ay = (-MU_SLIDE * G * u.y) / us;
    b.p.x += b.v.x * dt + 0.5 * ax * dt * dt;
    b.p.y += b.v.y * dt + 0.5 * ay * dt * dt;
    b.v.x += ax * dt;
    b.v.y += ay * dt;

    // Torque = r x F with r straight down, so only x and y spin change.
    const fx = BALL_M * ax;
    const fy = BALL_M * ay;
    b.w.x += ((BALL_R * fy) / BALL_I) * dt;
    b.w.y += ((-BALL_R * fx) / BALL_I) * dt;
  } else {
    b.rolling = true;
    const s = Math.hypot(b.v.x, b.v.y);
    if (s > 1e-9) {
      const ax = (-MU_ROLL * G * b.v.x) / s;
      const ay = (-MU_ROLL * G * b.v.y) / s;
      const ox = b.v.x;
      const oy = b.v.y;
      b.p.x += b.v.x * dt + 0.5 * ax * dt * dt;
      b.p.y += b.v.y * dt + 0.5 * ay * dt * dt;
      b.v.x += ax * dt;
      b.v.y += ay * dt;
      if (b.v.x * ox + b.v.y * oy <= 0) {
        b.v.x = 0;
        b.v.y = 0;
      }
    }
    b.w.x = -b.v.y / BALL_R;
    b.w.y = b.v.x / BALL_R;
    b.w.z *= Math.exp(-dt / SPIN_DECAY_TAU);
  }

  if (slipSpeed(b) < SLIP_EPS * 4) {
    b.rolling = true;
    b.w.x = -b.v.y / BALL_R;
    b.w.y = b.v.x / BALL_R;
  }

  b.q = qIntegrate(b.q, b.w, dt);
}

function timeToPhaseChange(b: Ball): number {
  const us = slipSpeed(b);
  if (us > SLIP_EPS) {
    return us / (3.5 * MU_SLIDE * G);
  }
  const s = Math.hypot(b.v.x, b.v.y);
  if (s > REST_V) return s / (MU_ROLL * G);
  if (Math.abs(b.w.z) > REST_W) {
    return Math.max(1e-3, SPIN_DECAY_TAU * Math.log(Math.abs(b.w.z) / REST_W));
  }
  return Infinity;
}

function cushionSpan(c: Cushion, x: number, y: number): number {
  const ex = c.bx - c.ax;
  const ey = c.by - c.ay;
  return ((x - c.ax) * ex + (y - c.ay) * ey) / (ex * ex + ey * ey);
}

/** Time until the ball reaches a cushion plane, ignoring deceleration (safe). */
function timeToRail(b: Ball, c: Cushion): number {
  const s = (b.p.x - c.ax) * c.nx + (b.p.y - c.ay) * c.ny;
  const vn = b.v.x * c.nx + b.v.y * c.ny;
  if (vn >= -1e-9) return Infinity;
  if (s < BALL_R - 1e-6) return Infinity;
  const t = (s - BALL_R) / -vn;
  if (t <= 0) return Infinity;
  const px = b.p.x + b.v.x * t;
  const py = b.p.y + b.v.y * t;
  const span = cushionSpan(c, px, py);
  if (span < -0.02 || span > 1.02) return Infinity;
  return t;
}

function timeToJaw(b: Ball, j: V2): number {
  const dx = b.p.x - j.x;
  const dy = b.p.y - j.y;
  const dist = Math.hypot(dx, dy);
  const rr = BALL_R + JAW_RADIUS;
  if (dist <= rr) return Infinity;
  const closing = -(dx * b.v.x + dy * b.v.y) / dist;
  if (closing <= 1e-9) return Infinity;
  return (dist - rr) / closing;
}

function timeToBall(a: Ball, b: Ball): number {
  const dx = b.p.x - a.p.x;
  const dy = b.p.y - a.p.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 2 * BALL_R) return Infinity;
  const rvx = b.v.x - a.v.x;
  const rvy = b.v.y - a.v.y;
  const closing = -(dx * rvx + dy * rvy) / dist;
  if (closing <= 1e-9) return Infinity;
  return (dist - 2 * BALL_R) / closing;
}

/**
 * Impulse resolution.
 *
 * The normal impulse runs through both centres, so it cannot change spin. All
 * of the interesting behaviour - throw, spin transfer, english off a rail -
 * comes from the tangential friction impulse below it.
 */
function resolveBallBall(a: Ball, b: Ball, ev: SimEvent[], t: number): boolean {
  const dx = b.p.x - a.p.x;
  const dy = b.p.y - a.p.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= 2 * BALL_R - 1e-7) return false;

  const nx = dist > 1e-9 ? dx / dist : 1;
  const ny = dist > 1e-9 ? dy / dist : 0;
  const pen = 2 * BALL_R - dist;
  a.p.x -= nx * pen * 0.5;
  a.p.y -= ny * pen * 0.5;
  b.p.x += nx * pen * 0.5;
  b.p.y += ny * pen * 0.5;

  const n3 = v3(nx, ny, 0);
  const ca = v3(nx * BALL_R, ny * BALL_R, 0);
  const cb = v3(-nx * BALL_R, -ny * BALL_R, 0);

  const va = add3(v3(a.v.x, a.v.y, 0), cross3(a.w, ca));
  const vb = add3(v3(b.v.x, b.v.y, 0), cross3(b.w, cb));
  const ur = sub3(vb, va);
  const vn = dot3(ur, n3);
  if (vn > 0) return false;

  const k = 2 / BALL_M;
  const jn = (-(1 + E_BALL) * vn) / k;

  a.v.x -= (nx * jn) / BALL_M;
  a.v.y -= (ny * jn) / BALL_M;
  b.v.x += (nx * jn) / BALL_M;
  b.v.y += (ny * jn) / BALL_M;

  // Tangential.
  const va2 = add3(v3(a.v.x, a.v.y, 0), cross3(a.w, ca));
  const vb2 = add3(v3(b.v.x, b.v.y, 0), cross3(b.w, cb));
  const ur2 = sub3(vb2, va2);
  const tvec = sub3(ur2, scale3(n3, dot3(ur2, n3)));
  const ts = len3(tvec);
  if (ts > 1e-7) {
    const th = scale3(tvec, 1 / ts);
    const ra = cross3(ca, th);
    const rb = cross3(cb, th);
    const kt = 2 / BALL_M + dot3(ra, ra) / BALL_I + dot3(rb, rb) / BALL_I;
    let jt = -ts / kt;
    const max = MU_BALL * Math.abs(jn);
    if (jt < -max) jt = -max;
    const J = scale3(th, jt);
    a.v.x -= J.x / BALL_M;
    a.v.y -= J.y / BALL_M;
    b.v.x += J.x / BALL_M;
    b.v.y += J.y / BALL_M;
    a.w = add3(a.w, scale3(cross3(ca, J), -1 / BALL_I));
    b.w = add3(b.w, scale3(cross3(cb, J), 1 / BALL_I));
  }

  ev.push({
    t,
    type: 'ball',
    a: a.id,
    b: b.id,
    speed: (Math.abs(vn) + ts) * 1,
  });
  return true;
}

function resolveCushion(b: Ball, c: Cushion, ev: SimEvent[], t: number): boolean {
  const s = (b.p.x - c.ax) * c.nx + (b.p.y - c.ay) * c.ny;
  if (s >= BALL_R - 1e-7) return false;
  const span = cushionSpan(c, b.p.x, b.p.y);
  if (span < -0.02 || span > 1.02) return false;

  b.p.x += c.nx * (BALL_R - s);
  b.p.y += c.ny * (BALL_R - s);

  const cp = v3(-c.nx * BALL_R, -c.ny * BALL_R, RAIL_H);
  const n3 = v3(c.nx, c.ny, 0);
  const u = add3(v3(b.v.x, b.v.y, 0), cross3(b.w, cp));
  const vn = dot3(u, n3);
  if (vn >= 0) return false;

  const rn = cross3(cp, n3);
  const k = 1 / BALL_M + dot3(rn, rn) / BALL_I;
  const jn = (-(1 + E_RAIL) * vn) / k;
  const J = scale3(n3, jn);
  b.v.x += J.x / BALL_M;
  b.v.y += J.y / BALL_M;
  b.w = add3(b.w, scale3(cross3(cp, J), 1 / BALL_I));

  const u2 = add3(v3(b.v.x, b.v.y, 0), cross3(b.w, cp));
  const tvec = sub3(u2, scale3(n3, dot3(u2, n3)));
  const ts = len3(tvec);
  if (ts > 1e-7) {
    const th = scale3(tvec, 1 / ts);
    const rt = cross3(cp, th);
    const kt = 1 / BALL_M + dot3(rt, rt) / BALL_I;
    let jt = -ts / kt;
    const max = MU_RAIL * Math.abs(jn);
    if (jt < -max) jt = -max;
    const Jt = scale3(th, jt);
    b.v.x += Jt.x / BALL_M;
    b.v.y += Jt.y / BALL_M;
    b.w = add3(b.w, scale3(cross3(cp, Jt), 1 / BALL_I));
  }

  ev.push({ t, type: 'rail', id: b.id, speed: Math.abs(vn) });
  return true;
}

function resolveJaw(b: Ball, j: V2, ev: SimEvent[], t: number): boolean {
  const dx = b.p.x - j.x;
  const dy = b.p.y - j.y;
  const dist = Math.hypot(dx, dy);
  const rr = BALL_R + JAW_RADIUS;
  if (dist >= rr - 1e-7) return false;

  const nx = dist > 1e-9 ? dx / dist : 1;
  const ny = dist > 1e-9 ? dy / dist : 0;
  b.p.x += nx * (rr - dist);
  b.p.y += ny * (rr - dist);

  const cp = v3(-nx * BALL_R, -ny * BALL_R, 0);
  const n3 = v3(nx, ny, 0);
  const u = add3(v3(b.v.x, b.v.y, 0), cross3(b.w, cp));
  const vn = dot3(u, n3);
  if (vn >= 0) return false;

  const k = 1 / BALL_M;
  const jn = (-(1 + E_RAIL) * vn) / k;
  const J = scale3(n3, jn);
  b.v.x += J.x / BALL_M;
  b.v.y += J.y / BALL_M;

  const u2 = add3(v3(b.v.x, b.v.y, 0), cross3(b.w, cp));
  const tvec = sub3(u2, scale3(n3, dot3(u2, n3)));
  const ts = len3(tvec);
  if (ts > 1e-7) {
    const th = scale3(tvec, 1 / ts);
    const rt = cross3(cp, th);
    const kt = 1 / BALL_M + dot3(rt, rt) / BALL_I;
    let jt = -ts / kt;
    const max = MU_RAIL * Math.abs(jn);
    if (jt < -max) jt = -max;
    const Jt = scale3(th, jt);
    b.v.x += Jt.x / BALL_M;
    b.v.y += Jt.y / BALL_M;
    b.w = add3(b.w, scale3(cross3(cp, Jt), 1 / BALL_I));
  }

  ev.push({ t, type: 'jaw', id: b.id, speed: Math.abs(vn) });
  return true;
}

/**
 * Runs the table forward until everything has stopped.
 *
 * Time stepping is conservative: each step is capped by the earliest possible
 * contact, so nothing is ever skipped over even at break speed. There is no
 * fixed tick, which means no tunnelling and no accumulated drift.
 */
export function simulate(balls: Ball[]): { events: SimEvent[]; frames: Frame[] } {
  const ev: SimEvent[] = [];
  const frames: Frame[] = [];
  let t = 0;
  let steps = 0;

  recordFrame(frames, balls, 0);

  while (t < SIM_MAX_TIME && steps < SIM_MAX_STEPS) {
    steps++;

    const active = balls.filter((b) => !b.pocketed);
    let moving = false;
    for (const b of active) {
      if (!atRest(b)) moving = true;
      else {
        b.v.x = 0;
        b.v.y = 0;
        b.w.x = 0;
        b.w.y = 0;
        if (Math.abs(b.w.z) < REST_W) b.w.z = 0;
      }
    }
    if (!moving) break;

    let dt = 0.25;

    for (const b of active) {
      if (atRest(b)) continue;
      const tp = timeToPhaseChange(b);
      if (tp > 0 && tp < dt) dt = tp;

      for (const c of CUSHIONS) {
        const tr = timeToRail(b, c);
        if (tr > 0 && tr < dt) dt = tr;
      }
      for (const j of JAWS) {
        const tj = timeToJaw(b, j);
        if (tj > 0 && tj < dt) dt = tj;
      }
    }

    for (let i = 0; i < active.length; i++) {
      for (let k = i + 1; k < active.length; k++) {
        if (atRest(active[i]) && atRest(active[k])) continue;
        const tb = timeToBall(active[i], active[k]);
        if (tb > 0 && tb < dt) dt = tb;
      }
    }

    if (dt < 1e-6) dt = 1e-6;
    // Cap the step so the recorded playback has enough resolution. Contact
    // times are always shorter than this, so nothing gets skipped.
    if (dt > FRAME_DT) dt = FRAME_DT;

    for (const b of active) {
      if (!atRest(b)) integrateBall(b, dt);
    }
    t += dt;

    // Resolve whatever we just ran into. A few passes so a ball squeezed
    // between two others settles instead of jittering.
    for (let pass = 0; pass < 4; pass++) {
      let touched = false;
      for (let i = 0; i < active.length; i++) {
        for (let k = i + 1; k < active.length; k++) {
          if (active[i].pocketed || active[k].pocketed) continue;
          if (resolveBallBall(active[i], active[k], ev, t)) touched = true;
        }
      }
      for (const b of active) {
        if (b.pocketed) continue;
        for (const c of CUSHIONS) {
          if (resolveCushion(b, c, ev, t)) touched = true;
        }
        for (const j of JAWS) {
          if (resolveJaw(b, j, ev, t)) touched = true;
        }
      }
      if (!touched) break;
    }

    for (const b of active) {
      if (!b.pocketed && leftTheTable(b.p.x, b.p.y)) {
        b.pocketed = true;
        b.v.x = 0;
        b.v.y = 0;
        b.w = v3(0, 0, 0);
        ev.push({ t, type: 'pocket', id: b.id });
      }
    }

    recordFrame(frames, balls, t);
  }

  return { events: ev, frames };
}

const FRAME_DT = 1 / 240;

function recordFrame(frames: Frame[], balls: Ball[], t: number): void {
  const data = new Float32Array(balls.length * 6);
  let pocketed = 0;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    const o = i * 6;
    data[o] = b.p.x;
    data[o + 1] = b.p.y;
    data[o + 2] = b.q.x;
    data[o + 3] = b.q.y;
    data[o + 4] = b.q.z;
    data[o + 5] = b.q.w;
    if (b.pocketed) pocketed |= 1 << i;
  }
  frames.push({ t, data, pocketed });
}

/** Convenience: take a shot on a copy of the table and report what happened. */
export function shoot(
  input: Ball[],
  shot: Shot,
  cueBallId = 0,
): { balls: Ball[]; events: SimEvent[]; frames: Frame[] } {
  const balls = cloneBalls(input);
  const cue = balls.find((b) => b.id === cueBallId);
  if (!cue || cue.pocketed) return { balls, events: [], frames: [] };
  applyShot(cue, shot);
  const { events, frames } = simulate(balls);
  return { balls, events, frames };
}
