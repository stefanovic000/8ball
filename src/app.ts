import { newRack, shoot, type Ball, type Frame, type Shot } from './core/physics';
import {
  DEFAULT_RULES,
  isValidPlacement,
  newGame,
  type GameState,
  type Rules,
  type Ruleset,
  type Side,
} from './core/rules';
import { clamp, lerp } from './core/math';
import { Scene, type ViewState } from './render/scene';
import { SpinPicker } from './ui/spin';
import { TableAudio } from './audio';
import { Net } from './net/client';
import type { ServerMsg } from '../shared/protocol';

type Mode = 'practice' | 'online';

const STORE_KEY = '8ball.settings';
const SHOT_POWER = 0.55;
const BREAK_POWER = 1;

export class App {
  private scene: Scene;
  private spin: SpinPicker;
  private net: Net | null = null;
  private audio = new TableAudio();
  /** Code of the room this client is in, if any. */
  private roomCode: string | null = null;
  /** Seat token: the id the server gave the connection that joined. */
  private token: string | null = null;
  private helloId: string | null = null;
  private reconnectTimer = 0;
  private reconnectAttempts = 0;

  private mode: Mode = 'online';
  private side: Side = 0;
  private rules: Rules = { ...DEFAULT_RULES };
  private state: GameState | null = null;

  private aim = 0;
  private power = SHOT_POWER;
  private placing = false;
  private hover: { x: number; y: number } | null = null;

  private playFrames: Frame[] = [];
  private playT = 0;
  /** Wall-clock ms at which the current replay started. */
  private playStart = 0;
  private playDur = 0;
  private afterPlay: (() => void) | null = null;

  private clockEnd = 0;
  /** Last referee message shown, so the same call is not repeated. */
  private lastMessage = '';
  private toastUntil = 0;
  private names: [string, string] = ['Player', 'Opponent'];

  private el: Record<string, HTMLElement> = {};

