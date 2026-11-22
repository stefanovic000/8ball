import type { Ball, Shot } from '../src/core/physics';
import type { GameState, Rules, Side } from '../src/core/rules';

export type NameMsg =
  | { t: 'create'; name: string; rules: Rules }
  | { t: 'join'; name: string; code: string };

export type ClientMsg =
  | NameMsg
  | { t: 'rules'; rules: Rules }
  | { t: 'start' }
  | { t: 'shot'; shot: Shot }
  | { t: 'place'; x: number; y: number }
  | { t: 'timeout' }
  | { t: 'rematch' }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'leave' };

export type RoomInfo = {
  code: string;
  you: Side;
  names: [string, string | null];
  rules: Rules;
  started: boolean;
};

export type ServerMsg =
  | { t: 'hello'; id: string }
  | { t: 'room'; room: RoomInfo }
  | { t: 'start'; state: GameState }
  | { t: 'shot'; by: Side; shot: Shot; state: WebState }
  | { t: 'state'; state: WebState }
  | { t: 'peer'; joined: boolean; name: string }
  | { t: 'error'; message: string }
  | { t: 'bye' };

/** GameState with balls as plain serialisable data. */
export type WebState = Omit<GameState, 'balls'> & { balls: Ball[] };
