import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { newRack, shoot } from '../src/core/physics';
import {
  applyOutcome,
  behindLineOnly,
  isValidPlacement,
  judgeShot,
  newGame,
  type GameState,
  type Rules,
  type Side,
} from '../src/core/rules';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

export type GameServer = {
  port: number;
  close: () => Promise<void>;
};

type Client = {
  id: string;
  ws: WebSocket;
  name: string;
  room: Room | null;
  side: Side;
  /** Set while the socket is gone but the seat is still being held. */
  gone?: boolean;
  dropTimer?: ReturnType<typeof setTimeout>;
};

/** How long a seat survives its socket, so a reload can rejoin. */
const GRACE_MS = 60_000;

type Room = {
  code: string;
  rules: Rules;
  state: GameState | null;
  slots: [Client | null, Client | null];
  /** Epoch ms at which the current shot clock runs out, 0 when idle. */
  deadline: number;
  /**
   * Milliseconds that were left when the player on strike lost their socket.
   * Rejoin resumes from this instead of granting a fresh period.
   */
  paused: number;
  /** True while a seat is away: the turn is frozen until both are back. */
  holding: boolean;
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Whether the player on strike has run out of time. A deadline of 0 means the
 * clock is off, which is not the same as "expired long ago".
 *
 * The sweep and a client's timeout message both decide with this, so the two
 * cannot disagree about whether a turn is late.
 */
export function turnExpired(deadline: number, now: number): boolean {
  return deadline > 0 && now > deadline;
}

/**
 * What the deadline should be when a held seat comes back.
 *
 * Three cases that look alike but are not: a clock that was switched off stays
 * off; a turn that was paused resumes with exactly what it had left; and a turn
 * that had already run out before the seat was held returns `null`, meaning it
 * should expire rather than be handed a fresh period.
 */
export function resumeDeadline(clockOn: boolean, paused: number, now: number): number | null {
  if (!clockOn) return 0;
  if (paused > 0) return now + paused;
  return null;
}

/**
 * Inbound fields are checked for the primitive type they are used as. Nested
 * objects and arrays survive `JSON.parse` and coerce to nonsense - `Number({})`
 * is NaN, `String({})` is "[object Object]" - so a value is only read once it
 * is known to be the shape the handler expects.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export async function createGameServer(
  port = 8787,
  host?: string,
  /** Injectable so a test can move the clock without waiting. */
  now: () => number = Date.now,
): Promise<GameServer> {
  const rooms = new Map<string, Room>();
  const dist = join(process.cwd(), 'dist');

  function makeCode(): string {
    let s = '';
    do {
      s = '';
      for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    } while (rooms.has(s));
    return s;
  }

  function send(c: Client | null, msg: ServerMsg): void {
    if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  function broadcast(room: Room, msg: ServerMsg): void {
    for (const c of room.slots) send(c, msg);
  }

  function sanitiseName(raw: unknown, fallback: string): string {
    const s = String(raw ?? '')
      .trim()
      .slice(0, 16)
      .replace(/[<>&"']/g, '');
    return s.length > 0 ? s : fallback;
  }

  function sanitiseRules(raw: unknown): Rules {
    const r = isPlainObject(raw) ? raw : {};
    const clock = isNum(r.shotClock) ? r.shotClock : 30;
    return {
      ruleset: r.ruleset === 'american' ? 'american' : 'european',
      shotClock: [0, 20, 30, 45].includes(clock) ? clock : 30,
      calledPockets: typeof r.calledPockets === 'boolean' ? r.calledPockets : false,
      ballInHand: r.ballInHand === 'behind' ? 'behind' : 'anywhere',
    };
  }

  function roomInfo(room: Room, you: Side) {
    return {
      code: room.code,
      you,
      names: [room.slots[0]?.name ?? '', room.slots[1]?.name ?? null] as [string, string | null],
      rules: room.rules,
      started: room.state !== null,
    };
  }

  function armClock(room: Room): void {
    room.paused = 0;
    if (!room.state || room.state.over || room.rules.shotClock <= 0) {
      room.deadline = 0;
      return;
    }
    room.deadline = now() + room.rules.shotClock * 1000;
  }

  function pushState(room: Room): void {
    if (room.state) broadcast(room, { t: 'state', state: room.state });
  }

  function beginGame(room: Room): void {
    room.state = newGame(newRack());
    room.state.turn = 0;
    armClock(room);
    broadcast(room, { t: 'start', state: room.state });
  }

  function foul(room: Room, reason: string): void {
    const st = room.state;
    if (!st) return;
    // A finished match has nothing left to adjudicate.
    if (st.over) return;
    st.turn = (1 - st.turn) as Side;
    st.ballInHand = true;
    st.message = reason;
    st.seq++;
    armClock(room);
    pushState(room);
  }

  function handleShot(room: Room, client: Client, shot: unknown): void {
    const st = room.state;
    if (!st || st.over) return;
    if (st.turn !== client.side) {
      send(client, { t: 'error', message: 'Not your turn.' });
      return;
    }
    // Ball in hand is pending: the cue ball is not where it will be struck from.
    if (st.ballInHand) {
      send(client, { t: 'error', message: 'Place the cue ball first.' });
      return;
    }
    // The turn is frozen while the other seat is away.
    if (room.holding) {
      send(client, { t: 'error', message: 'Waiting for the other player.' });
      return;
    }
    // A shot can land between the deadline and the next sweep tick. Expire the
    // turn here and drop the shot, so being late costs the turn rather than
    // sneaking one in.
    if (turnExpired(room.deadline, now())) {
      foul(room, 'shot clock expired');
      return;
    }

    const s = shot as { aim?: unknown; power?: unknown; spin?: unknown } | null;
    if (!isPlainObject(s)) {
      send(client, { t: 'error', message: 'Bad shot.' });
      return;
    }
    if (!isNum(s.aim) || !isNum(s.power) || s.power < 0 || s.power > 1) {
      send(client, { t: 'error', message: 'Bad shot.' });
      return;
    }
    let sx = 0;
    let sy = 0;
    if (s.spin !== undefined) {
      if (!isPlainObject(s.spin)) {
        send(client, { t: 'error', message: 'Bad shot.' });
        return;
      }
      if (s.spin.x !== undefined) {
        if (!isNum(s.spin.x)) {
          send(client, { t: 'error', message: 'Bad shot.' });
          return;
        }
        sx = s.spin.x;
      }
      if (s.spin.y !== undefined) {
        if (!isNum(s.spin.y)) {
          send(client, { t: 'error', message: 'Bad shot.' });
          return;
        }
        sy = s.spin.y;
      }
    }
    const aim = s.aim;
    const power = s.power;
    if (Math.hypot(sx, sy) > 0.5001) {
      send(client, { t: 'error', message: 'That much spin would miscue.' });
      return;
    }

    const cue = st.balls.find((b) => b.id === 0);
    if (!cue || cue.pocketed) {
      send(client, { t: 'error', message: 'Cue ball is off the table.' });
      return;
    }

    const clean = { aim, power, spin: { x: sx, y: sy } };
    const res = shoot(st.balls, clean, 0, st.onBreak);
    const out = judgeShot(st, res.events, room.rules);

    if (out.rerack) {
      st.balls = newRack();
      st.message = '8 on the break - re-rack';
      st.seq++;
      armClock(room);
      broadcast(room, { t: 'shot', by: client.side, shot: clean, state: st });
      return;
    }

    applyOutcome(st, out, res.balls);
    st.seq++;
    armClock(room);
    broadcast(room, { t: 'shot', by: client.side, shot: clean, state: st });
  }

  function handlePlace(room: Room, client: Client, x: unknown, y: unknown): void {
    const st = room.state;
    if (!st || st.over) return;
    if (st.turn !== client.side || !st.ballInHand) return;
    if (!isNum(x) || !isNum(y)) return;
    if (room.holding) {
      send(client, { t: 'error', message: 'Waiting for the other player.' });
      return;
    }
    const px = x;
    const py = y;
    // A placement that lands after the deadline is a late turn, same as a shot.
    if (turnExpired(room.deadline, now())) {
      foul(room, 'shot clock expired');
      return;
    }
    // Same geometry and head-string policy as the client, from one place.
    if (!isValidPlacement(st.balls, px, py, behindLineOnly(room.rules))) {
      send(client, { t: 'error', message: 'That spot is not allowed.' });
      return;
    }
    const cue = st.balls.find((b) => b.id === 0);
    if (!cue) return;
    cue.p = { x: px, y: py };
    cue.v = { x: 0, y: 0 };
    cue.w = { x: 0, y: 0, z: 0 };
    cue.pocketed = false;
    st.ballInHand = false;
    st.seq++;
    armClock(room);
    pushState(room);
  }

  function dropClient(client: Client): void {
    if (client.dropTimer) {
      clearTimeout(client.dropTimer);
      client.dropTimer = undefined;
    }
    const room = client.room;
    client.room = null;
    client.gone = true;
    if (!room) return;
    const other = room.slots.find((c) => c !== null && c !== client) ?? null;
    if (room.slots[0] === client) room.slots[0] = null;
    if (room.slots[1] === client) room.slots[1] = null;
    if (other) {
      send(other, { t: 'error', message: 'Opponent left.' });
      send(other, { t: 'bye' });
      other.room = null;
    }
    rooms.delete(room.code);
  }

  function onMessage(client: Client, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // The dispatcher below assumes an object with a message type. A bare
    // string, number, null or array parses fine and would throw or fall
    // through here, so the envelope is checked before anything is read.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const envelope = parsed as { t?: unknown };
    if (typeof envelope.t !== 'string') return;
    const msg = parsed as ClientMsg;

    switch (msg.t) {
      case 'create': {
        if (client.room) return;
        const room: Room = {
          code: makeCode(),
          rules: sanitiseRules(msg.rules),
          state: null,
          slots: [client, null],
          deadline: 0,
          paused: 0,
          holding: false,
        };
        client.name = sanitiseName(isStr(msg.name) ? msg.name : undefined, 'Player 1');
        client.side = 0;
        client.room = room;
        rooms.set(room.code, room);
        send(client, { t: 'room', room: roomInfo(room, 0) });
        break;
      }
      case 'join': {
        if (client.room) {
          send(client, { t: 'error', message: 'You are already in a room.' });
          return;
        }
        const room = rooms.get(isStr(msg.code) ? msg.code.toUpperCase() : '');
        if (!room) {
          send(client, { t: 'error', message: 'No room with that code.' });
          return;
        }
        if (room.slots[1]) {
          send(client, { t: 'error', message: 'That room is full.' });
          return;
        }
        client.name = sanitiseName(isStr(msg.name) ? msg.name : undefined, 'Player 2');
        client.side = 1;
        client.room = room;
        room.slots[1] = client;
        send(room.slots[0]!, { t: 'room', room: roomInfo(room, 0) });
        send(client, { t: 'room', room: roomInfo(room, 1) });
        send(room.slots[0]!, { t: 'peer', joined: true, name: client.name });
        beginGame(room);
        break;
      }
      case 'aim': {
        // Best effort, and only the player on strike: it is a hint of where the
        // cue is pointing, not game state, so a dropped update costs nothing.
        const room = client.room;
        if (!room || !room.state || room.state.over) return;
        if (room.state.turn !== client.side) return;
        const aim = msg.aim;
        const power = msg.power;
        if (!isNum(aim) || !isNum(power) || power < 0 || power > 1) return;
        const peer = room.slots.find((c) => c !== null && c !== client) ?? null;
        if (peer && !peer.gone) send(peer, { t: 'aim', side: client.side, aim, power });
        break;
      }
      case 'shot':
        if (client.room) handleShot(client.room, client, msg.shot);
        break;
      case 'place':
        if (client.room) handlePlace(client.room, client, msg.x, msg.y);
        break;
      case 'timeout': {
        const room = client.room;
        if (!room || !room.state || room.state.over) return;
        if (room.state.turn !== client.side) return;
        // Only honour it when the server's own clock says the turn is late.
        // Anything else - the clock is off, or the client is early - is a
        // request to skip someone else's turn and is ignored.
        if (!turnExpired(room.deadline, now())) return;
        // foul() re-arms the clock for the new player, so a repeat cannot
        // expire the same turn twice, and the turn check above stops it
        // applying to a turn that has already moved on.
        foul(room, 'shot clock expired');
        break;
      }
      case 'rematch': {
        const room = client.room;
        if (!room || !room.slots[0] || !room.slots[1]) return;
        if (room.slots[0].gone || room.slots[1].gone) return;
        // Only after the match has actually ended, and only with both players
        // still connected. Otherwise "rematch" is a way to wipe a live game.
        if (!room.state || !room.state.over) return;
        beginGame(room);
        break;
      }
      case 'leave':
        dropClient(client);
        break;
      case 'rejoin': {
        // A reloaded tab comes back with the id it was given on connect.
        const room = rooms.get(isStr(msg.code) ? msg.code.toUpperCase() : '');
        if (!room) {
          send(client, { t: 'error', message: 'That room is gone.', code: 'rejoin-failed' });
          break;
        }
        const token = isStr(msg.token) ? msg.token : '';
        const idx = room.slots.findIndex((c) => c !== null && c.id === token);
        if (idx < 0) {
          send(client, {
            t: 'error',
            message: 'That seat is no longer held.',
            code: 'rejoin-failed',
          });
          break;
        }
        const old = room.slots[idx]!;
        if (old.dropTimer) clearTimeout(old.dropTimer);
        client.name = old.name;
        client.side = old.side;
        client.room = room;
        old.room = null;
        old.dropTimer = undefined;
        room.slots[idx] = client;
        const peer = room.slots[1 - idx];
        const bothHere = !!peer && !peer.gone;
        // Resume only a room that was actually held, and only once every seat
        // is back. A disabled clock stays off, a paused turn resumes with what
        // was left, and a turn that had already run out expires once.
        if (bothHere && room.holding) {
          room.holding = false;
          // A completed match keeps its result: there is no clock to resume and
          // no turn to expire, so rejoining must not overwrite either.
          if (room.state?.over) {
            room.deadline = 0;
            room.paused = 0;
          } else {
            const left = room.paused;
            room.paused = 0;
            const next = resumeDeadline(room.rules.shotClock > 0, left, now());
            if (next === null) foul(room, 'shot clock expired');
            else room.deadline = next;
          }
        }
        const remaining = room.deadline > 0 ? Math.max(0, room.deadline - now()) : 0;

        send(client, { t: 'room', room: roomInfo(room, client.side) });
        if (room.state) {
          send(client, {
            t: 'start',
            state: room.state,
            remaining,
            holding: room.holding,
          });
        }
        if (bothHere && peer) {
          // The connected player already has the board; they only need the
          // timing, not a fresh start that would reset their aim.
          send(peer, { t: 'clock', remaining, holding: false });
          send(peer, { t: 'peer', joined: true, name: client.name });
          send(peer, { t: 'error', message: 'Opponent reconnected.' });
        }
        break;
      }
      default:
        break;
    }
  }

  // --------------------------------------------------------------- static

  async function serveFile(res: ServerResponse, path: string): Promise<void> {
    const info = await stat(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    });
    createReadStream(path).pipe(res);
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!existsSync(dist)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('8ball server. Run "npm run dev" for the client, or "npm run build" first.\n');
      return;
    }
    const url = (req.url ?? '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : normalize(url).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, rel);
    if (!existsSync(file)) file = join(dist, 'index.html');
    try {
      await serveFile(res, file);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }

  // ----------------------------------------------------------------- boot

  const server = createServer((req, res) => {
    void handleHttp(req, res);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const client: Client = { id: randomUUID(), ws, name: 'Player', room: null, side: 0 };
    send(client, { t: 'hello', id: client.id });
    ws.on('message', (data) => onMessage(client, String(data)));
    ws.on('close', () => {
      // Hold the seat briefly instead of ending the room: a reload or a flaky
      // connection can come back with the same token.
      const room = client.room;
      if (!room) return;
      client.gone = true;
      // Freeze the turn on the first seat that leaves and remember what was
      // left, so rejoining resumes it instead of buying a fresh period. A
      // second disconnect must not overwrite that: the deadline is already 0
      // by then, and the pause has to survive until both seats are back.
      if (!room.holding) {
        room.holding = true;
        room.paused = room.deadline > 0 ? Math.max(0, room.deadline - now()) : 0;
      }
      room.deadline = 0;
      const peer = room.slots.find((c) => c !== null && c !== client) ?? null;
      if (peer && !peer.gone) {
        send(peer, { t: 'clock', remaining: room.paused, holding: true });
        send(peer, { t: 'error', message: 'Opponent disconnected. Holding their seat.' });
      }
      client.dropTimer = setTimeout(() => dropClient(client), GRACE_MS);
    });
    ws.on('error', () => {
      /* client vanished mid-write */
    });
  });

  // One clock for the whole server, not one per room.
  const timer = setInterval(() => {
    const at = now();
    for (const room of rooms.values()) {
      if (!room.state || room.state.over) continue;
      if (turnExpired(room.deadline, at)) foul(room, 'shot clock expired');
    }
  }, 1000);

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        for (const c of wss.clients) c.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}
