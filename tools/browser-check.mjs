// Loads the built game in a real browser, plays a shot, and writes screenshots.
// Run it against `npm run server` with dist/ built.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.URL ?? 'http://127.0.0.1:8787/';
const OUT = join(process.cwd(), 'docs', 'preview');
const EXE =
  process.env.CHROME ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('#setup', { state: 'visible' });
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, 'ui-setup.png') });

// Online is the default now, so pick Practice explicitly before starting.
await page.click('#mode button[data-v="practice"]');
await page.waitForTimeout(120);
await page.click('#start');
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, 'ui-table.png') });

// Aim to the right of the cue ball and take a break.
const aim = await page.evaluate(() => window.__game.scene.worldToScreen({ x: 0.3, y: 0 }));
await page.mouse.move(aim.x, aim.y);
await page.waitForTimeout(120);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(260);
await page.screenshot({ path: join(OUT, 'ui-shot.png') });
await page.waitForTimeout(2600);
await page.screenshot({ path: join(OUT, 'ui-after.png') });

// Vertical table.
await page.click('#rotate');
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'ui-rotated.png') });

const state = await page.evaluate(() => {
  const c = document.getElementById('table');
  return {
    canvas: c ? [c.width, c.height] : null,
    setupHidden: document.getElementById('setup')?.classList.contains('hidden'),
  };
});

console.log('canvas', state.canvas, 'setupHidden', state.setupHidden);
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no console errors');

await browser.close();
