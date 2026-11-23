import { newRack, shoot, type Ball, type Frame, type Shot } from './core/physics';
import {
  DEFAULT_RULES,
  behindLineOnly,
  isValidPlacement,
  newGame,
  respotPoint,
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
  /** Where the other player is lining up, while they are on strike. */
  private peerAim: { aim: number; power: number } | null = null;
  /** True while the other seat is away and the turn is frozen. */
  private holding = false;
  /** Set when the player leaves on purpose: no reconnect, no late messages. */
  private abandoned = false;
  /** Where focus was before the leave confirmation opened. */
  private leaveReturn: HTMLElement | null = null;
  /** Last known visibility of the in-game Leave button. */
  private leaveShown = false;
  /** The confirmation was dismissed by a room teardown, not by the player. */
  private leaveWasOpen = false;
  /** Last known menu visibility, for the body class that hides match chrome. */
  private menuShown = false;
  private lastAimSent = 0;
  private lastAim = { aim: 0, power: 0 };
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
      'home',
      'hostview',
      'joinview',
      'waiting',
      'gohost',
      'gojoin',
      'gosolo',
      'backfromhost',
      'backfromjoin',
      'closelobby',
      'copycode',
      'rulesummary',
      'spinlabel',
      'controls',
      'code',
      'hosted',
      'copylink',
      'joincode',
      'create',
      'leavebtn',
      'leave',
      'stay',
      'leavematch',
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
    // Three plain choices. Each one opens its own view; nothing else on the
    // home screen decides between hosting, joining and playing alone.
    document.getElementById('gohost')!.addEventListener('click', () => {
      this.setMode('online');
      this.showMenu('hostview');
      (document.getElementById('name') as HTMLInputElement | null)?.focus();
    });
    document.getElementById('gojoin')!.addEventListener('click', () => {
      this.setMode('online');
      this.showMenu('joinview');
      (document.getElementById('code') as HTMLInputElement | null)?.focus();
    });
    document.getElementById('gosolo')!.addEventListener('click', () => {
      this.setMode('practice');
      this.beginPractice();
    });
    document.getElementById('backfromhost')!.addEventListener('click', () => this.showMenu('home'));
    document.getElementById('backfromjoin')!.addEventListener('click', () => this.showMenu('home'));

    // Enter submits from either form, so a code can be typed and sent without
    // reaching for the mouse.
    (document.getElementById('code') as HTMLInputElement).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoom();
    });
    (document.getElementById('name') as HTMLInputElement).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createRoom();
    });

    for (const id of ['ruleset', 'clock', 'called', 'bih']) {
      document.getElementById(id)!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b) return;
        this.pickGroup(id, b.dataset.v ?? '');
        this.updateRulesSummary();
      });
    }

    document.getElementById('create')!.addEventListener('click', () => this.createRoom());
    document.getElementById('closelobby')!.addEventListener('click', () => this.leaveLobby());
    const settingsPanel = document.getElementById('settings')!;
    document.getElementById('opensettings')!.addEventListener('click', () => {
      settingsPanel.classList.remove('hidden');
    });
    document.getElementById('closesettings')!.addEventListener('click', () => {
      this.closeSettings();
    });    // Escape and a click on the dimmed backdrop close it the same way Done
    // does. Clicks inside the panel are left alone. Escape must not reload the
    // page or disturb the lobby behind it.
    settingsPanel.addEventListener('click', (e) => {
      if (e.target === settingsPanel) this.closeSettings();
    });
    document.getElementById('copylink')!.addEventListener('click', () => {
      const code = this.roomCode;
      if (!code) return;
      const link = `${location.origin}/?room=${code}`;
      void navigator.clipboard?.writeText(link).then(
        () => this.toast('Invite link copied.'),
        () => this.toast(link),
      );
    });
    document.getElementById('copycode')!.addEventListener('click', () => {
      const code = this.roomCode;
      if (!code) return;
      void navigator.clipboard?.writeText(code).then(
        () => this.toast('Code copied.'),
        () => this.toast(code),
      );
    });
    document.getElementById('joincode')!.addEventListener('click', () => this.joinRoom());
    document.getElementById('rotate')!.addEventListener('click', () => this.toggleRotate());

    document.getElementById('again')!.addEventListener('click', () => {
      this.el.gameover.classList.add('hidden');
      if (this.mode === 'practice') this.resetPractice();
      else this.net?.send({ t: 'rematch' });
    });
    document.getElementById('tomenu')!.addEventListener('click', () => {
      // Back to menu is the same exit as Leave match: it must drop the seat,
      // not just reload and be put back in the same room by the stored token.
      if (this.roomCode) this.leaveMatch();
      else location.reload();
    });

    document.getElementById('leavebtn')!.addEventListener('click', () => this.openLeaveConfirm());
    document.getElementById('stay')!.addEventListener('click', () => this.closeLeaveConfirm());
    document.getElementById('leavematch')!.addEventListener('click', () => this.leaveMatch());
    // A click on the dimmed backdrop is the safe choice too.
    this.el.leave.addEventListener('click', (e) => {
      if (e.target === this.el.leave) this.closeLeaveConfirm();
    });

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

    this.showMenu('home');
    this.updateRulesSummary();
    this.restoreSeat();
    this.readInvite();
  }

  /** One menu, four views: the three entry choices and the waiting lobby. */
  private showMenu(view: 'home' | 'hostview' | 'joinview' | 'waiting'): void {
    for (const id of ['home', 'hostview', 'joinview', 'waiting'] as const) {
      this.el[id]?.classList.toggle('hidden', id !== view);
    }
    this.el.setup.classList.remove('hidden');
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.saveSettings();
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
    this.showMenu('joinview');
    this.setStatus(`Room ${code} is waiting. Press Join.`);
  }

  private saveSettings(): void {
    localStorage.setItem(STORE_KEY, JSON.stringify({ rules: this.rules, mode: this.mode }));
  }

  /** One close path, so Escape, the backdrop and Done cannot drift apart. */
  private closeSettings(): void {
    document.getElementById('settings')!.classList.add('hidden');
    this.updateRulesSummary();
  }

  // ------------------------------------------------------------- leaving

  /** The confirmation, with Stay focused so Enter and Escape both stay. */
  private openLeaveConfirm(): void {
    if (!this.roomCode) return;
    this.leaveReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.el.leave.classList.remove('hidden');
    this.el.stay.focus();
  }

  private closeLeaveConfirm(toSetup = false): void {
    if (this.el.leave.classList.contains('hidden')) return;
    this.el.leave.classList.add('hidden');
    const back = this.leaveReturn;
    this.leaveReturn = null;
    this.leaveWasOpen = false;
    if (!toSetup && back && back.isConnected && !back.classList.contains('hidden')) {
      back.focus();
      return;
    }
    // The trigger is gone (the room ended underneath us): land somewhere usable.
    if (!this.el.setup.classList.contains('hidden')) {
      (document.getElementById('name') as HTMLInputElement | null)?.focus();
    }
  }

  private leaveMatch(): void {
    this.closeLeaveConfirm();
    this.abandonSession();
  }

  /**
   * Walks away from the room for good: tells the server when it can, then drops
   * the socket, the seat and the board. Anything still in flight from that
   * session is ignored, and nothing reconnects.
   */
  private abandonSession(): void {
    this.abandoned = true;
    this.holding = false;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    this.reconnectAttempts = 0;

    const net = this.net;
    this.net = null;
    if (net) {
      // A no-op if it never opened; the room then retires on seat grace.
      net.send({ t: 'leave' });
      net.close();
    }

    this.clearRoom();
    this.clockEnd = 0;
    this.el.setup.classList.remove('hidden');
    this.el.gameover.classList.add('hidden');
    this.setStatus('Left the match.');
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

  private setStatus(s: string): void {
    this.el.status!.textContent = s;
  }

  // ------------------------------------------------------------ practice

  private beginPractice(): void {
    // Practice and an online room cannot both be live. Leaving the room behind
    // would keep a joinable lobby whose host is not looking at it.
    if (this.roomCode) {
      this.net?.send({ t: 'leave' });
      this.clearRoom();
    }
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

    // Practice never ends, so the 8 always comes back - whether or not the cue
    // was potted on the same shot. These used to be one branch with a return,
    // so a scratch hid a potted 8 permanently.
    const eight = balls.find((b) => b.id === 8)!;
    if (eight.pocketed) {
      const spot = respotPoint(balls);
      eight.pocketed = false;
      eight.p.x = spot.x;
      eight.p.y = spot.y;
      eight.v = { x: 0, y: 0 };
      eight.w = { x: 0, y: 0, z: 0 };
      eight.q = { x: 0, y: 0, z: 0, w: 1 };
      this.toast('8 spotted.');
    }

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
    }
  }

  // ---------------------------------------------------------------- online

  private ensureNet(): Net {
    if (!this.net) {
      // A fresh connection, so whatever session was abandoned is over.
      this.abandoned = false;
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
    // Leaving closed the socket on purpose; there is nothing to go back to.
    if (this.abandoned) return;
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
    // Each entry form has its own name box; read whichever one is on screen.
    const host = document.getElementById('name') as HTMLInputElement | null;
    const guest = document.getElementById('joinnm') as HTMLInputElement | null;
    const el = host && host.offsetParent !== null ? host : guest;
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
   * While you are in a room the menu shows the waiting lobby: the code is the
   * loudest thing on the screen, with the two copy buttons under it.
   */
  private showLobby(inRoom: boolean, code = ''): void {
    this.el.hosted.textContent = inRoom ? code || this.roomCode || '----' : '';
    this.showMenu(inRoom ? 'waiting' : 'home');
  }

  private leaveLobby(): void {
    this.net?.send({ t: 'leave' });
    this.clearRoom();
    this.setStatus('Left the room.');
  }

  /** Drops every trace of a room, locally. The caller decides what to say. */
  private clearRoom(): void {
    // A room that ends underneath the confirmation must not leave it floating
    // in front of the setup screen.
    if (!this.el.leave.classList.contains('hidden')) {
      this.leaveWasOpen = true;
      this.el.leave.classList.add('hidden');
      this.leaveReturn = null;
    }
    this.roomCode = null;
    this.token = null;
    this.state = null;
    this.playFrames = [];
    this.peerAim = null;
    this.holding = false;
    this.clearSeat();
    this.el.room.classList.add('hidden');
    this.showLobby(false);
  }

  /** Lands focus somewhere usable when a teardown dismissed the confirmation. */
  private landOnSetup(): void {
    if (!this.leaveWasOpen) return;
    this.leaveWasOpen = false;
    (document.getElementById('name') as HTMLInputElement | null)?.focus();
  }

  /**
   * A rejoin the server will never accept: the room is gone or the seat was
   * handed on. Give up rather than sitting on a dead board and a saved seat.
   */
  private endSession(message: string): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    this.reconnectAttempts = 0;
    this.clearRoom();
    this.el.setup.classList.remove('hidden');
    this.el.gameover.classList.add('hidden');
    this.setStatus(message);
    this.toast(message);
    this.landOnSetup();
  }

  private joinRoom(): void {
    this.rules = this.readRules();
    this.saveSettings();
    this.names[0] = this.readName();
    const input = document.getElementById('code') as HTMLInputElement;
    // Case and stray spaces are the player's business, not the server's.
    const code = input.value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6);
    input.value = code;
    if (!code) {
      this.setStatus('Enter a room code.');
      input.focus();
      return;
    }
    this.ensureNet();
    this.net!.send({ t: 'join', name: this.names[0], code });
    this.setStatus('Joining...');
  }

  private onServer(m: ServerMsg): void {
    // A late message from a session we walked away from must not reopen it.
    if (this.abandoned) return;
    switch (m.t) {
      case 'hello': {        // Remember what this connection is called; the first one doubles as the
        // seat token until a room hands us our own.
        this.helloId = m.id;
        if (!this.token) this.token = m.id;
        break;
      }
      case 'room': {
        if (this.mode === 'practice') break;
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
        // The lobby itself says what it is waiting for; only a joining opponent
        // needs saying here.
        this.setStatus(m.room.names[1] ? 'Opponent connected. Starting...' : '');
        break;
      }
      case 'start': {
        // A room message can still be in flight when the host switches to
        // Practice; it must not take the practice board over.
        if (this.mode === 'practice') break;
        this.peerAim = null;
        this.holding = m.holding ?? false;
        this.el.setup.classList.add('hidden');
        this.el.gameover.classList.add('hidden');
        this.state = m.state;
        this.aim = 0;
        this.spin.set({ x: 0, y: 0 });
        this.power = m.state.onBreak && m.state.turn === this.side ? BREAK_POWER : SHOT_POWER;
        this.placing = m.state.ballInHand && m.state.turn === this.side;
        // The server owns the clock. On a rejoin it says how much of the turn
        // is left, so the countdown resumes rather than restarting.
        if (this.holding) {
          this.clockEnd = 0;
          this.setStatus('Opponent disconnected. Waiting for them.');
        } else if (
          typeof m.remaining === 'number' &&
          this.state.turn === this.side &&
          !this.state.over
        ) {
          this.clockEnd = performance.now() + m.remaining;
        } else {
          this.resetClock();
        }
        // A rejoin into a finished match must look finished, with Rematch
        // still on offer.
        this.showResult(this.state);
        this.toast(m.state.turn === this.side ? 'Your break.' : 'Opponent breaks.');
        break;
      }
      case 'aim': {
        this.peerAim = { aim: m.aim, power: m.power };
        break;
      }
      case 'clock': {
        // A timing-only update: the connected player keeps their board and
        // their aim, and only the hold state and countdown change.
        this.holding = m.holding;
        if (m.holding) {
          // Whoever left was mid-aim at best; their cue should not stay on the
          // table pointing at a turn nobody is taking.
          this.peerAim = null;
          this.clockEnd = 0;
          this.setStatus('Opponent disconnected. Waiting for them.');
          break;
        }
        // Only the player on strike has a clock to show. Without the turn check
        // a reload of the shooter put a countdown on the waiting tab.
        const mine = !!this.state && this.state.turn === this.side && !this.state.over;
        this.clockEnd = mine && m.remaining > 0 ? performance.now() + m.remaining : 0;
        this.setStatus('Opponent reconnected.');
        break;
      }
      case 'shot': {
        this.peerAim = null;
        this.holding = false;
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
        // A rejected rejoin is terminal, whether or not a board is on screen:
        // the room is gone, or the seat was handed on.
        if (m.code === 'rejoin-failed') {
          this.endSession(m.message);
          break;
        }
        this.setStatus(m.message);
        this.toast(m.message);
        break;
      }
      case 'bye': {
        // The room is gone on the server; put the setup screen back.
        this.clearRoom();
        this.el.setup.classList.remove('hidden');
        this.el.gameover.classList.add('hidden');
        this.setStatus('The other player left.');
        this.toast('The other player left.');
        this.landOnSetup();
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
    // A turn that changes without a shot - a timeout, or a referee call - means
    // the aim we were last sent belongs to a turn that has ended.
    if (this.state !== null && this.state.turn !== s.turn) this.peerAim = null;
    this.state = s;
    // Say what the referee decided: a foul reason, or the visits left.
    if (s.message !== this.lastMessage) {
      this.lastMessage = s.message;
      if (s.message) this.toast(s.message);
    }
    this.placing = s.ballInHand && s.turn === this.side;
    this.resetClock();
    this.showResult(s);
  }

  /** The result dialog, shown for a live finish and for a rejoin into one. */
  private showResult(s: GameState): void {
    if (!s.over) {
      this.el.gameover.classList.add('hidden');
      return;
    }
    this.el.gtitle!.textContent = s.over.winner === this.side ? 'You win' : 'You lose';
    this.el.gsub!.textContent = s.over.reason;
    this.el.gameover.classList.remove('hidden');
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
      const leaveOpen = !this.el.leave.classList.contains('hidden');
      // Escape unwinds one layer at a time: the leave confirmation, then
      // settings, then it opens the confirmation in an online match. Outside a
      // room it keeps its existing meaning.
      if (e.key === 'Escape') {
        if (leaveOpen) {
          e.preventDefault();
          this.closeLeaveConfirm();
          return;
        }
        const settings = document.getElementById('settings');
        if (settings && !settings.classList.contains('hidden')) {
          e.preventDefault();
          this.closeSettings();
          return;
        }
        if (this.roomCode) {
          e.preventDefault();
          this.openLeaveConfirm();
          return;
        }
      }
      // While the confirmation is up the game keys are inert: Space and Enter
      // must press the focused dialog button, not shoot or change power.
      if (leaveOpen) {
        if (e.key === 'Tab') {
          e.preventDefault();
          const buttons = [this.el.stay, this.el.leavematch];
          const at = buttons.indexOf(document.activeElement as HTMLElement);
          const step = e.shiftKey ? buttons.length - 1 : 1;
          buttons[(at + step + buttons.length) % buttons.length].focus();
          return;
        }
        if (e.key === ' ' || e.key === 'Enter') return;
        e.preventDefault();
        return;
      }
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
    // The head string is the room's rule, not the break's. Practice has no head
    // string at all, because there is no referee and no room.
    const behindOnly = this.mode === 'online' && behindLineOnly(this.rules);
    if (!isValidPlacement(this.state.balls, w.x, w.y, behindOnly)) {
      this.toast('No room there.');
      return;
    }
    if (this.mode === 'online') {
      // Wait for the server's state before moving the ball or leaving placement
      // mode: the server owns the table, and a rejected spot must not appear.
      this.net?.send({ t: 'place', x: w.x, y: w.y });
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
  }

  private cueBall(): Ball | null {
    return this.state?.balls.find((b) => b.id === 0) ?? null;
  }

  private canShoot(): boolean {
    if (!this.state || this.state.over) return false;
    if (this.playFrames.length > 0 || this.placing) return false;
    // The turn is frozen while the other seat is away.
    if (this.holding) return false;
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

  /**
   * Tell the opponent where the cue is pointing, so they can watch you line up.
   * Throttled and change-only: this is a courtesy, not game state, and it must
   * never be the reason a shot feels laggy.
   */
  private sendAim(now: number): void {
    if (this.mode !== 'online' || !this.net || !this.state) return;
    if (this.holding) return;
    if (this.state.turn !== this.side || this.state.over) return;
    if (this.playFrames.length > 0 || this.placing) return;
    if (now - this.lastAimSent < 90) return;
    if (
      Math.abs(this.aim - this.lastAim.aim) < 0.004 &&
      Math.abs(this.power - this.lastAim.power) < 0.01
    ) {
      return;
    }
    this.lastAimSent = now;
    this.lastAim = { aim: this.aim, power: this.power };
    this.net.send({ t: 'aim', aim: this.aim, power: this.power });
  }

  private loop(now: number): void {
    this.sendAim(now);
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
    // The Leave control belongs to a live online session and nothing else. It
    // stays put through replays, either turn, and a reconnect attempt.
    const showLeave = !!this.roomCode;
    if (showLeave !== this.leaveShown) {
      this.leaveShown = showLeave;
      this.el.leavebtn.classList.toggle('hidden', !showLeave);
    }
    // Match chrome stays out of the menu's way.
    const menuOpen = !this.el.setup.classList.contains('hidden');
    if (menuOpen !== this.menuShown) {
      this.menuShown = menuOpen;
      document.body.classList.toggle('menu', menuOpen);
    }
    const balls = this.displayBalls();
    const view: ViewState = {
      balls,
      cueBallId: 0,
      aim: this.aim,
      power: this.power,
      spin: this.spin.value,
      showAim: this.canShoot() || this.placing,
      peerAim: this.mode === 'online' ? this.peerAim : null,
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
