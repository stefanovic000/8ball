import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, resumeDeadline, turnExpired, type GameServer } from '../server/game';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { shoot } from '../src/core/physics';

/** Small test client that can wait for a particular message type. */
class TestClient {
  private ws: WebSocket;
  private queue: ServerMsg[] = [];
  private waiters: Array<{ match: (m: ServerMsg) => boolean; done: (m: ServerMsg) => void }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMsg;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].done(msg);
      else this.queue.push(msg);
    });
  }

  static open(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
    });
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** For envelopes that are not valid messages at all. */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** A queued message of this type, or null. Does not wait. */
  take<T extends ServerMsg['t']>(type: T): Extract<ServerMsg, { t: T }> | null {
    const i = this.queue.findIndex((m) => m.t === type);
    if (i < 0) return null;
    return this.queue.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
  }

  /** Drops anything queued, so a later assertion starts clean. */
  clear(): void {
    this.queue.length = 0;
  }

  next<T extends ServerMsg['t']>(type: T, timeout = 3000): Promise<Extract<ServerMsg, { t: T }>> {
    const match = (m: ServerMsg) => m.t === type;
    const existing = this.queue.findIndex(match);
    if (existing >= 0) {
      return Promise.resolve(this.queue.splice(existing, 1)[0] as Extract<ServerMsg, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), timeout);
      this.waiters.push({
        match,
        done: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMsg, { t: T }>);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe('rooms', () => {
  let server: GameServer;
  let port = 0;

  beforeAll(async () => {
    server = await createGameServer(0);
    port = server.port;
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects an unknown room code', async () => {
    const a = await TestClient.open(port);
    a.send({ t: 'join', name: 'A', code: 'ZZZZ' });
    const err = await a.next('error');
    expect(err.message).toMatch(/No room/);
    a.close();
  });

  it('starts a game when the second player joins', async () => {
    const a = await TestClient.open(port);
    a.send({
      t: 'create',
      name: 'Ana',
      rules: { ruleset: 'american', shotClock: 0, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    expect(room.room.code).toHaveLength(4);
    expect(room.room.you).toBe(0);

    const b = await TestClient.open(port);
    b.send({ t: 'join', name: 'Ben', code: room.room.code });

    const [startA, startB] = await Promise.all([a.next('start'), b.next('start')]);
    expect(startA.state.balls).toHaveLength(16);
    expect(startB.state.balls).toHaveLength(16);
    expect(startA.state.turn).toBe(0);

    const opening = { aim: 0, power: 1, spin: { x: 0, y: 0 } };
    a.send({ t: 'shot', shot: opening });
    const [shot, otherShot] = await Promise.all([a.next('shot'), b.next('shot')]);
    expect(shot.by).toBe(0);
    // Potting on the break keeps the table, so the turn only passes on a dry
    // break. Which one happens depends on the friction, so follow the outcome
    // rather than assuming it.
    const potted = shot.state.balls.filter((b) => b.pocketed).length;
    expect(shot.state.turn).toBe(potted > 0 ? 0 : 1);
    expect(shot.state.onBreak).toBe(false);
    expect(otherShot.state).toEqual(shot.state);
    expect(shot.state.balls).toEqual(shoot(startA.state.balls, opening, 0, true).balls);

    // Whoever is not on strike cannot shoot.
    const waiting = shot.state.turn === 0 ? b : a;
    waiting.send({ t: 'shot', shot: { aim: 0, power: 0.9, spin: { x: 0, y: 0 } } });
    const err = await waiting.next('error');
    expect(err.message).toMatch(/Not your turn/);

    a.close();
    b.close();
  });

  it('rejects an impossible spin offset', async () => {
    const a = await TestClient.open(port);
    a.send({ t: 'create', name: 'A', rules: { ruleset: 'american', shotClock: 0, calledPockets: false, ballInHand: 'anywhere' } });
    const room = await a.next('room');
    const b = await TestClient.open(port);
    b.send({ t: 'join', name: 'B', code: room.room.code });
    await a.next('start');

    a.send({ t: 'shot', shot: { aim: 0, power: 0.5, spin: { x: 0.9, y: 0.9 } } });
    const err = await a.next('error');
    expect(err.message).toMatch(/miscue/);

    a.close();
    b.close();
  });

  it('holds a seat and gives it back on rejoin', async () => {
    const rules = { ruleset: 'american' as const, shotClock: 0, calledPockets: false, ballInHand: 'anywhere' as const };
    const a = await TestClient.open(port);
    await a.next('hello');
    a.send({ t: 'create', name: 'Ana', rules });
    const room = await a.next('room');

    const b = await TestClient.open(port);
    const helloB = await b.next('hello');
    b.send({ t: 'join', name: 'Ben', code: room.room.code });
    await Promise.all([a.next('start'), b.next('start')]);

    // Ben vanishes. Ana is told the seat is being held, not that he left.
    b.close();
    const notice = await a.next('error');
    expect(notice.message).toMatch(/disconnected/i);
    expect(notice.message).toMatch(/holding/i);

    // He comes back on a new socket, quoting the id he was given on connect.
    const back = await TestClient.open(port);
    back.send({ t: 'rejoin', code: room.room.code, token: helloB.id });
    const again = await back.next('room');
    expect(again.room.code).toBe(room.room.code);
    expect(again.room.you).toBe(1);

    const state = await back.next('start');
    expect(state.state.balls).toHaveLength(16);

    a.close();
    back.close();
  });

  it('refuses a rejoin with a token that is not holding a seat', async () => {
    const a = await TestClient.open(port);
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 0, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');

    const b = await TestClient.open(port);
    b.send({ t: 'rejoin', code: room.room.code, token: 'not-a-real-token' });
    const err = await b.next('error');
    expect(err.message).toMatch(/no longer held/);
    // The client needs to recognise this as terminal rather than a generic error.
    expect(err.code).toBe('rejoin-failed');

    // A room that no longer exists is rejected the same way.
    b.send({ t: 'rejoin', code: 'ZZZZ', token: 'whatever' });
    const gone = await b.next('error');
    expect(gone.code).toBe('rejoin-failed');

    a.close();
    b.close();
  });

  /** Waits long enough for the server to answer, if it were going to. */
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Two connected players with a game under way. */
  async function startedRoom(shotClock = 0) {
    const a = await TestClient.open(port);
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    const b = await TestClient.open(port);
    b.send({ t: 'join', name: 'B', code: room.room.code });
    const [startA, startB] = await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();
    return { a, b, room, start: startA.state, startB: startB.state };
  }

  /** The same, with a chosen ball-in-hand rule. */
  async function createStarted(p: number, ballInHand: 'anywhere' | 'behind') {
    const a = await TestClient.open(p);
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 0, calledPockets: false, ballInHand },
    });
    const room = await a.next('room');
    const b = await TestClient.open(p);
    b.send({ t: 'join', name: 'B', code: room.room.code });
    const [startA] = await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();
    return { a, b, room, start: startA.state };
  }

  it('ignores envelopes that are not messages', async () => {
    const { a } = await startedRoom(0);

    for (const junk of ['not json', 'null', '[]', '"hello"', '42', '{"foo":1}', '{"t":123}']) {
      a.sendRaw(junk);
    }
    await settle();

    // Nothing was acted on: no state went out, and the turn never moved.
    expect(a.take('shot')).toBeNull();
    expect(a.take('state')).toBeNull();

    // A real message still works afterwards.
    const shot = { aim: 0.4, power: 0.5, spin: { x: 0, y: 0 } };
    a.send({ t: 'shot', shot });
    const res = await a.next('shot');
    expect(res.by).toBe(0);
  });

  it('rejects a non-numeric spin before it reaches the solver', async () => {
    const { a, start } = await startedRoom(0);

    // NaN > limit is false, so this used to pass the miscue check.
    a.sendRaw(JSON.stringify({ t: 'shot', shot: { aim: 0, power: 0.5, spin: { x: 'x', y: 0 } } }));
    const err = await a.next('error');
    expect(err.message).toMatch(/Bad shot/);
    await settle();
    expect(a.take('shot')).toBeNull();

    // The board is untouched: a legal shot still comes out exactly as predicted.
    const shot = { aim: 0.4, power: 0.5, spin: { x: 0, y: 0 } };
    a.send({ t: 'shot', shot });
    const res = await a.next('shot');
    expect(res.state.balls).toEqual(shoot(start.balls, shot, 0, true).balls);
  });

  it('ignores a timeout that is early, or when the clock is off', async () => {
    const off = await startedRoom(0);
    off.a.send({ t: 'timeout' });
    await settle();
    expect(off.a.take('state')).toBeNull();
    expect(off.b.take('state')).toBeNull();

    const on = await startedRoom(30);
    on.a.send({ t: 'timeout' });
    await settle();
    expect(on.a.take('state')).toBeNull();

    // Still A's turn: the early request changed nothing.
    on.a.send({ t: 'shot', shot: { aim: 0.4, power: 0.5, spin: { x: 0, y: 0 } } });
    const res = await on.a.next('shot');
    expect(res.by).toBe(0);
  });

  it('only counts a live deadline that has passed', () => {
    const now = 1_000_000;
    expect(turnExpired(0, now)).toBe(false);
    expect(turnExpired(now + 1, now)).toBe(false);
    expect(turnExpired(now, now)).toBe(false);
    expect(turnExpired(now - 1, now)).toBe(true);
  });

  it('refuses a rematch while the match is still running', async () => {
    const { a, b } = await startedRoom(0);

    a.send({ t: 'rematch' });
    await settle();

    expect(a.take('start')).toBeNull();
    expect(b.take('start')).toBeNull();

    a.send({ t: 'shot', shot: { aim: 0.4, power: 0.5, spin: { x: 0, y: 0 } } });
    const res = await a.next('shot');
    expect(res.state.balls).toHaveLength(16);
  });

  it('starts a fresh rack on rematch once the match is over', async () => {
    const { a, b, start } = await startedRoom(0);

    const breakShot = { aim: 0, power: 1, spin: { x: 0, y: 0 } };
    a.send({ t: 'shot', shot: breakShot });
    const afterBreak = (await a.next('shot')).state;
    await b.next('shot');

    // Potting the 8 before clearing your group ends the match. The break and
    // the rack are deterministic, so this shot is known to do it - assert that
    // rather than relying on it silently.
    const followUp = { aim: 0, power: 1, spin: { x: 0, y: 0 } };
    const predicted = shoot(afterBreak.balls, followUp, 0, false);
    expect(predicted.events.some((e) => e.type === 'pocket' && e.id === 8)).toBe(true);
    expect(afterBreak.over).toBeNull();

    (afterBreak.turn === 0 ? a : b).send({ t: 'shot', shot: followUp });
    const ended = await a.next('shot');
    await b.next('shot');
    expect(ended.state.over).not.toBeNull();

    // Now a rematch is allowed, and it is a fresh rack.
    a.send({ t: 'rematch' });
    const fresh = await a.next('start');
    expect(fresh.state.balls).toHaveLength(16);
    expect(fresh.state.balls.every((ball) => !ball.pocketed)).toBe(true);
    expect(fresh.state.turn).toBe(0);
    expect(start.balls).toHaveLength(16);
  });

  it('rejects nested values where a number is expected', async () => {
    const { a } = await startedRoom(0);

    const nested = [
      { t: 'shot', shot: { aim: {}, power: 0.5 } },
      { t: 'shot', shot: { aim: 0, power: 0.5, spin: [] } },
      { t: 'shot', shot: { aim: 0, power: 0.5, spin: { x: {}, y: 0 } } },
      { t: 'shot', shot: 'nope' },
      { t: 'shot', shot: { aim: 0, power: [1], spin: { x: 0, y: 0 } } },
    ];
    for (const m of nested) a.sendRaw(JSON.stringify(m));
    await settle();

    // Every one of them is refused, and none of them moved the board.
    expect(a.take('shot')).toBeNull();
    expect(a.take('state')).toBeNull();
    for (let i = 0; i < nested.length; i++) expect(a.take('error')).not.toBeNull();

    a.send({ t: 'shot', shot: { aim: 0.4, power: 0.5, spin: { x: 0, y: 0 } } });
    const res = await a.next('shot');
    expect(res.by).toBe(0);
  });

  it('falls back to defaults when name or rules are the wrong type', async () => {
    const a = await TestClient.open(port);
    a.sendRaw(
      JSON.stringify({
        t: 'create',
        name: { evil: true },
        rules: { shotClock: '20', calledPockets: {}, ballInHand: 5 },
      }),
    );
    const room = await a.next('room');
    expect(room.room.names[0]).toBe('Player 1');
    expect(room.room.rules.shotClock).toBe(30);
    expect(room.room.rules.calledPockets).toBe(false);
    expect(room.room.rules.ballInHand).toBe('anywhere');
    a.close();
  });

  it('treats a non-string room code as no room at all', async () => {
    const a = await TestClient.open(port);
    a.sendRaw(JSON.stringify({ t: 'join', name: 'X', code: { a: 1 } }));
    const err = await a.next('error');
    expect(err.message).toMatch(/No room/);
    a.close();
  });

  it('keeps a finished match intact when both players rejoin', async () => {
    const a = await TestClient.open(port);
    const helloA = await a.next('hello');
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 30, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    const b = await TestClient.open(port);
    const helloB = await b.next('hello');
    b.send({ t: 'join', name: 'B', code: room.room.code });
    await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();

    // Break, then pot the 8 to finish the match.
    a.send({ t: 'shot', shot: { aim: 0, power: 1, spin: { x: 0, y: 0 } } });
    const afterBreak = (await a.next('shot')).state;
    await b.next('shot');
    (afterBreak.turn === 0 ? a : b).send({
      t: 'shot',
      shot: { aim: 0, power: 1, spin: { x: 0, y: 0 } },
    });
    const ended = (await a.next('shot')).state;
    await b.next('shot');
    expect(ended.over).not.toBeNull();

    // Both reload while the result dialog is up.
    a.close();
    b.close();
    await settle(300);

    const a2 = await TestClient.open(port);
    await a2.next('hello');
    a2.send({ t: 'rejoin', code: room.room.code, token: helloA.id });
    await a2.next('room');
    const first = await a2.next('start');
    expect(first.state.over).toEqual(ended.over);
    expect(first.state.turn).toBe(ended.turn);
    expect(first.remaining).toBe(0);
    // One seat back is still a held room.
    expect(first.holding).toBe(true);

    const b2 = await TestClient.open(port);
    await b2.next('hello');
    b2.send({ t: 'rejoin', code: room.room.code, token: helloB.id });
    await b2.next('room');
    const second = await b2.next('start');
    expect(second.state.over).toEqual(ended.over);
    expect(second.state.turn).toBe(ended.turn);
    expect(second.remaining).toBe(0);
    expect(second.holding).toBe(false);

    // Rejoining must not have recorded a timeout over the result.
    expect(a2.take('state')).toBeNull();

    // Rematch from a tab that came back.
    b2.send({ t: 'rematch' });
    const fresh = await a2.next('start');
    expect(fresh.state.over).toBeNull();
    expect(fresh.state.balls).toHaveLength(16);
    expect(fresh.state.balls.every((ball) => !ball.pocketed)).toBe(true);

    a2.close();
    b2.close();
  });

  it('removes the room when its host leaves', async () => {
    const a = await TestClient.open(port);
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 0, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    a.send({ t: 'leave' });
    await settle();

    const b = await TestClient.open(port);
    b.send({ t: 'join', name: 'B', code: room.room.code });
    const err = await b.next('error');
    expect(err.message).toMatch(/No room with that code/);

    a.close();
    b.close();
  });

  it('applies the behind-line rule to an ordinary foul, not just the break', async () => {
    const behind = await createStarted(port, 'behind');
    // Play the break, then have the second player miss everything so the first
    // gets ball in hand from an ordinary foul.
    behind.a.send({ t: 'shot', shot: { aim: 0, power: 1, spin: { x: 0, y: 0 } } });
    const afterBreak = (await behind.a.next('shot')).state;
    await behind.b.next('shot');

    const shooter = afterBreak.turn === 0 ? behind.a : behind.b;
    const miss = findNoContactShot(afterBreak.balls);
    expect(miss, 'a shot that hits no object ball').not.toBeNull();
    shooter.send({ t: 'shot', shot: miss! });
    const fouled = (await behind.a.next('shot')).state;
    await behind.b.next('shot');
    expect(fouled.ballInHand).toBe(true);

    const placer = fouled.turn === 0 ? behind.a : behind.b;
    const before = fouled.balls;

    // Centre table is past the head string: refused, board untouched.
    placer.send({ t: 'place', x: 0, y: 0 });
    const refused = await placer.next('error');
    expect(refused.message).toMatch(/not allowed/);
    await settle();

    // Behind the line is accepted and the cue moves there.
    placer.send({ t: 'place', x: -1.0, y: 0 });
    const placed = await placer.next('state');
    expect(placed.state.ballInHand).toBe(false);
    expect(placed.state.balls[0].p.x).toBeCloseTo(-1.0, 5);
    expect(placed.state.balls).not.toEqual(before);
  });

  it('lets the same spot through when the room allows ball in hand anywhere', async () => {
    const anywhere = await createStarted(port, 'anywhere');
    anywhere.a.send({ t: 'shot', shot: { aim: 0, power: 1, spin: { x: 0, y: 0 } } });
    const afterBreak = (await anywhere.a.next('shot')).state;
    await anywhere.b.next('shot');

    const shooter = afterBreak.turn === 0 ? anywhere.a : anywhere.b;
    const miss = findNoContactShot(afterBreak.balls);
    shooter.send({ t: 'shot', shot: miss! });
    const fouled = (await anywhere.a.next('shot')).state;
    await anywhere.b.next('shot');

    const placer = fouled.turn === 0 ? anywhere.a : anywhere.b;
    placer.send({ t: 'place', x: 0, y: 0 });
    const placed = await placer.next('state');
    expect(placed.state.ballInHand).toBe(false);
    expect(placed.state.balls[0].p.x).toBeCloseTo(0, 5);
  });

  it('rejects a shot and an overlapping placement while ball in hand is pending', async () => {
    const room = await createStarted(port, 'anywhere');
    room.a.send({ t: 'shot', shot: { aim: 0, power: 1, spin: { x: 0, y: 0 } } });
    const afterBreak = (await room.a.next('shot')).state;
    await room.b.next('shot');

    const shooter = afterBreak.turn === 0 ? room.a : room.b;
    shooter.send({ t: 'shot', shot: findNoContactShot(afterBreak.balls)! });
    const fouled = (await room.a.next('shot')).state;
    await room.b.next('shot');
    const placer = fouled.turn === 0 ? room.a : room.b;

    // A shot before placing is refused.
    placer.send({ t: 'shot', shot: { aim: 0, power: 0.4, spin: { x: 0, y: 0 } } });
    const noPlace = await placer.next('error');
    expect(noPlace.message).toMatch(/Place the cue ball first/);

    // So is a spot on top of an object ball.
    const occupied = fouled.balls.find((b) => b.id !== 0 && !b.pocketed)!;
    placer.send({ t: 'place', x: occupied.p.x, y: occupied.p.y });
    const overlapped = await placer.next('error');
    expect(overlapped.message).toMatch(/not allowed/);

    // A clear spot still works.
    placer.send({ t: 'place', x: -1.1, y: 0.3 });
    const placed = await placer.next('state');
    expect(placed.state.ballInHand).toBe(false);
  });
});

/** A shot from this position that touches no object ball at all. */
function findNoContactShot(balls: Parameters<typeof shoot>[0]) {
  for (let i = 0; i < 360; i++) {
    const aim = (i / 360) * Math.PI * 2;
    const shot = { aim, power: 0.45, spin: { x: 0, y: 0 } };
    const res = shoot(balls, shot, 0, false);
    if (res.events.every((e) => e.type !== 'ball')) return shot;
  }
  return null;
}

describe('late shots', () => {
  let lateServer: GameServer;
  let latePort = 0;
  // A clock the test owns, so being late costs no wall time.
  let clock = 5_000_000;

  beforeAll(async () => {
    lateServer = await createGameServer(0, undefined, () => clock);
    latePort = lateServer.port;
  });

  afterAll(async () => {
    await lateServer.close();
  });

  it('expires a turn that is already late and discards the shot', async () => {
    clock += 1_000;
    const a = await TestClient.open(latePort);
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 20, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    const b = await TestClient.open(latePort);
    b.send({ t: 'join', name: 'B', code: room.room.code });
    const [startA] = await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();

    // Past the deadline, then shoot: this used to be accepted because the
    // sweep had not run yet.
    clock += 21_000;
    a.send({ t: 'shot', shot: { aim: 0.3, power: 0.6, spin: { x: 0, y: 0 } } });

    const expired = await a.next('state', 4000);
    await b.next('state', 4000);
    expect(expired.state.message).toBe('shot clock expired');
    expect(expired.state.turn).toBe(1);
    // The shot was dropped, not simulated.
    expect(expired.state.balls).toEqual(startA.state.balls);

    // The turn moved exactly once, so the same player cannot shoot again.
    a.send({ t: 'shot', shot: { aim: 0.3, power: 0.6, spin: { x: 0, y: 0 } } });
    const refused = await a.next('error');
    expect(refused.message).toMatch(/Not your turn/);

    // And the player who inherited the turn gets a normal one, once they have
    // placed the cue ball they were awarded.
    b.send({ t: 'place', x: -1.0, y: 0 });
    const settled = await b.next('state');
    expect(settled.state.ballInHand).toBe(false);

    b.send({ t: 'shot', shot: { aim: 0.3, power: 0.6, spin: { x: 0, y: 0 } } });
    const played = await b.next('shot');
    expect(played.by).toBe(1);
    expect(played.state.balls).not.toEqual(startA.state.balls);

    a.close();
    b.close();
  });

  it('expires a placement that arrives after the deadline', async () => {
    clock += 1_000;
    const a = await TestClient.open(latePort);
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 20, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    const b = await TestClient.open(latePort);
    b.send({ t: 'join', name: 'B', code: room.room.code });
    await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();

    // A is late, so the turn and the ball in hand pass to B.
    clock += 21_000;
    a.send({ t: 'shot', shot: { aim: 0.3, power: 0.5, spin: { x: 0, y: 0 } } });
    const fouled = await a.next('state', 4000);
    await b.next('state', 4000);
    expect(fouled.state.ballInHand).toBe(true);
    const cueBefore = fouled.state.balls[0].p;

    // B leaves it too long as well: the placement expires and the cue stays put.
    clock += 21_000;
    b.send({ t: 'place', x: -1.0, y: 0 });
    const expired = await b.next('state', 4000);
    await a.next('state', 4000);
    expect(expired.state.message).toBe('shot clock expired');
    expect(expired.state.balls[0].p).toEqual(cueBefore);

    a.close();
    b.close();
  });

  it('keeps the pause when both seats drop and resumes once both are back', async () => {
    clock += 1_000;
    const a = await TestClient.open(latePort);
    const helloA = await a.next('hello');
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 20, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    const b = await TestClient.open(latePort);
    const helloB = await b.next('hello');
    b.send({ t: 'join', name: 'B', code: room.room.code });
    const [startA] = await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();

    // Both sockets die with 14 seconds left on the turn.
    clock += 6_000;
    a.close();
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    // First seat back: the room is still held, so no clock is handed out.
    const a2 = await TestClient.open(latePort);
    await a2.next('hello');
    a2.send({ t: 'rejoin', code: room.room.code, token: helloA.id });
    await a2.next('room');
    const first = await a2.next('start');
    expect(first.holding).toBe(true);
    expect(first.remaining).toBe(0);
    expect(first.state.turn).toBe(startA.state.turn);

    // Second seat back: now it resumes, with what was left rather than a fresh
    // period. The second disconnect must not have cleared the saved pause.
    const b2 = await TestClient.open(latePort);
    await b2.next('hello');
    b2.send({ t: 'rejoin', code: room.room.code, token: helloB.id });
    await b2.next('room');
    const second = await b2.next('start');
    expect(second.holding).toBe(false);
    expect(second.remaining).toBeGreaterThan(13_000);
    expect(second.remaining).toBeLessThanOrEqual(14_000);
    expect(second.state.turn).toBe(startA.state.turn);

    // And the player who came back first is told the same timing.
    const resumed = await a2.next('clock');
    expect(resumed.holding).toBe(false);
    expect(resumed.remaining).toBe(second.remaining);

    a2.close();
    b2.close();
  });

  it('decides the resumed deadline without a race', () => {
    // Clock switched off: stays off, whatever was paused.
    expect(resumeDeadline(false, 0, 1000)).toBe(0);
    expect(resumeDeadline(false, 14_000, 1000)).toBe(0);
    // Paused: resumes with exactly what was left.
    expect(resumeDeadline(true, 14_000, 1000)).toBe(15_000);
    // Ran out while the seat was held: expire it, do not hand out a new period.
    expect(resumeDeadline(true, 0, 1000)).toBeNull();
  });

  it('tells the connected player when the turn is held and when it resumes', async () => {
    clock += 1_000;
    const a = await TestClient.open(latePort);
    await a.next('hello');
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 20, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    const b = await TestClient.open(latePort);
    const helloB = await b.next('hello');
    b.send({ t: 'join', name: 'B', code: room.room.code });
    await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();

    clock += 6_000;
    b.close();
    const held = await a.next('clock');
    const notice = await a.next('error');
    expect(notice.message).toMatch(/disconnected/i);
    expect(held.holding).toBe(true);
    expect(held.remaining).toBeGreaterThan(13_000);
    expect(held.remaining).toBeLessThanOrEqual(14_000);

    // The player left behind cannot carry on alone.
    a.send({ t: 'shot', shot: { aim: 0.3, power: 0.5, spin: { x: 0, y: 0 } } });
    const blocked = await a.next('error');
    expect(blocked.message).toMatch(/Waiting for the other player/);

    clock += 5_000;
    const back = await TestClient.open(latePort);
    back.send({ t: 'rejoin', code: room.room.code, token: helloB.id });
    await back.next('room');
    const resumedSelf = await back.next('start');
    const resumedPeer = await a.next('clock');

    expect(resumedSelf.remaining).toBeGreaterThan(13_000);
    expect(resumedPeer.holding).toBe(false);
    expect(resumedPeer.remaining).toBe(resumedSelf.remaining);

    a.close();
    back.close();
  });

  it('keeps a disabled clock disabled across a rejoin', async () => {
    clock += 1_000;
    const a = await TestClient.open(latePort);
    await a.next('hello');
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 0, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');
    const b = await TestClient.open(latePort);
    const helloB = await b.next('hello');
    b.send({ t: 'join', name: 'B', code: room.room.code });
    await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();

    clock += 60_000;
    b.close();
    await a.next('clock');
    await a.next('error');

    clock += 60_000;
    const back = await TestClient.open(latePort);
    back.send({ t: 'rejoin', code: room.room.code, token: helloB.id });
    await back.next('room');
    const resumed = await back.next('start');
    expect(resumed.remaining).toBe(0);

    // No foul was produced by the rejoin itself.
    const peer = await a.next('clock');
    expect(peer.holding).toBe(false);
    expect(peer.remaining).toBe(0);

    a.close();
    back.close();
  });

  it('resumes a turn with the time that was left, not a fresh clock', async () => {    clock += 1_000;
    const a = await TestClient.open(latePort);
    await a.next('hello');
    a.send({
      t: 'create',
      name: 'A',
      rules: { ruleset: 'american', shotClock: 20, calledPockets: false, ballInHand: 'anywhere' },
    });
    const room = await a.next('room');

    const b = await TestClient.open(latePort);
    const helloB = await b.next('hello');
    b.send({ t: 'join', name: 'B', code: room.room.code });
    await Promise.all([a.next('start'), b.next('start')]);
    a.clear();
    b.clear();

    // Six of the twenty seconds are gone when B's socket dies.
    clock += 6_000;
    b.close();
    const notice = await a.next('error');
    expect(notice.message).toMatch(/disconnected/i);

    // Five more pass while the seat is held. That time is not the turn's.
    clock += 5_000;
    const back = await TestClient.open(latePort);
    back.send({ t: 'rejoin', code: room.room.code, token: helloB.id });
    await back.next('room');
    const resumed = await back.next('start');

    expect(resumed.remaining).toBeGreaterThan(13_000);
    expect(resumed.remaining).toBeLessThanOrEqual(14_000);

    a.close();
    back.close();
  });
});
