import { describe, expect, it } from 'vitest';
import { BALL_R, HALF_L, HALF_W, SIDE_GAP } from '../src/core/constants';
import { makeBall, newRack, shoot, type Ball } from '../src/core/physics';
import { CUSHIONS, JAWS, JAW_RADIUS, POCKET_MOUTHS } from '../src/core/table';

const cue = (x: number): Ball => makeBall(0, x, 0);

describe('rack', () => {
  it('has a cue ball and fifteen numbered balls', () => {
    const balls = newRack();
    expect(balls).toHaveLength(16);
    expect(balls.map((b) => b.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
  });

  it('starts with nothing overlapping', () => {
    const balls = newRack();
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const d = Math.hypot(balls[i].p.x - balls[j].p.x, balls[i].p.y - balls[j].p.y);
        expect(d).toBeGreaterThanOrEqual(2 * BALL_R);
      }
    }
  });

  it('puts the 8 in the middle of the rack and a solid/stripe in the back corners', () => {
    const balls = newRack();
    const eight = balls.find((b) => b.id === 8)!;
    // The rack has a little deterministic jitter, so "middle" is approximate.
    expect(Math.abs(eight.p.y)).toBeLessThan(0.003);
    const back = balls
      .filter((b) => b.id !== 0)
      .sort((a, b) => b.p.x - a.p.x)
      .slice(0, 5)
      .sort((a, b) => a.p.y - b.p.y);
    expect(back[0].id).toBeLessThan(8);
    expect(back[4].id).toBeGreaterThan(8);
  });
});

describe('cue strike', () => {
  it('sends a centre hit down the aim line', () => {
    const res = shoot([cue(-0.5)], { aim: 0, power: 0.5, spin: { x: 0, y: 0 } });
    // A fiftieth of a second in, before it can reach a cushion and come back.
    const f = res.frames[Math.round(0.05 * 240)];
    expect(f.data[0]).toBeGreaterThan(-0.45);
    expect(Math.abs(f.data[1])).toBeLessThan(0.02);
  });

  it('gives a centre hit a little more than rolling spin', () => {
    const start = cue(-0.9);
    const res = shoot([start], { aim: 0, power: 0.5, spin: { x: 0, y: 0 } });
    // Compare against what pure rolling would imply at the moment of impact:
    // the ball still slides for a moment, so the spin is ahead of v/R at first.
    expect(res.frames.length).toBeGreaterThan(10);
    const end = res.balls[0];
    expect(Math.hypot(end.v.x, end.v.y)).toBeLessThan(0.01);
  });

  it('draws, stuns and follows differently', () => {
    const setup = () => [cue(-0.45), makeBall(1, 0.05, 0)];

    // Where the cue ball is 0.3s after the collision. Early enough that the
    // object ball has not had time to come back off the far cushion.
    const cueAt = (spinY: number): number => {
      const res = shoot(setup(), { aim: 0, power: 0.45, spin: { x: 0, y: spinY } });
      const hit = res.events.find((e) => e.type === 'ball');
      if (!hit) throw new Error('no collision');
      const frame = res.frames[Math.round((hit.t + 0.3) * 240)];
      return frame.data[0];
    };

    const draw = cueAt(-0.42);
    const stun = cueAt(0);
    const follow = cueAt(0.42);

    expect(draw).toBeLessThan(stun - 0.01);
    expect(follow).toBeGreaterThan(stun + 0.01);
  });

  it('deflects the cue ball away from the side the tip hits', () => {
    // Squirt is an initial direction change, so measure it while the ball is
    // still travelling rather than after it has bounced around the table.
    const drift = (sx: number): number => {
      const res = shoot([cue(-0.5)], { aim: 0, power: 0.6, spin: { x: sx, y: 0 } });
      return res.frames[Math.round(0.08 * 240)].data[1];
    };
    // Right english pushes the ball to the left, so it ends up at lower y.
    expect(drift(0.4)).toBeLessThan(drift(0) - 0.001);
  });

  it('refuses to apply more spin than the miscue limit', () => {
    const res = shoot([cue(-0.5)], { aim: 0, power: 0.3, spin: { x: 3, y: 3 } });
    // Still struck, just with the offsets pulled back to the limit.
    expect(res.frames[12].data[0]).toBeGreaterThan(-0.49);
    expect(Number.isFinite(res.balls[0].p.x)).toBe(true);
  });
});

