// Entry point. Configuration comes from the environment (compose.yaml).
import { createAutosave } from './autosave.js';
import { createCanvas } from './canvas.js';
import { createServer } from './server.js';
import { createStore } from './store.js';

const port = Number(process.env.HUB_PORT ?? 3080);
const host = process.env.HUB_HOST ?? '127.0.0.1';
const canvasUrl = process.env.CANVAS_URL ?? 'http://127.0.0.1:3000';
const canvasPublicUrl = process.env.CANVAS_PUBLIC_URL ?? canvasUrl;
const drawings = process.env.DRAWINGS_DIR ?? '/data';
const autosaveDir = process.env.AUTOSAVE_DIR ?? '/autosave';

const server = createServer({
  store: createStore(drawings),
  canvas: createCanvas(canvasUrl),
  autosave: createAutosave(autosaveDir),
  canvasPublicUrl,
  // Host header allowlist (DNS-rebinding guard). Default: the loopback names a local browser uses.
  allowedHosts: process.env.HUB_ALLOWED_HOSTS ? process.env.HUB_ALLOWED_HOSTS.split(',').map((h) => h.trim()) : [`127.0.0.1:${port}`, `localhost:${port}`],
});
server.listen(port, host, () => console.log(`excalidraw-hub on http://${host}:${port} (drawings ${drawings}, autosave ${autosaveDir}, canvas ${canvasUrl})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
