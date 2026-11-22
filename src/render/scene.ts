import { BALL_R, HALF_L, HALF_W, TABLE_L, TABLE_W } from '../core/constants';
import type { Ball } from '../core/physics';
import { TAU, qRotate, type V2, type V3 } from '../core/math';
import { CUSHIONS, JAW_RADIUS, POCKET_MOUTHS, type Cushion } from '../core/table';

export const RAIL = 0.128;
/** How far the cushion sticks out past the playing edge. */
export const CUSHION_DEPTH = 0.052;
export const OUTER_L = TABLE_L + 2 * RAIL;
export const OUTER_W = TABLE_W + 2 * RAIL;

const PX_PER_M = 640;

export type ViewState = {
  balls: Ball[];
  cueBallId: number;
  aim: number;
  power: number;
  spin: V2;
  showAim: boolean;
  placing: boolean;
  hover: V2 | null;
};

const BALL_HUE: Record<number, string> = {
  1: '#f2c400',
  2: '#1f52c4',
  3: '#cf2730',
  4: '#5e2a8c',
  5: '#e8721c',
  6: '#0b7f42',
  7: '#7a1f2b',
  8: '#16161a',
};

const hueOf = (id: number): string => BALL_HUE[id > 8 ? id - 8 : id] ?? '#cccccc';

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeNoise(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  // Seeded on purpose: the table should look identical every build.
  let seed = 1337;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < size * size; i++) {
    const on = rnd() > 0.55;
    img.data[i * 4] = on ? 255 : 0;
    img.data[i * 4 + 1] = on ? 255 : 0;
    img.data[i * 4 + 2] = on ? 255 : 0;
    img.data[i * 4 + 3] = Math.floor(rnd() * 10);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function drawPocket(g: CanvasRenderingContext2D, pocket: (typeof POCKET_MOUTHS)[number]): void {
  const { a, b, outward, corner } = pocket;
  const mouth = Math.hypot(b.x - a.x, b.y - a.y);
  const half = mouth / 2;
  const depth = corner ? 0.131 : 0.091;
  g.save();
  g.transform(
    (b.x - a.x) / mouth, (b.y - a.y) / mouth,
    outward.x, outward.y, (a.x + b.x) / 2, (a.y + b.y) / 2,
  );

  // Leave the mouth open against the cloth and round the back into the rail.
  g.beginPath();
  g.moveTo(-half, 0);
  g.bezierCurveTo(-half - 0.027, depth * 0.38, -half - 0.030, depth, 0, depth);
  g.bezierCurveTo(half + 0.030, depth, half + 0.027, depth * 0.38, half, 0);
  g.fillStyle = '#060809';
  g.fill();

  g.clip();
  const liner = g.createLinearGradient(0, 0, 0, depth);
  liner.addColorStop(0, '#1a2421');
  liner.addColorStop(0.26, '#0b1010');
  liner.addColorStop(0.66, '#040607');
  liner.addColorStop(1, '#242322');
  g.fillStyle = liner;
  g.fillRect(-half - 0.030, 0, mouth + 0.060, depth);

  // A soft shelf shadow inside the well gives the cloth edge some depth.
  const lip = g.createLinearGradient(0, 0, 0, 0.017);
  lip.addColorStop(0, 'rgba(0,0,0,0.68)');
  lip.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = lip;
  g.fillRect(-half - 0.030, 0, mouth + 0.060, 0.017);
  g.restore();
}

function drawCushion(g: CanvasRenderingContext2D, c: Cushion): void {
  const len = Math.hypot(c.bx - c.ax, c.by - c.ay);
  g.save();
  g.transform((c.bx - c.ax) / len, (c.by - c.ay) / len, c.nx, c.ny, c.ax, c.ay);

  const shadowDepth = 0.042;
  const shadowColor = 'rgba(0,0,0,0.39)';
  const shadow = g.createLinearGradient(0, 0, 0, shadowDepth);
  shadow.addColorStop(0, shadowColor);
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = shadow;
  g.fillRect(shadowDepth, 0, len - 2 * shadowDepth, shadowDepth);
  for (const x of [0, len - shadowDepth]) {
    const center = x === 0 ? shadowDepth : x;
    const fade = g.createRadialGradient(center, 0, 0, center, 0, shadowDepth);
    fade.addColorStop(0, shadowColor);
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(x, 0, shadowDepth, shadowDepth);
  }

  // In these coordinates positive y points toward the cloth. The rounded
  // ends use the same jaw radius as the collision geometry.
  const slope = 0.52;
  const angle = Math.atan(slope);
  const jawX = JAW_RADIUS * Math.cos(angle);
  const jawY = -JAW_RADIUS * (1 + Math.sin(angle));
  const backX = jawX - slope * (CUSHION_DEPTH + jawY);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(len, 0);
  g.arc(len, -JAW_RADIUS, JAW_RADIUS, Math.PI / 2, -angle, true);
  g.lineTo(len + backX, -CUSHION_DEPTH);
  g.lineTo(-backX, -CUSHION_DEPTH);
  g.lineTo(-jawX, jawY);
  g.arc(0, -JAW_RADIUS, JAW_RADIUS, Math.PI + angle, Math.PI / 2, true);
  g.closePath();

  // The cushion is cloth over rubber, angled away from the light: the same
  // green as the bed, shading down into its own shadow. No gloss.
  const rubber = g.createLinearGradient(0, 0, 0, -CUSHION_DEPTH);
  rubber.addColorStop(0, '#2b8163');
  rubber.addColorStop(0.12, '#247056');
  rubber.addColorStop(1, '#153f30');
  g.fillStyle = rubber;
  g.fill();

  // Shade the angled end faces within the cushion silhouette.
  g.save();
  g.clip();
  g.fillStyle = 'rgba(6,19,15,0.42)';
  for (const end of [0, len]) {
    const inward = end === 0 ? 1 : -1;
    g.beginPath();
    g.moveTo(end - inward * JAW_RADIUS, 0);
    g.lineTo(end + inward * 0.011, 0);
    g.lineTo(end + inward * (0.011 - backX), -CUSHION_DEPTH);
    g.lineTo(end + inward * (-backX - 0.006), -CUSHION_DEPTH);
    g.closePath();
    g.fill();
  }
  g.restore();

  g.restore();
}

/**
 * Builds the static table picture once. It is always drawn unrotated - the
 * scene applies the rotation when it blits, so there is one cached image
 * instead of two.
 */
function buildTable(): HTMLCanvasElement {
  const w = Math.round(OUTER_L * PX_PER_M);
  const h = Math.round(OUTER_W * PX_PER_M);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;

  g.translate(w / 2, h / 2);
  g.scale(w / OUTER_L, h / OUTER_W);

  // --- wood frame ---
  // One flat colour: a vertical gradient made the side rails look like a
  // different material from the top and bottom ones.
  g.fillStyle = '#251d18';
  roundRect(g, -OUTER_L / 2, -OUTER_W / 2, OUTER_L, OUTER_W, 0.045);
  g.fill();

  // inner bevel line
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 0.004;
  roundRect(g, -OUTER_L / 2 + 0.012, -OUTER_W / 2 + 0.012, OUTER_L - 0.024, OUTER_W - 0.024, 0.036);
  g.stroke();

  // --- cloth ---
  const cw = TABLE_L;
  const ch = TABLE_W;
  // Barely-there light from above. A tight radial here reads as a smudge, so
  // the cloth stays almost flat and the vignette does the falloff.
  const cloth = g.createLinearGradient(0, -ch / 2, 0, ch / 2);
  cloth.addColorStop(0, '#2f9070');
  cloth.addColorStop(0.55, '#2a8566');
  cloth.addColorStop(1, '#24795c');
  g.fillStyle = cloth;
  g.fillRect(-cw / 2, -ch / 2, cw, ch);

  // felt grain
  try {
    const pat = g.createPattern(makeNoise(64), 'repeat');
    if (pat) {
      g.globalAlpha = 0.5;
      g.fillStyle = pat;
      g.fillRect(-cw / 2, -ch / 2, cw, ch);
      g.globalAlpha = 1;
    }
  } catch {
    /* some canvas implementations have no pattern support */
  }

  // vignette, so the cloth falls away towards the rails
  const vig = g.createRadialGradient(0, 0, cw * 0.3, 0, 0, cw * 0.74);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = vig;
  g.fillRect(-cw / 2, -ch / 2, cw, ch);

  for (const pocket of POCKET_MOUTHS) drawPocket(g, pocket);

  for (const cushion of CUSHIONS) drawCushion(g, cushion);

  // --- sights ---
  // Small ivory diamonds, the way a table is marked, not dots.
  g.fillStyle = 'rgba(233,222,196,0.72)';
  const dOff = CUSHION_DEPTH + 0.042;
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue; // side pocket
    const x = -HALF_L + (TABLE_L * i) / 8;
    for (const y of [HALF_W + dOff, -HALF_W - dOff]) {
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 4);
      g.fillRect(-0.0048, -0.0048, 0.0096, 0.0096);
      g.restore();
    }
  }
  for (let i = 1; i <= 3; i++) {
    const y = -HALF_W + (TABLE_W * i) / 4;
    for (const x of [HALF_L + dOff, -HALF_L - dOff]) {
      g.beginPath();
      g.arc(x, y, 0.0055, 0, TAU);
      g.fill();
    }
  }

  return c;
}

