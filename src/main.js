// Entry point. Configuration comes from the environment (compose.yaml).
import { createCanvas } from './canvas.js';
import { createServer } from './server.js';
import { createStore } from './store.js';

const port = Number(process.env.HUB_PORT ?? 3080);
const host = process.env.HUB_HOST ?? '127.0.0.1';
const canvasUrl = process.env.CANVAS_URL ?? 'http://127.0.0.1:3000';
const canvasPublicUrl = process.env.CANVAS_PUBLIC_URL ?? canvasUrl;
const drawings = process.env.DRAWINGS_DIR ?? '/data';

const server = createServer({
  store: createStore(drawings),
  canvas: createCanvas(canvasUrl),
  canvasPublicUrl,
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
});
server.listen(port, host, () => console.log(`excalidraw-hub on http://${host}:${port} (drawings ${drawings}, canvas ${canvasUrl})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
