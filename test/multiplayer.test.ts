import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '../server/game';
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
    expect(shot.state.turn).toBe(1);
    expect(shot.state.onBreak).toBe(false);
    expect(otherShot.state).toEqual(shot.state);
    expect(shot.state.balls).toEqual(shoot(startA.state.balls, opening, 0, true).balls);

    // Player A cannot shoot out of turn.
    a.send({ t: 'shot', shot: { aim: 0, power: 0.9, spin: { x: 0, y: 0 } } });
    const err = await a.next('error');
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

    a.close();
    b.close();
  });
});
