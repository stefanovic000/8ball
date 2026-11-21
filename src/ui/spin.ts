import { MAX_OFFSET } from '../core/constants';
import type { V2 } from '../core/math';

/**
 * The spin picker. A little cue ball you drag a dot around on.
 *
 * The value is the tip offset in units of the ball radius, so it maps straight
 * onto the physics without any conversion. Dragging past the dashed ring is not
 * allowed, because past that the tip would miscue.
 */
export class SpinPicker {
  value: V2 = { x: 0, y: 0 };
  onChange: (v: V2) => void = () => {};

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dragging = false;
  private enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;

    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.pick(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) this.pick(e);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointercancel', () => {
      this.dragging = false;
    });
    canvas.addEventListener('dblclick', () => this.set({ x: 0, y: 0 }));

    this.draw();
  }

  set(v: V2): void {
    this.value = v;
    this.draw();
    this.onChange(v);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.canvas.style.opacity = on ? '1' : '0.35';
    this.canvas.style.pointerEvents = on ? 'auto' : 'none';
  }

  private pick(e: PointerEvent): void {
    if (!this.enabled) return;
    const r = this.canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rad = r.width * 0.42;
    let x = (e.clientX - cx) / rad;
    let y = -(e.clientY - cy) / rad;
    const d = Math.hypot(x, y);
    if (d > MAX_OFFSET) {
      x = (x / d) * MAX_OFFSET;
      y = (y / d) * MAX_OFFSET;
    }
    this.set({ x, y });
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = c.clientWidth || 132;
    if (c.width !== Math.round(size * dpr)) {
      c.width = Math.round(size * dpr);
      c.height = Math.round(size * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = size;
    const cx = S / 2;
    const cy = S / 2;
    const R = S * 0.42;

    g.clearRect(0, 0, S, S);

    // ball
    const body = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.6, '#efece4');
    body.addColorStop(1, '#b9b4a8');
    g.fillStyle = body;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 1;
    g.stroke();

    // miscue limit
    g.save();
    g.setLineDash([3, 3]);
    g.strokeStyle = 'rgba(0,0,0,0.30)';
    g.beginPath();
    g.arc(cx, cy, R * MAX_OFFSET, 0, Math.PI * 2);
    g.stroke();
    g.restore();

    // crosshair
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.beginPath();
    g.moveTo(cx - R, cy);
    g.lineTo(cx + R, cy);
    g.moveTo(cx, cy - R);
    g.lineTo(cx, cy + R);
    g.stroke();

    // dot
    const px = cx + this.value.x * R;
    const py = cy - this.value.y * R;
    g.fillStyle = '#d93b3b';
    g.beginPath();
    g.arc(px, py, S * 0.035, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 1;
    g.stroke();
  }
}