export class Scene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layer: HTMLCanvasElement | null = null;
  private rotated = false;
  private scale = 1;
  private cx = 0;
  private cy = 0;

  constructor(canvas: HTMLCanvasElement, private area: HTMLElement | null = null) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
  }

  setRotated(r: boolean): void {
    if (this.rotated === r) return;
    this.rotated = r;
    this.resize();
  }

  isRotated(): boolean {
    return this.rotated;
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.layer) this.layer = buildTable();
    this.layout(w, h);
  }

  private layout(w: number, h: number): void {
    const ow = this.rotated ? OUTER_W : OUTER_L;
    const oh = this.rotated ? OUTER_L : OUTER_W;
    const area = this.area?.getBoundingClientRect();
    const width = area?.width || w;
    const height = area?.height || h;
    this.scale = Math.min((width * 0.95) / ow, (height * 0.95) / oh);
    this.cx = (area?.left ?? 0) + width / 2;
    this.cy = (area?.top ?? 0) + height / 2;
  }

  screenToWorld(sx: number, sy: number): V2 {
    const dx = (sx - this.cx) / this.scale;
    const dy = (sy - this.cy) / this.scale;
    if (this.rotated) return { x: -dy, y: dx };
    return { x: dx, y: dy };
  }

  worldToScreen(p: V2): V2 {
    const x = this.rotated ? p.y : p.x;
    const y = this.rotated ? -p.x : p.y;
    return { x: this.cx + x * this.scale, y: this.cy + y * this.scale };
  }

  draw(view: ViewState): void {
    const { ctx } = this;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;

    ctx.save();
    ctx.setTransform(
      Math.min(2, window.devicePixelRatio || 1),
      0,
      0,
      Math.min(2, window.devicePixelRatio || 1),
      0,
      0,
    );

    const bg = ctx.createRadialGradient(w / 2, h * 0.45, 40, w / 2, h * 0.5, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#12161a');
    bg.addColorStop(1, '#080a0b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.translate(this.cx, this.cy);
    if (this.rotated) ctx.rotate(-Math.PI / 2);
    ctx.scale(this.scale, this.scale);

    if (this.layer) {
      ctx.drawImage(this.layer, -OUTER_L / 2, -OUTER_W / 2, OUTER_L, OUTER_W);
    }

    if (view.showAim && !view.placing) this.drawAim(view);
    for (const b of view.balls) {
      if (b.pocketed) continue;
      // The cue ball never has a number, whatever the aim state is.
      drawBall(ctx, b, b.id === view.cueBallId, BALL_R * this.scale);
    }
    if (view.placing && view.hover) drawPlacement(ctx, view.hover);

    ctx.restore();
  }

  /**
   * The aim line. Direction only: it runs from the cue ball to the cushion and
   * stops there. It does not predict a contact, and the balls are drawn over
   * it, so it can never be mistaken for a guide.
   */
  private drawAim(view: ViewState): void {
    const { ctx } = this;
    const cue = view.balls.find((b) => b.id === view.cueBallId);
    if (!cue || cue.pocketed) return;

    const dir = { x: Math.cos(view.aim), y: Math.sin(view.aim) };
    const start = {
      x: cue.p.x + dir.x * BALL_R,
      y: cue.p.y + dir.y * BALL_R,
    };

    // Direction only. It runs to the cushion so you can see where the line is
    // pointing at the far end, which is the judgement the short stub made
    // impossible. It stops at the rail and predicts nothing.
    const tX =
      dir.x > 0
        ? (HALF_L - BALL_R - start.x) / dir.x
        : dir.x < 0
          ? (-HALF_L + BALL_R - start.x) / dir.x
          : Infinity;
    const tY =
      dir.y > 0
        ? (HALF_W - BALL_R - start.y) / dir.y
        : dir.y < 0
          ? (-HALF_W + BALL_R - start.y) / dir.y
          : Infinity;
    const len = Math.max(0, Math.min(tX, tY));
    const grad = ctx.createLinearGradient(start.x, start.y, start.x + dir.x * len, start.y + dir.y * len);
    grad.addColorStop(0, 'rgba(255,255,255,0.42)');
    grad.addColorStop(1, 'rgba(255,255,255,0.14)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 0.0022;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(start.x + dir.x * len, start.y + dir.y * len);
    ctx.stroke();

    // cue stick: a tapered shape, not a line, so it reads as a cue
    const back = 0.018 + view.power * 0.07;
    const bx = cue.p.x - dir.x * (BALL_R + back);
    const by = cue.p.y - dir.y * (BALL_R + back);
    const px = -dir.y;
    const py = dir.x;
    const cueLen = 0.46;
    const ex = bx - dir.x * cueLen;
    const ey = by - dir.y * cueLen;
    const tipW = 0.0032;
    const buttW = 0.0068;
    const g2 = ctx.createLinearGradient(bx, by, ex, ey);
    g2.addColorStop(0, '#efe3c6');
    g2.addColorStop(0.04, '#cbb17a');
    g2.addColorStop(0.1, '#7a5c3c');
    g2.addColorStop(0.22, '#3d2a1c');
    g2.addColorStop(0.75, 'rgba(44,31,22,0.75)');
    g2.addColorStop(1, 'rgba(40,28,20,0)');
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.moveTo(bx + px * tipW, by + py * tipW);
    ctx.lineTo(ex + px * buttW, ey + py * buttW);
    ctx.lineTo(ex - px * buttW, ey - py * buttW);
    ctx.lineTo(bx - px * tipW, by - py * tipW);
    ctx.closePath();
    ctx.fill();

    // leather tip
    ctx.fillStyle = '#2f6f9e';
    ctx.beginPath();
    ctx.arc(bx, by, 0.0034, 0, TAU);
    ctx.fill();
  }
}

function drawPlacement(ctx: CanvasRenderingContext2D, p: V2): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.setLineDash([0.006, 0.006]);
  ctx.lineWidth = 0.002;
  ctx.beginPath();
  ctx.arc(p.x, p.y, BALL_R, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/**
 * Fills the visible part of the sphere where P . axis > c * R.
 *
 * That is a spherical cap, and its outline depends on how the axis sits
 * relative to the camera: a circle when the axis points at you, a straight
 * edge when it lies in the screen plane, a conic in between. Solved per
 * scanline by intersecting the plane with the circle of that row.
 */
function fillCap(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  axis: V3,
  c: number,
  color: string,
  rows: number,
): void {
  const ax = axis.x;
  const ay = axis.y;
  const az = axis.z;
  ctx.fillStyle = color;

  for (let i = 0; i < rows; i++) {
    const y = -R + ((i + 0.5) * 2 * R) / rows;
    const h2 = R * R - y * y;
    if (h2 <= 0) continue;
    const h = Math.sqrt(h2);
    const K = c * R - y * ay;

    const edges: number[] = [-h, h];
    if (Math.abs(az) < 1e-9) {
      if (Math.abs(ax) > 1e-9) {
        const x = K / ax;
        if (x > -h && x < h) edges.push(x);
      }
    } else {
      const A = ax * ax + az * az;
      const B = -2 * K * ax;
      const Cc = K * K - az * az * h2;
      const disc = B * B - 4 * A * Cc;
      if (disc > 0) {
        const sq = Math.sqrt(disc);
        for (const x of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
          if (x > -h && x < h) edges.push(x);
        }
      }
    }

    edges.sort((p, q) => p - q);
    const band = (2 * R) / rows;
    for (let k = 0; k < edges.length - 1; k++) {
      const x0 = edges[k];
      const x1 = edges[k + 1];
      if (x1 - x0 < 1e-9) continue;
      const xm = (x0 + x1) / 2;
      const zm = Math.sqrt(Math.max(0, h2 - xm * xm));
      if (ax * xm + ay * y + az * zm > c * R) {
        // Bands overlap their neighbours. Without the overlap each sub-pixel
        // seam is anti-aliased against the coloured body underneath, and the
        // white cap ends up tinted with the ball's own colour.
        ctx.fillRect(
          cx + x0 - band * 0.15,
          cy + y - band * 0.5,
          x1 - x0 + band * 0.3,
          band * 2,
        );
      }
    }
  }
}

/**
 * One ball.
 *
 * Solids are a disc with a white number patch, stripes a coloured band. The
 * patch position comes from the ball's orientation, so the number rolls over
 * the top of the ball and disappears round the back while it moves.
 */
export function drawBall(
  ctx: CanvasRenderingContext2D,
  b: Ball,
  isCue: boolean,
  pxRadius = 12,
): void {
  const R = BALL_R;
  const x = b.p.x;
  const y = b.p.y;
  const stripe = b.id > 8;
  const hue = hueOf(b.id);
  const eight = b.id === 8;

  // Below roughly ten pixels of radius a numeral is a smudge, and pretending
  // otherwise makes the balls look dirty. Drop detail instead.
  const detail = pxRadius >= 10 ? 2 : pxRadius >= 6 ? 1 : 0;

  // contact shadow: a soft disc slightly larger than the ball
  const sh = ctx.createRadialGradient(x, y, R * 0.6, x, y, R * 1.5);
  sh.addColorStop(0, 'rgba(0,0,0,0.5)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.5, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, R, 0, TAU);
  ctx.clip();

  // body
  ctx.fillStyle = isCue ? '#f4f2ec' : stripe ? '#f4f2ec' : hue;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);

  if (stripe && !isCue && detail > 0) {
    // The whole ball goes the stripe colour, then the two poles are painted
    // back to white. Because the poles are clipped against the sphere they
    // tilt, narrow and merge with the silhouette exactly as the ball rolls,
    // instead of being a flat bar that ignores the rotation.
    ctx.fillStyle = hue;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
    const rows = Math.max(24, Math.min(400, Math.round(pxRadius * 4)));
    const axis = qRotate(b.q, { x: 0, y: 1, z: 0 });
    fillCap(ctx, x, y, R, axis, 0.62, '#f4f2ec', rows);
    fillCap(ctx, x, y, R, { x: -axis.x, y: -axis.y, z: -axis.z }, 0.62, '#f4f2ec', rows);
  }

  // Shading and highlight go down before the number. Shading the patch as
  // well drags its bright centre off to one side, which reads as a number
  // that is not in the middle of the ball. At small sizes the highlight just
  // smears the ball, so it is skipped.
  if (detail >= 2) {
    const shade = ctx.createRadialGradient(
      x - R * 0.24,
      y - R * 0.3,
      R * 0.06,
      x,
      y,
      R * 1.02,
    );
    shade.addColorStop(0, 'rgba(255,255,255,0.22)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    shade.addColorStop(1, 'rgba(0,0,0,0.26)');
    ctx.fillStyle = shade;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);

    const sp = ctx.createRadialGradient(
      x - R * 0.4,
      y - R * 0.45,
      0,
      x - R * 0.4,
      y - R * 0.45,
      R * 0.42,
    );
    sp.addColorStop(0, 'rgba(255,255,255,0.30)');
    sp.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sp;
    ctx.beginPath();
    ctx.arc(x - R * 0.4, y - R * 0.45, R * 0.42, 0, TAU);
    ctx.fill();
  } else if (detail === 1) {
    // Just enough shading to keep the ball from looking like a flat sticker.
    const shade = ctx.createRadialGradient(x - R * 0.3, y - R * 0.35, R * 0.1, x, y, R);
    shade.addColorStop(0, 'rgba(255,255,255,0.18)');
    shade.addColorStop(1, 'rgba(0,0,0,0.16)');
    ctx.fillStyle = shade;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
  }

  if (!isCue) {
    const n: V3 = qRotate(b.q, { x: 0, y: 0, z: 1 });
    if (detail === 0) {
      // Too small for a numeral. A plain dot still reads as a marked ball.
      ctx.fillStyle = '#f4f1e8';
      ctx.beginPath();
      ctx.arc(x, y, R * 0.32, 0, TAU);
      ctx.fill();
    } else if (n.z > 0.06) {
      // The number is a circular decal painted onto the sphere. Projecting it
      // properly is what makes a rolling ball look like a ball: the patch turns
      // into an ellipse as it rolls away from the camera and the digit is
      // squashed by exactly the same amount. Drawn as a flat sticker that
      // merely slides and spins, it looks wrong.
      const u: V3 = qRotate(b.q, { x: 0, y: 1, z: 0 });
      const v: V3 = qRotate(b.q, { x: 1, y: 0, z: 0 });
      const capR = (detail >= 2 ? 0.5 : 0.54) * R;
      const alpha = Math.asin(Math.min(1, capR / R));
      const s = R * Math.sin(alpha);
      const ex = x + n.x * R * Math.cos(alpha);
      const ey = y + n.y * R * Math.cos(alpha);

      ctx.save();
      // Local space: a unit circle is the decal, +x is the ball's right and
      // +y its up, both already foreshortened by the projection.
      ctx.transform(s * v.x, s * v.y, s * u.x, s * u.y, ex, ey);

      ctx.fillStyle = '#f8f6f0';
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, TAU);
      ctx.fill();

      const label = String(b.id);
      const two = label.length > 1;
      const TEXT = 64;
      const fontPx = 64;
      // Scale down instead of setting a tiny font: sub-pixel font sizes do not
      // survive Skia's text layout.
      ctx.scale(1 / TEXT, 1 / TEXT);
      ctx.fillStyle = '#131313';
      ctx.font = `800 ${fontPx}px "Segoe UI", ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.save();
      if (two) ctx.scale(0.86, 1);
      ctx.fillText(label, 0, fontPx * 0.35);
      ctx.restore();

      // 6 and 9 get the little underscore so they are never ambiguous
      if (b.id === 6 || b.id === 9) {
        ctx.fillRect(-fontPx * 0.28, fontPx * 0.44, fontPx * 0.56, fontPx * 0.09);
      }
      ctx.restore();
    }
  }

  ctx.restore();

  // rim
  ctx.beginPath();
  ctx.arc(x, y, R - 0.0004, 0, TAU);
  ctx.strokeStyle = eight ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.0012;
  ctx.stroke();
}