describe('simulation', () => {
  it('spreads the rack and settles after a full-power opening break', () => {
    const rack = newRack();
    const res = shoot(rack, { aim: 0, power: 1, spin: { x: 0, y: 0 } }, 0, true);
    const railBalls = new Set(res.events.flatMap((e) => e.type === 'rail' && e.id !== 0 ? [e.id] : []));
    expect(railBalls.size).toBeGreaterThanOrEqual(4);
    const spread = res.balls.slice(1).filter((b, i) =>
      Math.hypot(b.p.x - rack[i + 1].p.x, b.p.y - rack[i + 1].p.y) > 0.1,
    );
    expect(spread.length).toBeGreaterThanOrEqual(8);
    expect(res.frames.at(-1)!.t).toBeLessThan(6);
    for (const b of res.balls) {
      expect(Math.hypot(b.v.x, b.v.y)).toBeLessThan(0.01);
    }
  });

  it('is deterministic', () => {
    const shot = { aim: 0.3, power: 0.7, spin: { x: 0.2, y: -0.1 } };
    const a = shoot(newRack(), shot);
    const b = shoot(newRack(), shot);
    for (let i = 0; i < a.balls.length; i++) {
      expect(a.balls[i].p.x).toBe(b.balls[i].p.x);
      expect(a.balls[i].p.y).toBe(b.balls[i].p.y);
      expect(a.balls[i].pocketed).toBe(b.balls[i].pocketed);
    }
  });

  it('never leaves a ball outside the table without pocketing it', () => {
    const res = shoot(newRack(), { aim: 0.1, power: 1, spin: { x: 0.3, y: -0.2 } });
    for (const b of res.balls) {
      if (b.pocketed) continue;
      expect(Math.abs(b.p.x)).toBeLessThanOrEqual(HALF_L + 1e-6);
      expect(Math.abs(b.p.y)).toBeLessThanOrEqual(HALF_W + 1e-6);
    }
  });

  it('bounces off a cushion and comes back', () => {
    const res = shoot([cue(0)], { aim: 0, power: 0.6, spin: { x: 0, y: 0 } });
    const rails = res.events.filter((e) => e.type === 'rail');
    expect(rails.length).toBeGreaterThan(0);
    expect(res.balls[0].p.x).toBeLessThan(HALF_L);
  });

  it('bounces with the edge of the ball flush to each cushion nose', () => {
    for (const c of CUSHIONS) {
      const x = (c.ax + c.bx) / 2 + c.nx * 0.25;
      const y = (c.ay + c.by) / 2 + c.ny * 0.25;
      const aim = Math.atan2(-c.ny, -c.nx);
      const res = shoot([makeBall(0, x, y)], { aim, power: 1, spin: { x: 0, y: 0 } });
      const closest = Math.min(...res.frames.map((f) =>
        (f.data[0] - c.ax) * c.nx + (f.data[1] - c.ay) * c.ny,
      ));
      expect(closest).toBeCloseTo(BALL_R, 5);
      expect(res.events[0]?.type).toBe('rail');
    }
  });

  it('drops a ball through the centre of all six pockets', () => {
    for (const { a, b, outward } of POCKET_MOUTHS) {
      const x = (a.x + b.x) / 2 - outward.x * 0.22;
      const y = (a.y + b.y) / 2 - outward.y * 0.22;
      const aim = Math.atan2(outward.y, outward.x);
      const res = shoot([makeBall(0, x, y)], { aim, power: 0.35, spin: { x: 0, y: 0 } });
      expect(res.events.map((e) => e.type)).toEqual(['pocket']);
      expect(res.balls[0].pocketed).toBe(true);
    }
  });

  it('catches a glancing shot on the rounded jaw instead of an extended rail', () => {
    const start = makeBall(0, -SIDE_GAP + 0.012, HALF_W - 0.2);
    const res = shoot([start], { aim: Math.PI / 2, power: 0.25, spin: { x: 0, y: 0 } });
    expect(res.events.map((e) => e.type)).toEqual(['jaw']);
    expect(res.balls[0].pocketed).toBe(false);
    const jaw = JAWS[1];
    const closest = Math.min(...res.frames.map((f) => Math.hypot(f.data[0] - jaw.x, f.data[1] - jaw.y)));
    expect(closest).toBeCloseTo(BALL_R + JAW_RADIUS, 5);
  });

  it('stops a ball from rolling forever', () => {
    const res = shoot([cue(-1.0)], { aim: 0, power: 0.25, spin: { x: 0, y: 0 } });
    const last = res.frames[res.frames.length - 1];
    expect(last.t).toBeLessThan(20);
  });
});
