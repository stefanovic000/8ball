import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '../server/game';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

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
      rules: { shotClock: 0, calledPockets: false, ballInHand: 'anywhere' },
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

    // Break, weakly, so nothing is potted and the turn passes.
    a.send({ t: 'shot', shot: { aim: 0, power: 0.05, spin: { x: 0, y: 0 } } });
    const shot = await a.next('shot');
    expect(shot.by).toBe(0);
    expect(shot.state.turn).toBe(1);

    // Player A cannot shoot out of turn.
    a.send({ t: 'shot', shot: { aim: 0, power: 0.9, spin: { x: 0, y: 0 } } });
    const err = await a.next('error');
    expect(err.message).toMatch(/Not your turn/);

    a.close();
    b.close();
  });

  it('rejects an impossible spin offset', async () => {
    const a = await TestClient.open(port);
    a.send({ t: 'create', name: 'A', rules: { shotClock: 0, calledPockets: false, ballInHand: 'anywhere' } });
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
});
