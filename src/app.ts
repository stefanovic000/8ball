import { newRack, shoot, type Ball, type Frame, type Shot } from './core/physics';
import { isValidPlacement, newGame, type GameState, type Rules, type Side } from './core/rules';
import { clamp, lerp } from './core/math';
import { Scene, type ViewState } from './render/scene';
import { SpinPicker } from './ui/spin';
import { Net } from './net/client';
import type { ServerMsg } from '../shared/protocol';

type Mode = 'practice' | 'online';

const STORE_KEY = '8ball.settings';

export class App {
  private scene: Scene;
  private spin: SpinPicker;
  private net: Net | null = null;

  private mode: Mode = 'practice';
  private side: Side = 0;
  private rules: Rules = { shotClock: 30, calledPockets: false, ballInHand: 'anywhere' };
  private state: GameState | null = null;

  private aim = 0;
  private power = 0.55;
  private placing = false;
  private hover: { x: number; y: number } | null = null;

  private playFrames: Frame[] = [];
  private playT = 0;
  private playDur = 0;
  private afterPlay: (() => void) | null = null;
  private pending: GameState | null = null;

  private last = 0;
  private clockEnd = 0;
  private toastUntil = 0;
  private names: [string, string] = ['Player', 'Opponent'];

  private el: Record<string, HTMLElement> = {};

  constructor() {
    const canvas = document.getElementById('table') as HTMLCanvasElement;
    this.scene = new Scene(canvas);
    this.scene.resize();

    const spinCanvas = document.getElementById('spin') as HTMLCanvasElement;
    this.spin = new SpinPicker(spinCanvas);
    this.spin.onChange = () => this.updateSpinLabel();

    for (const id of [
      'setup',
      'players',
      'room',
      'hint',
      'toast',
      'gameover',
      'gtitle',
      'gsub',
      'status',
      'mode-note',
      'spinlabel',
      'controls',
    ]) {
      const node = document.getElementById(id);
      if (node) this.el[id] = node;
    }
    this.el.power = document.getElementById('power')!;
    this.el.powerFill = document.getElementById('powerfill')!;

    this.wireSetup();
    this.wireInput();
    this.updateSpinLabel();
    this.setRotated(window.innerWidth < window.innerHeight);

    window.addEventListener('resize', () => this.scene.resize());
    requestAnimationFrame((t) => {
      this.last = t;
      this.loop(t);
    });
  }

  // ---------------------------------------------------------------- setup

  private pickGroup(id: string, value: string): void {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    for (const b of Array.from(wrap.querySelectorAll('button'))) {
      b.classList.toggle('on', (b as HTMLElement).dataset.v === value);
    }
  }

  private readGroup(id: string): string {
    const wrap = document.getElementById(id);
    const on = wrap?.querySelector('button.on') as HTMLElement | null;
    return on?.dataset.v ?? '';
  }

