// Entry point. Configuration comes from the environment (compose.yaml).
import path from 'node:path';
import { createBackups } from './backups.js';
import { createCanvas } from './canvas.js';
import { createGit, gitRunner } from './git.js';
import { checkDrawingsDir } from './mounts.js';
import { createServer } from './server.js';
import { createStore } from './store.js';

const port = Number(process.env.HUB_PORT ?? 3080);
const host = process.env.HUB_HOST ?? '127.0.0.1';
const canvasUrl = process.env.CANVAS_URL ?? 'http://127.0.0.1:3000';
const canvasPublicUrl = process.env.CANVAS_PUBLIC_URL ?? canvasUrl;
const drawings = path.resolve(process.env.DRAWINGS_DIR ?? '/data');
const backupsDir = process.env.BACKUPS_DIR ?? '/backups';

// Git sync is on when REPO_DIR is set and contains the drawings folder.
let git = null;
const repo = process.env.REPO_DIR ? path.resolve(process.env.REPO_DIR) : null;
if (repo) {
  const rel = path.relative(repo, drawings);
  if (rel.startsWith('..') || path.isAbsolute(rel)) console.error(`git sync off: ${drawings} is not inside REPO_DIR ${repo}`);
  else git = createGit({ run: gitRunner(repo), drawingsPath: rel, branch: process.env.SYNC_BRANCH || 'development' });
}

// Exit: under Docker the restart policy retries until Docker Desktop has connected the mount (spec: "Boot race");
// scripts/native.sh shows this message and stops.
const notReady = await checkDrawingsDir(drawings);
if (notReady) { console.error(`excalidraw-hub not starting: ${notReady}; exiting (Docker restarts it; scripts/native.sh stops)`); process.exit(1); }

const server = createServer({
  store: createStore(drawings),
  canvas: createCanvas(canvasUrl),
  backups: createBackups(backupsDir),
  git,
  canvasPublicUrl,
  // Host header allowlist (DNS-rebinding guard). Default: the loopback names a local browser uses.
  allowedHosts: process.env.HUB_ALLOWED_HOSTS ? process.env.HUB_ALLOWED_HOSTS.split(',').map((h) => h.trim()) : [`127.0.0.1:${port}`, `localhost:${port}`],
});
server.listen(port, host, () => console.log(`excalidraw-hub on http://${host}:${port} (drawings ${drawings}, backups ${backupsDir}, git sync ${git ? `on, branch ${git.syncBranch}` : 'off'}, canvas ${canvasUrl})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
