import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderBallSheet, renderTable } from './scene-render';
import { newRack, shoot, type Ball } from '../src/core/physics';

const OUT = join(process.cwd(), 'docs', 'preview');

function write(canvas: ReturnType<typeof renderTable>, name: string): void {
  writeFileSync(join(OUT, name), canvas.encodeSync('png'));
}

function ballsAtFrame(rack: Ball[], data: Float32Array, pocketed: number): Ball[] {
  return rack.map((b, i) => ({
    ...b,
    p: { x: data[i * 6], y: data[i * 6 + 1] },
    q: {
      x: data[i * 6 + 2],
      y: data[i * 6 + 3],
      z: data[i * 6 + 4],
      w: data[i * 6 + 5],
    },
    pocketed: ((pocketed >> i) & 1) === 1,
  }));
}

mkdirSync(OUT, { recursive: true });

const rack = newRack();
write(renderTable(rack), 'rack.png');
// The size it actually gets on a laptop screen, where legibility matters.
write(renderTable(rack, 1280, 800), 'table-1280.png');

const broken = shoot(rack, { aim: 0, power: 1, spin: { x: 0, y: 0 } }, 0, true);
const mid = Math.floor(broken.frames.length * 0.22);
const f = broken.frames[mid];
write(renderTable(ballsAtFrame(rack, f.data, f.pocketed), 1600, 820, 0), 'break.png');

const moved = shoot(rack, { aim: 0, power: 0.5, spin: { x: 0.35, y: 0 } }, 0, false);
const f2 = moved.frames[Math.floor(moved.frames.length * 0.1)];
write(renderTable(ballsAtFrame(rack, f2.data, f2.pocketed), 1600, 820, 0), 'english.png');

// Where the rack actually comes to rest, so the break can be judged as a whole.
const rest = broken.frames[broken.frames.length - 1];
write(renderTable(ballsAtFrame(rack, rest.data, rest.pocketed), 1600, 820, 0), 'break-end.png');

write(renderBallSheet(), 'balls.png');

console.log('wrote previews to', OUT);
console.log(`break: ${broken.frames.length} frames, ${broken.events.length} events`);