  private wireSetup(): void {
    const modes = document.getElementById('mode')!;
    modes.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      this.mode = (b.dataset.v as Mode) ?? 'practice';
      for (const x of Array.from(modes.querySelectorAll('button'))) {
        x.classList.toggle('on', x === b);
      }
      this.syncSetupVisibility();
    });

    for (const id of ['clock', 'called', 'bih']) {
      document.getElementById(id)!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b) return;
        this.pickGroup(id, b.dataset.v ?? '');
      });
    }

    document.getElementById('create')!.addEventListener('click', () => this.createRoom());
    document.getElementById('joincode')!.addEventListener('click', () => this.joinRoom());
    document.getElementById('start')!.addEventListener('click', () => this.start());
    document.getElementById('rotate')!.addEventListener('click', () => this.toggleRotate());

    document.getElementById('again')!.addEventListener('click', () => {
      this.el.gameover.classList.add('hidden');
      if (this.mode === 'practice') this.resetPractice();
      else this.net?.send({ t: 'rematch' });
    });
    document.getElementById('tomenu')!.addEventListener('click', () => location.reload());

    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      try {
        const s = JSON.parse(saved) as { rules?: Rules; mode?: Mode };
        if (s.rules) {
          this.rules = s.rules;
          this.pickGroup('clock', String(s.rules.shotClock));
          this.pickGroup('called', s.rules.calledPockets ? '1' : '0');
          this.pickGroup('bih', s.rules.ballInHand);
        }
      } catch {
        /* ignore */
      }
    }

    this.syncSetupVisibility();
  }

  private syncSetupVisibility(): void {
    const online = this.mode === 'online';
    document.getElementById('joinrow')!.style.display = online ? '' : 'none';
    this.el['mode-note']!.textContent = online
      ? 'Two players, one room. Same rules on both sides.'
      : 'Always your turn. Free ball in hand. No rules, just the table.';
  }

  private saveSettings(): void {
    localStorage.setItem(STORE_KEY, JSON.stringify({ rules: this.rules, mode: this.mode }));
  }

  private readRules(): Rules {
    return {
      shotClock: Number(this.readGroup('clock') || 30),
      calledPockets: this.readGroup('called') === '1',
      ballInHand: (this.readGroup('bih') as 'anywhere' | 'behind') || 'anywhere',
    };
  }

  private start(): void {
    this.rules = this.readRules();
    this.saveSettings();
    if (this.mode === 'practice') {
      this.beginPractice();
    } else {
      this.setStatus('Create a room, or join one with a code.');
    }
  }

  private setStatus(s: string): void {
    this.el.status!.textContent = s;
  }

  // ------------------------------------------------------------ practice

  private beginPractice(): void {
    this.el.setup.classList.add('hidden');
    const balls = newRack();
    this.state = newGame(balls);
    this.state.onBreak = false;
    this.state.groups = ['open', 'open'];
    this.state.turn = 0;
    this.aim = 0;
    this.power = 0.55;
    this.clockEnd = 0;
    this.toast('Click to shoot. Wheel for power. Drag the ball to add spin.');
  }

  private resetPractice(): void {
    if (!this.state) return;
    this.state = newGame(newRack());
    this.state.onBreak = false;
    this.state.groups = ['open', 'open'];
    this.state.turn = 0;
    this.placing = false;
    this.toast('Fresh rack.');
  }

  private applyPractice(balls: Ball[]): void {
    if (!this.state) return;
    this.state.balls = balls;
    const cue = balls.find((b) => b.id === 0)!;
    if (cue.pocketed) {
      cue.pocketed = false;
      cue.p.x = -0.635;
      cue.p.y = 0;
      cue.v = { x: 0, y: 0 };
      cue.w = { x: 0, y: 0, z: 0 };
      cue.q = { x: 0, y: 0, z: 0, w: 1 };
      this.placing = true;
      this.toast('Scratched. Click to place the cue ball.');
      return;
    }
    // The 8 back on the table, so practice never ends.
    const eight = balls.find((b) => b.id === 8)!;
    if (eight.pocketed) {
      eight.pocketed = false;
      eight.p.x = 0.635;
      eight.p.y = 0;
      eight.v = { x: 0, y: 0 };
      eight.w = { x: 0, y: 0, z: 0 };
      this.toast('8 spotted.');
    }
  }

  // ---------------------------------------------------------------- online

  private ensureNet(): Net {
    if (!this.net) {
      this.net = new Net();
      this.net.onMessage = (m) => this.onServer(m);
      this.net.onClose = () => this.setStatus('Disconnected.');
    }
    return this.net;
  }

  private readName(): string {
    const el = document.getElementById('name') as HTMLInputElement | null;
    const v = (el?.value ?? '').trim().slice(0, 16);
    return v.length > 0 ? v : 'Player';
  }

  private createRoom(): void {
    this.rules = this.readRules();
    this.saveSettings();
    this.names[0] = this.readName();
    this.ensureNet();
    this.net!.send({ t: 'create', name: this.names[0], rules: this.rules });
    this.setStatus('Creating room...');
  }

  private joinRoom(): void {
    this.rules = this.readRules();
    this.saveSettings();
    this.names[0] = this.readName();
    const code = (document.getElementById('code') as HTMLInputElement).value
      .trim()
      .toUpperCase();
    if (!code) {
      this.setStatus('Enter a room code.');
      return;
    }
    this.ensureNet();
    this.net!.send({ t: 'join', name: this.names[0], code });
    this.setStatus('Joining...');
  }

  private onServer(m: ServerMsg): void {
    switch (m.t) {
      case 'room': {
        this.side = m.room.you;
        this.names = [m.room.names[0], m.room.names[1] ?? 'waiting'];
        this.rules = m.room.rules;
        this.el.room!.textContent = m.room.code;
        this.el.room!.classList.remove('hidden');
        this.setStatus(
          m.room.names[1] ? 'Opponent connected. Starting...' : 'Waiting for an opponent.',
        );
        break;
      }
      case 'start': {
        this.el.setup.classList.add('hidden');
        this.el.gameover.classList.add('hidden');
        this.state = m.state;
        this.placing = m.state.ballInHand && m.state.turn === this.side;
        this.resetClock();
        this.toast(m.state.turn === this.side ? 'Your break.' : 'Opponent breaks.');
        break;
      }
      case 'shot': {
        this.pending = m.state;
        if (m.by !== this.side && this.state) {
          const res = shoot(this.state.balls, m.shot);
          this.startReplay(res.frames);
        } else {
          // our own shot: we already animated it
        }
        break;
      }
      case 'state': {
        this.adopt(m.state);
        break;
      }
      case 'error': {
        this.setStatus(m.message);
        this.toast(m.message);
        break;
      }
      default:
        break;
    }
  }

  private adopt(s: GameState): void {
    this.state = s;
    this.placing = s.ballInHand && s.turn === this.side;
    this.resetClock();
    if (s.over) {
      this.el.gtitle!.textContent =
        s.over.winner === this.side ? 'You win' : 'You lose';
      this.el.gsub!.textContent = s.over.reason;
      this.el.gameover.classList.remove('hidden');
    }
  }

  private resetClock(): void {
    if (!this.state) return;
    if (this.mode !== 'online' || this.rules.shotClock <= 0) {
      this.clockEnd = 0;
      return;
    }
    this.clockEnd =
      this.state.turn === this.side && !this.state.over
        ? performance.now() + this.rules.shotClock * 1000
        : 0;
  }

  // ----------------------------------------------------------------- input

  private wireInput(): void {
    const canvas = document.getElementById('table') as HTMLCanvasElement;
    let downAt: { x: number; y: number } | null = null;

    canvas.addEventListener('pointermove', (e) => {
      const w = this.scene.screenToWorld(e.clientX, e.clientY);
      if (this.placing) {
        this.hover = w;
        return;
      }
      if (!this.canShoot()) return;
      const cue = this.cueBall();
      if (!cue) return;
      this.aim = Math.atan2(w.y - cue.p.y, w.x - cue.p.x);
    });

    canvas.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY };
      if (this.placing) {
        this.hover = this.scene.screenToWorld(e.clientX, e.clientY);
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 8) return;
      if (this.placing) this.tryPlace(e.clientX, e.clientY);
      else this.doShoot();
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.power = clamp(this.power - e.deltaY * 0.0012, 0.05, 1);
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const fine = e.shiftKey ? 0.002 : 0.01;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.doShoot();
          break;
        case 'ArrowLeft':
          this.aim -= fine;
          break;
        case 'ArrowRight':
          this.aim += fine;
          break;
        case 'ArrowUp':
          this.power = clamp(this.power + 0.02, 0.05, 1);
          break;
        case 'ArrowDown':
          this.power = clamp(this.power - 0.02, 0.05, 1);
          break;
        case 'r':
        case 'R':
          this.toggleRotate();
          break;
        case 'b':
        case 'B':
          if (this.mode === 'practice') this.placing = true;
          break;
        case 'n':
        case 'N':
          if (this.mode === 'practice') this.resetPractice();
          break;
        case 'Escape':
          location.reload();
          break;
        default:
          break;
      }
    });
  }

  private tryPlace(sx: number, sy: number): void {
    if (!this.state) return;
    const w = this.scene.screenToWorld(sx, sy);
    const behindOnly =
      this.mode === 'online' && this.rules.ballInHand === 'behind' && this.state.onBreak;
    if (!isValidPlacement(this.state.balls, w.x, w.y, behindOnly)) {
      this.toast('No room there.');
      return;
    }
    const cue = this.cueBall();
    if (!cue) return;
    cue.p.x = w.x;
    cue.p.y = w.y;
    cue.v = { x: 0, y: 0 };
    cue.w = { x: 0, y: 0, z: 0 };
    cue.pocketed = false;
    this.placing = false;
    this.hover = null;
    if (this.mode === 'online') {
      this.net?.send({ t: 'place', x: w.x, y: w.y });
      this.resetClock();
    }
  }

  private cueBall(): Ball | null {
    return this.state?.balls.find((b) => b.id === 0) ?? null;
  }

  private canShoot(): boolean {
    if (!this.state || this.state.over) return false;
    if (this.playFrames.length > 0 || this.placing) return false;
    if (this.mode === 'practice') return true;
    return this.state.turn === this.side;
  }

  private doShoot(): void {
    if (!this.canShoot() || !this.state) return;
    const shot: Shot = { aim: this.aim, power: this.power, spin: { ...this.spin.value } };
    const res = shoot(this.state.balls, shot);
    if (this.mode === 'practice') {
      this.startReplay(res.frames, () => this.applyPractice(res.balls));
      return;
    }
    this.net?.send({ t: 'shot', shot });
    this.clockEnd = 0;
    this.startReplay(res.frames);
  }

  // ------------------------------------------------------------- playback

  private startReplay(frames: Frame[], done?: () => void): void {
    if (frames.length < 2) {
      done?.();
      return;
    }
    this.playFrames = frames;
    this.playT = 0;
    this.playDur = frames[frames.length - 1].t;
    this.afterPlay = done ?? null;
  }

  private endPlayback(): void {
    this.playFrames = [];
    this.playT = 0;
    const done = this.afterPlay;
    this.afterPlay = null;
    done?.();
    if (this.pending) {
      const s = this.pending;
      this.pending = null;
      this.adopt(s);
    }
  }

  private displayBalls(): Ball[] {
    if (!this.state) return [];
    if (this.playFrames.length === 0) return this.state.balls;

    const fs = this.playFrames;
    const f = this.playT * 240;
    const i0 = clamp(Math.floor(f), 0, fs.length - 1);
    const i1 = Math.min(i0 + 1, fs.length - 1);
    const a = f - i0;
    const A = fs[i0];
    const B = fs[i1];

    return this.state.balls.map((ball, i) => {
      const o = i * 6;
      return {
        ...ball,
        p: {
          x: lerp(A.data[o], B.data[o], a),
          y: lerp(A.data[o + 1], B.data[o + 1], a),
        },
        q: {
          x: lerp(A.data[o + 2], B.data[o + 2], a),
          y: lerp(A.data[o + 3], B.data[o + 3], a),
          z: lerp(A.data[o + 4], B.data[o + 4], a),
          w: lerp(A.data[o + 5], B.data[o + 5], a),
        },
        pocketed: ((A.pocketed >> i) & 1) === 1,
      };
    });
  }

  // ---------------------------------------------------------------- frame

  private loop(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    if (this.playFrames.length > 0) {
      this.playT += dt;
      if (this.playT >= this.playDur) {
        this.playT = this.playDur;
        this.endPlayback();
      }
    }

    if (this.clockEnd && now > this.clockEnd) {
      this.clockEnd = 0;
      this.toast('Shot clock expired.');
      if (this.mode === 'online') this.net?.send({ t: 'timeout' });
    }

    this.draw();
    this.updateHud(now);
    requestAnimationFrame((t) => this.loop(t));
  }

  private draw(): void {
    const balls = this.displayBalls();
    const view: ViewState = {
      balls,
      cueBallId: 0,
      aim: this.aim,
      power: this.power,
      spin: this.spin.value,
      showAim: this.canShoot() || this.placing,
      placing: this.placing,
      hover: this.hover,
    };
    this.scene.draw(view);

    const pct = Math.round(this.power * 100);
    this.el.powerFill!.style.height = `${pct}%`;
  }

  private updateHud(now: number): void {
    if (!this.state) return;
    const [a, b] = this.state.groups;
    const meActive = this.state.turn === this.side || this.mode === 'practice';
    this.el.players!.innerHTML = `
      <div class="p ${meActive ? 'on' : ''}">
        <span class="nm">${escapeHtml(this.names[0])}</span>
        <span class="grp">${a === 'open' ? '-' : a === 'solids' ? 'solids 1-7' : 'stripes 9-15'}</span>
      </div>
      <div class="p ${!meActive ? 'on' : ''}">
        <span class="nm">${escapeHtml(this.names[1])}</span>
        <span class="grp">${b === 'open' ? '-' : b === 'solids' ? 'solids 1-7' : 'stripes 9-15'}</span>
      </div>`;

    const toastEl = this.el.toast!;
    if (this.toastUntil > now) toastEl.classList.remove('hidden');
    else toastEl.classList.add('hidden');

    const hint = this.el.hint!;
    if (this.clockEnd) {
      const left = Math.max(0, (this.clockEnd - now) / 1000);
      hint.textContent = `${left.toFixed(0)}s`;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }

    if (this.state.over) this.el.players!.classList.add('dim');
    else this.el.players!.classList.remove('dim');
  }

  private toast(msg: string): void {
    if (!msg) return;
    this.el.toast!.textContent = msg;
    this.el.toast!.classList.remove('hidden');
    this.toastUntil = performance.now() + 2600;
  }

  private updateSpinLabel(): void {
    const { x, y } = this.spin.value;
    const parts: string[] = [];
    if (y > 0.04) parts.push(`follow ${Math.round(y * 200)}%`);
    else if (y < -0.04) parts.push(`draw ${Math.round(-y * 200)}%`);
    if (x > 0.04) parts.push(`right ${Math.round(x * 200)}%`);
    else if (x < -0.04) parts.push(`left ${Math.round(-x * 200)}%`);
    this.el.spinlabel!.textContent = parts.length ? parts.join(' · ') : 'neutral';
  }

  private toggleRotate(): void {
    this.scene.setRotated(!this.scene.isRotated());
    this.scene.resize();
  }

  private setRotated(v: boolean): void {
    this.scene.setRotated(v);
    this.scene.resize();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
