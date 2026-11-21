import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { renderTable } from './scene-render';
import { newRack } from '../src/core/physics';

const base = renderTable(newRack(), 1280, 800);
const size = 150, zoom = 5;
const out = createCanvas(size * zoom, size * zoom);
const g = out.getContext('2d');
g.imageSmoothingEnabled = false;
g.drawImage(base, 923 - size / 2, 400 - size / 2, size, size, 0, 0, size * zoom, size * zoom);
writeFileSync('docs/preview/ui-zoom.png', out.encodeSync('png'));
console.log('ok');
