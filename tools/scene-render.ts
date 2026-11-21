import { createCanvas, type Canvas } from '@napi-rs/canvas';

import { installDomShim } from './domshim';
import { Scene, drawBall } from '../src/render/scene';
import type { Ball } from '../src/core/physics';
import { BALL_R } from '../src/core/constants';

export type ShotCanvas = Canvas;

/** Renders the whole table. Used by the preview script and the visual test. */
export function renderTable(balls: Ball[], w = 1600, h = 820, aim = -0.35): ShotCanvas {
  installDomShim(w, h);
  const canvas = createCanvas(w, h);
  const scene = new Scene(canvas as unknown as HTMLCanvasElement);
  scene.resize();
  scene.draw({
    balls,
    cueBallId: 0,
    aim,
    power: 0.55,
    spin: { x: 0.12, y: -0.18 },
    showAim: true,
    placing: false,
    hover: null,
  });
  return canvas;
}

/** All sixteen balls, large, so the numbers and stripes can be checked. */
export function renderBallSheet(): ShotCanvas {
  const cols = 8;
  const rows = 2;
  const cell = 150;
  const w = cols * cell + 40;
  const h = rows * cell + 40;
  installDomShim(w, h);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101314';
  ctx.fillRect(0, 0, w, h);

  const scale = 46 / BALL_R;
  for (let i = 0; i < 16; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = 20 + cell * col + cell / 2;
    const cy = 20 + cell * row + cell / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    drawBall(
      ctx as unknown as CanvasRenderingContext2D,
      {
        id: i,
        p: { x: 0, y: 0 },
        v: { x: 0, y: 0 },
        w: { x: 0, y: 0, z: 0 },
        q: { x: 0, y: 0, z: 0, w: 1 },
        rolling: true,
        pocketed: false,
      },
      i === 0,
      46,
    );
    ctx.restore();
  }
  return canvas;
}

export const BALL_SHEET_CELL = 150;
export const BALL_SHEET_PAD = 20;
