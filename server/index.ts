import { createGameServer } from './game';

const server = await createGameServer(Number(process.env.PORT ?? 8787));
console.log(`8ball server on http://localhost:${server.port}  (ws: /ws)`);
