import { createCanvas } from '@napi-rs/canvas';

/**
 * The renderer only touches a couple of DOM APIs, so a tiny shim is enough to
 * run it in Node. That is how the visual tests and the preview images work
 * without a browser.
 */
export function installDomShim(width: number, height: number): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.document) {
    g.document = {
      createElement(tag: string) {
        if (tag !== 'canvas') throw new Error(`shim cannot create <${tag}>`);
        return createCanvas(1, 1);
      },
    };
  }
  g.window = {
    devicePixelRatio: 1,
    innerWidth: width,
    innerHeight: height,
    addEventListener() {},
    removeEventListener() {},
  };
}