  constructor() {
    const canvas = document.getElementById('table') as HTMLCanvasElement;
    this.scene = new Scene(canvas, document.getElementById('table-area'));
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
      'code',
      'hosted',
      'copylink',
      'joincode',
      'create',
    ]) {
      const node = document.getElementById(id);
      if (node) this.el[id] = node;
    }
    this.el.power = document.getElementById('power')!;
    this.el.powerFill = document.getElementById('powerfill')!;
    this.el.powerKnob = document.getElementById('powerknob')!;
    this.el.powerLabel = document.getElementById('powerlabel')!;

    this.wireSetup();
    this.wireInput();
    this.wirePower();
    this.updateSpinLabel();
    this.setRotated(window.innerWidth < window.innerHeight);

    window.addEventListener('resize', () => this.scene.resize());
    // Handy for the headless browser checks; harmless in production.
    (window as unknown as Record<string, unknown>).__game = this;
    requestAnimationFrame((t) => this.loop(t));
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

    for (const id of ['ruleset', 'clock', 'called', 'bih']) {
      document.getElementById(id)!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b) return;
        this.pickGroup(id, b.dataset.v ?? '');
        this.updateRulesSummary();
      });
    }

    // One button, two jobs: host a room, or close the one you are in.
    document.getElementById('create')!.addEventListener('click', () => {
      if (this.roomCode) this.leaveLobby();
      else this.createRoom();
    });
    document.getElementById('opensettings')!.addEventListener('click', () => {
      document.getElementById('settings')!.classList.remove('hidden');
    });
    document.getElementById('closesettings')!.addEventListener('click', () => {
      document.getElementById('settings')!.classList.add('hidden');
      this.updateRulesSummary();
    });
    document.getElementById('copylink')!.addEventListener('click', () => {
      const code = this.roomCode;
      if (!code) return;
      const link = `${location.origin}/?room=${code}`;
      void navigator.clipboard?.writeText(link).then(
        () => this.toast('Link copied.'),
        () => this.toast(link),
      );
    });
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
          this.pickGroup('ruleset', s.rules.ruleset ?? 'european');
          this.pickGroup('clock', String(s.rules.shotClock));
          this.pickGroup('called', s.rules.calledPockets ? '1' : '0');
          this.pickGroup('bih', s.rules.ballInHand);
        }
      } catch {
        /* ignore */
      }
    }

    this.syncSetupVisibility();
    this.updateRulesSummary();
    this.restoreSeat();
    this.readInvite();
  }

  private syncSetupVisibility(): void {
    const online = this.mode === 'online';
    document.getElementById('joinrow')!.style.display = online ? '' : 'none';
    this.el['mode-note']!.textContent = online
      ? 'Two players, one room. Same rules on both sides.'
      : 'Always your turn. Free ball in hand. No rules, just the table.';
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    const box = document.getElementById('mode')!;
    for (const b of Array.from(box.querySelectorAll('button'))) {
      b.classList.toggle('on', (b as HTMLElement).dataset.v === mode);
    }
    this.syncSetupVisibility();
  }

  /** A shared link carries the room code, so joining is one click. */
  private readInvite(): void {
    if (this.roomCode) return;
    const invited = new URLSearchParams(location.search).get('room');
    if (!invited) return;
    const code = invited.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!code) return;
    this.setMode('online');
    const input = document.getElementById('code') as HTMLInputElement | null;
    if (input) input.value = code;
    this.setStatus(`Room ${code} — press Join.`);
  }

  private saveSettings(): void {
    localStorage.setItem(STORE_KEY, JSON.stringify({ rules: this.rules, mode: this.mode }));
  }

  /** One line describing the match rules, shown on the setup screen. */
  private updateRulesSummary(): void {
    const el = document.getElementById('rulesummary');
    if (!el) return;
    const r = this.readRules();
    const set = r.ruleset === 'european' ? 'European' : 'American';
    const clock = r.shotClock > 0 ? `${r.shotClock}s clock` : 'no clock';
    const bih = r.ballInHand === 'behind' ? 'behind line' : 'ball in hand';
    el.textContent = `${set} · ${clock} · ${bih}`;
  }

  private readRules(): Rules {    return {
      ruleset: (this.readGroup('ruleset') as Ruleset) || 'european',
      shotClock: Number(this.readGroup('clock') || 30),
      calledPockets: this.readGroup('called') === '1',
      ballInHand: (this.readGroup('bih') as 'anywhere' | 'behind') || 'behind',
    };
  }

  private start(): void {
    this.rules = this.readRules();
    this.saveSettings();
    if (this.mode === 'practice') {
      this.beginPractice();
    } else if (this.roomCode) {
      // Already in a room: pressing Start must not look like the room failed.
      this.setStatus(`Waiting for an opponent. Room code ${this.roomCode} — send it to them.`);
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
    this.resetPractice();
    this.clockEnd = 0;
    this.toast('Click or press Space to break.');
  }

  private resetPractice(): void {
    this.state = newGame(newRack());
    this.playFrames = [];
    this.afterPlay = null;
    this.placing = false;
    this.hover = null;
    this.aim = 0;
    this.power = BREAK_POWER;
    this.spin.set({ x: 0, y: 0 });
    this.toast('Fresh rack.');
  }

  private applyPractice(balls: Ball[]): void {
    if (!this.state) return;
    if (this.state.onBreak) {
      this.state.onBreak = false;
      this.power = SHOT_POWER;
    }
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
      this.net.onClose = () => this.onDrop();
      this.net.onOpen = () => {
        // Either we were mid-game, or a reload restored a held seat: both mean
        // this connection has to claim it back before anything else.
        if (this.roomCode && this.token) {
          this.net!.send({ t: 'rejoin', code: this.roomCode, token: this.token });
        }
      };
    }
    return this.net;
  }

  /** The socket went away. If a seat is involved, try to get back to it. */
  private onDrop(): void {
    this.net = null;
    if (this.roomCode && this.token) {
      this.setStatus('Connection lost. Reconnecting...');
      this.scheduleReconnect();
      return;
    }
    this.roomCode = null;
    this.setStatus('Disconnected.');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= 10) {
      this.roomCode = null;
      this.clearSeat();
      this.setStatus('Could not reconnect.');
      return;
    }
    const delay = Math.min(4000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      this.reconnectAttempts += 1;
      this.setStatus(`Reconnecting… (${this.reconnectAttempts})`);
      this.ensureNet();
    }, delay);
  }

  /**
   * A seat is worth remembering across a reload: the server holds it for a
   * minute, so coming back with the same token puts you straight into the game.
   */
  private saveSeat(): void {
    if (!this.roomCode || !this.token) return;
    try {
      sessionStorage.setItem('8ball.seat', JSON.stringify({ code: this.roomCode, token: this.token }));
    } catch {
      /* storage can be unavailable */
    }
  }

  private clearSeat(): void {
    try {
      sessionStorage.removeItem('8ball.seat');
    } catch {
      /* ignore */
    }
  }

  private restoreSeat(): void {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem('8ball.seat');
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as { code?: string; token?: string };
      if (!s.code || !s.token) return;
      this.roomCode = s.code;
      this.token = s.token;
      this.setStatus(`Rejoining room ${s.code}…`);
      this.ensureNet();
    } catch {
      this.clearSeat();
    }
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

  /**
   * While you are in a room the join box is pointless: there is nothing to
   * join. Show the code where the box was and turn the button into a way out.
   */
  private showLobby(inRoom: boolean, code = ''): void {
    this.el.code.classList.toggle('hidden', inRoom);
    this.el.hosted.classList.toggle('hidden', !inRoom);
    this.el.hosted.textContent = inRoom ? code : '';
    this.el.joincode.classList.toggle('hidden', inRoom);
    this.el.copylink.classList.toggle('hidden', !inRoom);
    this.el.create.textContent = inRoom ? 'Close lobby' : 'Create room';
    this.el.create.classList.toggle('primary', !inRoom);
  }

  private leaveLobby(): void {
    this.net?.send({ t: 'leave' });
    this.roomCode = null;
    this.token = null;
    this.clearSeat();
    this.state = null;
    this.playFrames = [];
    this.showLobby(false);
    this.el.room.classList.add('hidden');
    this.setStatus('Left the room.');
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
      case 'hello': {
        // Remember what this connection is called; the first one doubles as the
        // seat token until a room hands us our own.
        this.helloId = m.id;
        if (!this.token) this.token = m.id;
        break;
      }
      case 'room': {
        this.side = m.room.you;
        this.names = [m.room.names[0], m.room.names[1] ?? 'waiting'];
        this.rules = m.room.rules;
        // We are in: hold the id this connection was given as the seat token,
        // and stop trying to reconnect.
        this.token = this.helloId;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = 0;
        }
        this.el.room!.textContent = m.room.code;
        this.el.room!.classList.remove('hidden');
        this.roomCode = m.room.code;
        this.saveSeat();
        this.showLobby(true, m.room.code);
        this.setStatus(
          m.room.names[1]
            ? 'Opponent connected. Starting...'
            : `Waiting for an opponent. Room code ${m.room.code} — send it to them.`,
        );
        break;
      }
      case 'start': {
        this.el.setup.classList.add('hidden');
        this.el.gameover.classList.add('hidden');
        this.state = m.state;
        this.aim = 0;
        this.spin.set({ x: 0, y: 0 });
        this.power = m.state.onBreak && m.state.turn === this.side ? BREAK_POWER : SHOT_POWER;
        this.placing = m.state.ballInHand && m.state.turn === this.side;
        this.resetClock();
        this.toast(m.state.turn === this.side ? 'Your break.' : 'Opponent breaks.');
        break;
      }
      case 'shot': {
        // The server is authoritative, so take its state immediately and treat
        // the animation as decoration. Otherwise a hidden tab holds back the
        // real board, and a second shot would be re-simulated from a stale one.
        const before = this.state;
        this.adopt(m.state);
        if (m.by !== this.side && before) {
          const res = shoot(before.balls, m.shot, 0, before.onBreak);
          // The server already resolved this shot; re-simulating is only for
          // the animation. If the two disagree this client is running
          // different physics, so play its version for the motion but let the
          // server's board win the moment the shot ends.
          if (maxDrift(res.balls, m.state.balls) > 0.001) {
            console.warn('physics mismatch with the server; correcting to its board when the shot ends');
          }
          this.note({ side: 'receiver', frames: res.frames.length, drift: Number(maxDrift(res.balls, m.state.balls).toFixed(4)) });
          this.audio.play(res.events);
          this.startReplay(res.frames);
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
      case 'bye': {
        // The room is gone on the server; put the setup screen back.
        this.roomCode = null;
        this.token = null;
        this.clearSeat();
        this.state = null;
        this.playFrames = [];
        this.showLobby(false);
        this.el.room.classList.add('hidden');
        this.el.setup.classList.remove('hidden');
        this.el.gameover.classList.add('hidden');
        this.setStatus('The other player left.');
        this.toast('The other player left.');
        break;
      }
      default:
        break;
    }
  }

  private adopt(s: GameState): void {
    if (this.state?.onBreak && this.state.turn === this.side && !s.onBreak) {
      this.power = SHOT_POWER;
    }
    this.state = s;
    // Say what the referee decided: a foul reason, or the visits left.
    if (s.message !== this.lastMessage) {
      this.lastMessage = s.message;
      if (s.message) this.toast(s.message);
    }
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

  private wirePower(): void {
    const el = this.el.power!;
    const track = document.getElementById('powertrack')!;
    let dragging = false;

    const apply = (clientY: number): void => {
      const r = track.getBoundingClientRect();
      if (r.height <= 0) return;
      this.power = clamp(1 - (clientY - r.top) / r.height, 0.05, 1);
    };

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      apply(e.clientY);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (dragging) apply(e.clientY);
    });
    el.addEventListener('pointerup', (e) => {
      dragging = false;
      el.releasePointerCapture(e.pointerId);
    });
    el.addEventListener('pointercancel', () => {
      dragging = false;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.power = clamp(this.power - e.deltaY * 0.0012, 0.05, 1);
      },
      { passive: false },
    );
  }

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
          if (this.mode === 'practice' && this.state) this.resetPractice();
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
    // A pocketed cue ball cannot be struck. Without this the shot went out with
    // nothing to simulate, so the board never moved.
    const cue = this.state.balls.find((b) => b.id === 0);
    if (!cue || cue.pocketed) return false;
    if (this.mode === 'practice') return true;
    return this.state.turn === this.side;
  }

  private doShoot(): void {
    if (!this.canShoot() || !this.state) return;
    const shot: Shot = { aim: this.aim, power: this.power, spin: { ...this.spin.value } };
    const res = shoot(this.state.balls, shot, 0, this.state.onBreak);
    if (this.mode === 'practice') {
      this.audio.cue(this.power);
      this.audio.play(res.events);
      this.startReplay(res.frames, () => this.applyPractice(res.balls));
      return;
    }
    this.audio.cue(this.power);
    this.audio.play(res.events);
    this.note({ side: 'shooter', frames: res.frames.length, power: Number(this.power.toFixed(2)) });
    this.net?.send({ t: 'shot', shot });
    this.clockEnd = 0;
    this.startReplay(res.frames);
  }

  // ------------------------------------------------------------- playback

  /**
   * Keeps a short record of recent shots so a one-off glitch can be looked at
   * afterwards instead of guessed at. Read it with `window.__shotLog`.
   */
  private note(entry: Record<string, unknown>): void {
    const w = window as unknown as { __shotLog?: Array<Record<string, unknown>> };
    w.__shotLog ??= [];
    w.__shotLog.push({ t: Date.now(), mode: this.mode, hidden: document.hidden, ...entry });
    if (w.__shotLog.length > 10) w.__shotLog.shift();
  }

  private startReplay(frames: Frame[], done?: () => void): void {
    if (frames.length < 2) {
      done?.();
      return;
    }
    this.playFrames = frames;
    this.playT = 0;
    this.playStart = Date.now();
    this.playDur = frames[frames.length - 1].t;
    this.afterPlay = done ?? null;
  }

  private endPlayback(): void {
    if (this.playFrames.length > 0) {
      this.note({
        side: 'endPlayback',
        dur: Number(this.playDur.toFixed(2)),
        played: Number(((Date.now() - this.playStart) / 1000).toFixed(2)),
      });
    }
    this.playFrames = [];
    this.playT = 0;
    const done = this.afterPlay;
    this.afterPlay = null;
    done?.();
    this.spin.set({ x: 0, y: 0 });
  }

  private displayBalls(): Ball[] {
    if (!this.state) return [];
    if (this.playFrames.length === 0) return this.state.balls;

    const fs = this.playFrames;
    // Frames are not evenly spaced - contacts produce clusters of very short
    // steps - so the time has to be found by timestamp. Indexing at a fixed
    // 240Hz made those clusters look like the table had frozen.
    const t = this.playT;
    let lo = 0;
    let hi = fs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fs[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const i0 = lo;
    const i1 = Math.min(i0 + 1, fs.length - 1);
    const span = fs[i1].t - fs[i0].t;
    const a = span > 1e-9 ? (t - fs[i0].t) / span : 0;
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
    if (this.playFrames.length > 0) {
      // Wall clock, not accumulated frame deltas. A hidden tab stops getting
      // frames, and a paused animation must not hold the board - or the turn -
      // back once the tab is visible again: by then the shot is over.
      this.playT = (Date.now() - this.playStart) / 1000;
      if (this.playT >= this.playDur) {
        this.playT = this.playDur;
        this.endPlayback();
      }
    }

    if (this.clockEnd && now > this.clockEnd) {
      this.clockEnd = 0;
      this.toast('Shot clock expired.');
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
    this.el.powerKnob!.style.bottom = `${pct}%`;
    this.el.powerLabel!.textContent = `${pct}%`;
    this.el.power!.setAttribute('aria-valuenow', String(pct));
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

/**
 * How far apart two resolved tables are, in metres. Infinite when they disagree
 * about which balls went down, since a position difference is meaningless then.
 */
function maxDrift(a: Ball[], b: Ball[]): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pocketed !== b[i].pocketed) return Infinity;
    worst = Math.max(worst, Math.hypot(a[i].p.x - b[i].p.x, a[i].p.y - b[i].p.y));
  }
  return worst;
}
