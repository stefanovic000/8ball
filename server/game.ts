import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { newRack, shoot } from '../src/core/physics';
import { applyOutcome, judgeShot, newGame, type GameState, type Rules, type Side } from '../src/core/rules';
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
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
    const r = (raw ?? {}) as Partial<Rules>;
    const clock = Number(r.shotClock);
    return {
      ruleset: r.ruleset === 'american' ? 'american' : 'european',
      shotClock: [0, 20, 30, 45].includes(clock) ? clock : 30,
      calledPockets: Boolean(r.calledPockets),
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
    if (!room.state || room.state.over || room.rules.shotClock <= 0) {
      room.deadline = 0;
      return;
    }
    room.deadline = Date.now() + room.rules.shotClock * 1000;
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

    const s = shot as { aim?: number; power?: number; spin?: { x?: number; y?: number } };
    const aim = Number(s?.aim);
    const power = Number(s?.power);
    const sx = Number(s?.spin?.x ?? 0);
    const sy = Number(s?.spin?.y ?? 0);

    if (!Number.isFinite(aim) || !Number.isFinite(power) || power < 0 || power > 1) {
      send(client, { t: 'error', message: 'Bad shot.' });
      return;
    }
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
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    if (Math.abs(px) > 1.24 || Math.abs(py) > 0.605) return;
    for (const b of st.balls) {
      if (b.id === 0 || b.pocketed) continue;
      if (Math.hypot(b.p.x - px, b.p.y - py) < 0.058) return;
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
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'create': {
        if (client.room) return;
        const room: Room = {
          code: makeCode(),
          rules: sanitiseRules(msg.rules),
          state: null,
          slots: [client, null],
          deadline: 0,
        };
        client.name = sanitiseName(msg.name, 'Player 1');
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
        const room = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!room) {
          send(client, { t: 'error', message: 'No room with that code.' });
          return;
        }
        if (room.slots[1]) {
          send(client, { t: 'error', message: 'That room is full.' });
          return;
        }
        client.name = sanitiseName(msg.name, 'Player 2');
        client.side = 1;
        client.room = room;
        room.slots[1] = client;
        send(room.slots[0]!, { t: 'room', room: roomInfo(room, 0) });
        send(client, { t: 'room', room: roomInfo(room, 1) });
        send(room.slots[0]!, { t: 'peer', joined: true, name: client.name });
        beginGame(room);
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
        foul(room, 'shot clock expired');
        break;
      }
      case 'rematch': {
        const room = client.room;
        if (!room || !room.slots[0] || !room.slots[1]) return;
        beginGame(room);
        break;
      }
      case 'leave':
        dropClient(client);
        break;
      case 'rejoin': {
        // A reloaded tab comes back with the id it was given on connect.
        const room = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!room) {
          send(client, { t: 'error', message: 'That room is gone.' });
          break;
        }
        const idx = room.slots.findIndex((c) => c !== null && c.id === msg.token);
        if (idx < 0) {
          send(client, { t: 'error', message: 'That seat is no longer held.' });
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
        armClock(room);
        send(client, { t: 'room', room: roomInfo(room, client.side) });
        if (room.state) send(client, { t: 'start', state: room.state });
        const peer = room.slots[1 - idx];
        if (peer && !peer.gone) {
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
      // Do not run their shot clock down while they are reconnecting.
      room.deadline = 0;
      const peer = room.slots.find((c) => c !== null && c !== client) ?? null;
      if (peer && !peer.gone) {
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
    const now = Date.now();
    for (const room of rooms.values()) {
      if (!room.state || room.state.over) continue;
      if (room.deadline > 0 && now > room.deadline) foul(room, 'shot clock expired');
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
