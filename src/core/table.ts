import { CORNER_GAP, HALF_L, HALF_W, JAW_R, SIDE_GAP } from './constants';
import type { V2 } from './math';

/**
 * Table geometry. The table is centred on the origin with the long axis on x,
 * so the playing surface runs from -1.27..1.27 by -0.635..0.635.
 *
 * Cushions are axis aligned segments. They stop short of the pockets, and each
 * end gets a small round jaw. A ball that clips a jaw bounces back out instead
 * of vanishing, which is the whole point of having jaws at all.
 */

export type Cushion = {
  /** Point on the cushion line at one end. */
  ax: number;
  ay: number;
  /** Point at the other end. */
  bx: number;
  by: number;
  /** Unit normal pointing into the table. */
  nx: number;
  ny: number;
};

function makeCushion(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  nx: number,
  ny: number,
): Cushion {
  return { ax, ay, bx, by, nx, ny };
}

const C = HALF_L - CORNER_GAP; // cushion end offset from a corner along the long rail
const S = HALF_W - CORNER_GAP; // same along the short rail
const MID = SIDE_GAP;

export const CUSHIONS: Cushion[] = [
  // top long rail (+y), split by the side pocket
  makeCushion(-C, HALF_W, -MID, HALF_W, 0, -1),
  makeCushion(MID, HALF_W, C, HALF_W, 0, -1),
  // bottom long rail (-y)
  makeCushion(-C, -HALF_W, -MID, -HALF_W, 0, 1),
  makeCushion(MID, -HALF_W, C, -HALF_W, 0, 1),
  // short rails
  makeCushion(HALF_L, -S, HALF_L, S, -1, 0),
  makeCushion(-HALF_L, -S, -HALF_L, S, 1, 0),
];

export const POCKETS: V2[] = [
  { x: -HALF_L, y: -HALF_W },
  { x: HALF_L, y: -HALF_W },
  { x: -HALF_L, y: HALF_W },
  { x: HALF_L, y: HALF_W },
  { x: 0, y: -HALF_W },
  { x: 0, y: HALF_W },
];

/** The line a ball crosses at each pocket, and the direction into its well. */
export const POCKET_MOUTHS = POCKETS.map((p, i) => {
  const sx = Math.sign(p.x);
  const sy = Math.sign(p.y);
  if (i < 4) {
    return {
      a: { x: p.x - sx * CORNER_GAP, y: p.y },
      b: { x: p.x, y: p.y - sy * CORNER_GAP },
      outward: { x: sx * Math.SQRT1_2, y: sy * Math.SQRT1_2 },
      corner: true,
    };
  }
  return {
    a: { x: -SIDE_GAP, y: p.y },
    b: { x: SIDE_GAP, y: p.y },
    outward: { x: 0, y: sy },
    corner: false,
  };
});

/** The rounded ends are tangent to the cushion nose, one radius behind it. */
export const JAWS: V2[] = CUSHIONS.flatMap((c) => [
  { x: c.ax - c.nx * JAW_R, y: c.ay - c.ny * JAW_R },
  { x: c.bx - c.nx * JAW_R, y: c.by - c.ny * JAW_R },
]);

export const JAW_RADIUS = JAW_R;

/**
 * Which pocket the point is in, or null.
 *
 * The test is the mouth the two cushions actually leave, not the edge of the
 * playing rectangle: a corner pocket opens along the diagonal between its two
 * cushion ends, and a side pocket opens along the rail line between its two
 * ends. Drawn and simulated the same way, so a ball disappears exactly where
 * it looks like it should.
 */
export function pocketAt(x: number, y: number): number | null {
  const sx = x < 0 ? -1 : 1;
  const sy = y < 0 ? -1 : 1;
  // The corner mouth is the line sx*x + sy*y = HALF_L + HALF_W - CORNER_GAP.
  if (sx * x + sy * y > HALF_L + HALF_W - CORNER_GAP) {
    return sy > 0 ? (sx > 0 ? 3 : 2) : sx > 0 ? 1 : 0;
  }
  if (Math.abs(x) < SIDE_GAP && Math.abs(y) > HALF_W) {
    return y > 0 ? 5 : 4;
  }
  return null;
}

/**
 * A ball is pocketed when its centre passes the mouth of a pocket. It can only
 * get there through a gap, because the cushions block everywhere else.
 */
export function leftTheTable(x: number, y: number): boolean {
  return pocketAt(x, y) !== null;
}

export function inPlayArea(x: number, y: number, r: number): boolean {
  return Math.abs(x) < HALF_L - r && Math.abs(y) < HALF_W - r;
}
