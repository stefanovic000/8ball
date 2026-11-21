import { describe, expect, it } from 'vitest';
import { BALL_SHEET_CELL, BALL_SHEET_PAD, renderBallSheet, renderTable } from '../tools/scene-render';
import { newRack } from '../src/core/physics';

const HUE: Record<number, [number, number, number]> = {
  1: [0xf2, 0xc4, 0x00],
  2: [0x1f, 0x52, 0xc4],
  3: [0xcf, 0x27, 0x30],
  4: [0x5e, 0x2a, 0x8c],
  5: [0xe8, 0x72, 0x1c],
  6: [0x0b, 0x7f, 0x42],
  7: [0x7a, 0x1f, 0x2b],
};

type Pixels = { data: Uint8ClampedArray; w: number; h: number };

function pixelsOf(canvas: { getContext: (t: '2d') => unknown; width: number; height: number }): Pixels {
  const ctx = canvas.getContext('2d') as {
    getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
  };
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, w: canvas.width, h: canvas.height };
}

const at = (p: Pixels, x: number, y: number): [number, number, number, number] => {
  const i = (Math.round(y) * p.w + Math.round(x)) * 4;
  return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]];
};

describe('table image', () => {
  const canvas = renderTable(newRack());
  const px = pixelsOf(canvas);

  it('renders at the requested size', () => {
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(820);
  });

  it('has green cloth in the middle', () => {
    const [r, g, b] = at(px, 800, 410);
    expect(g).toBeGreaterThan(r + 20);
    expect(g).toBeGreaterThan(b + 10);
    expect(g).toBeGreaterThan(60);
  });

  it('has a dark hole at the corner pocket', () => {
    // corner pocket sits at world (-1.27, -0.635)
    const scale = Math.min((1600 * 0.95) / 2.73, (820 * 0.95) / (1.27 + 0.19));
    const sx = 800 - 1.27 * scale;
    const sy = 410 - 0.635 * scale;
    const [r, g, b] = at(px, sx, sy);
    expect(r + g + b).toBeLessThan(70);
  });

  it('draws the cue ball white', () => {
    const scale = Math.min((1600 * 0.95) / 2.73, (820 * 0.95) / (1.27 + 0.19));
    const [r, g, b] = at(px, 800 - 0.635 * scale, 410);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeGreaterThan(180);
    expect(b).toBeGreaterThan(180);
  });

  it('is not a blank image', () => {
    let lit = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      if (px.data[i] + px.data[i + 1] + px.data[i + 2] > 90) lit++;
    }
    expect(lit / (px.w * px.h)).toBeGreaterThan(0.4);
  });
});

describe('ball sheet', () => {
  const canvas = renderBallSheet();
  const px = pixelsOf(canvas);

  it('has the expected proportions', () => {
    expect(canvas.width).toBe(8 * BALL_SHEET_CELL + 40);
    expect(canvas.height).toBe(2 * BALL_SHEET_CELL + 40);
  });

  const cellOf = (i: number) => {
    const col = i % 8;
    const row = Math.floor(i / 8);
    return {
      x: BALL_SHEET_PAD + BALL_SHEET_CELL * col,
      y: BALL_SHEET_PAD + BALL_SHEET_CELL * row,
    };
  };

  it('gives every numbered ball a white number patch', () => {
    for (let id = 1; id <= 15; id++) {
      const { x, y } = cellOf(id);
      let best = 0;
      for (let yy = y; yy < y + BALL_SHEET_CELL; yy++) {
        for (let xx = x; xx < x + BALL_SHEET_CELL; xx++) {
          const [r, g, b] = at(px, xx, yy);
          best = Math.max(best, Math.min(r, g, b));
        }
      }
      expect(best).toBeGreaterThan(200);
    }
  });

  it('uses the right colour for each solid and stripe', () => {
    for (let id = 1; id <= 7; id++) {
      for (const ballId of [id, id + 8]) {
        const { x, y } = cellOf(ballId);
        const target = HUE[id];
        let close = 0;
        for (let yy = y; yy < y + BALL_SHEET_CELL; yy++) {
          for (let xx = x; xx < x + BALL_SHEET_CELL; xx++) {
            const [r, g, b] = at(px, xx, yy);
            const d = Math.hypot(r - target[0], g - target[1], b - target[2]);
            if (d < 70) close++;
          }
        }
        expect(close).toBeGreaterThan(120);
      }
    }
  });

  it('paints the cue ball and the 8 differently', () => {
    const cue = cellOf(0);
    const eight = cellOf(8);
    const [cr] = at(px, cue.x + BALL_SHEET_CELL / 2 - 20, cue.y + BALL_SHEET_CELL / 2 - 20);
    const [er] = at(px, eight.x + BALL_SHEET_CELL / 2 - 20, eight.y + BALL_SHEET_CELL / 2 - 20);
    expect(cr).toBeGreaterThan(er + 60);
  });
});
