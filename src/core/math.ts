// Small vector / quaternion helpers. Plain objects, no classes: at 16 balls
// per frame the allocation cost is irrelevant and the code stays obvious.

export type V2 = { x: number; y: number };
export type V3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export const v2 = (x = 0, y = 0): V2 => ({ x, y });
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

export const add2 = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub2 = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale2 = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const dot2 = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const len2 = (a: V2): number => Math.hypot(a.x, a.y);
export const norm2 = (a: V2): V2 => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const rot2 = (a: V2, ang: number): V2 => ({
  x: a.x * Math.cos(ang) - a.y * Math.sin(ang),
  y: a.x * Math.sin(ang) + a.y * Math.cos(ang),
});
export const perp2 = (a: V2): V2 => ({ x: -a.y, y: a.x });
export const dist2 = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const add3 = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const cross3 = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const qIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

export function qMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function qNormalize(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

/** Rotate vector v by quaternion q. */
export function qRotate(q: Quat, v: V3): V3 {
  const { x, y, z, w } = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/**
 * Advance an orientation by an angular velocity over dt.
 * Exact for constant w: q' = exp(w*dt/2) * q.
 */
export function qIntegrate(q: Quat, w: V3, dt: number): Quat {
  const ang = len3(w);
  if (ang < 1e-9) return q;
  const half = ang * dt * 0.5;
  const s = Math.sin(half) / ang;
  const dq: Quat = { x: w.x * s, y: w.y * s, z: w.z * s, w: Math.cos(half) };
  return qNormalize(qMul(dq, q));
}

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Deterministic-ish angle helper kept out of the hot loop. */
export const TAU = Math.PI * 2;
