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

/** Jaw centres live at both ends of every cushion segment. */
export const JAWS: V2[] = CUSHIONS.flatMap((c) => [
  { x: c.ax, y: c.ay },
  { x: c.bx, y: c.by },
]);

export const JAW_RADIUS = JAW_R;

/**
 * A ball is pocketed when its centre leaves the playing rectangle. It can only
 * do that through a gap, because the cushions block everywhere else, so this
 * one test covers all six pockets without any special casing.
 */
export function leftTheTable(x: number, y: number): boolean {
  return Math.abs(x) > HALF_L || Math.abs(y) > HALF_W;
}

export function inPlayArea(x: number, y: number, r: number): boolean {
  return Math.abs(x) < HALF_L - r && Math.abs(y) < HALF_W - r;
}
