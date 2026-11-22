import { createGameServer } from './game';

// Behind a reverse proxy, so listen on loopback unless told otherwise.
const host = process.env.HOST ?? '127.0.0.1';
const server = await createGameServer(Number(process.env.PORT ?? 8787), host);
console.log(`8ball server on http://${host}:${server.port}  (ws: /ws)`);
