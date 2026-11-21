import type { ClientMsg, ServerMsg } from '../../shared/protocol';

/** Thin wrapper around a WebSocket. No reconnect, no retries: it is a game. */
export class Net {
  private ws: WebSocket;
  onMessage: (m: ServerMsg) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  constructor(url?: string) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(url ?? `${proto}://${location.host}/ws`);
    this.ws.onopen = () => this.onOpen();
    this.ws.onclose = () => this.onClose();
    this.ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMsg);
      } catch {
        /* malformed, ignore */
      }
    };
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}
