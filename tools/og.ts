// Builds the social preview card. Run with: npx tsx tools/og.ts
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTable } from './scene-render';
import { newRack } from '../src/core/physics';

const W = 1200;
const H = 630;
mkdirSync(join(process.cwd(), 'public'), { recursive: true });

const canvas = createCanvas(W, H);
const g = canvas.getContext('2d');

const bg = g.createLinearGradient(0, 0, 0, H);
bg.addColorStop(0, '#0c1113');
bg.addColorStop(1, '#070a0b');
g.fillStyle = bg;
g.fillRect(0, 0, W, H);

g.fillStyle = '#eef3f0';
g.font = '600 60px "Segoe UI", Helvetica, Arial, sans-serif';
g.fillText('8ball', 70, 108);

g.fillStyle = '#8b9a95';
g.font = '400 24px "Segoe UI", Helvetica, Arial, sans-serif';
g.fillText('Pool physics, written from scratch.', 72, 150);

const tw = 900;
const th = 450;
const table = renderTable(newRack(), tw, th);
g.drawImage(table, (W - tw) / 2, 166, tw, th);

const out = join(process.cwd(), 'public', 'og.png');
writeFileSync(out, canvas.encodeSync('png'));
console.log('wrote', out);
