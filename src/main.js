// Entry point. All configuration comes from src/config.js.
import { createCanvas } from './canvas.js';
import { loadConfig } from './config.js';
import { checkDrawingsDir } from './mounts.js';
import { createServer } from './server.js';
import { createWorkspace } from './workspace.js';

const cfg = loadConfig();

// Exit: under Docker the restart policy retries until Docker Desktop has connected the mount (spec: "Boot race").
if (cfg.waitForMount) {
  const notReady = await checkDrawingsDir(cfg.foldersRoot);
  if (notReady) { console.error(`excalidraw-hub not starting: ${notReady}; exiting (Docker restarts it)`); process.exit(1); }
}

// TEMPORARY BRIDGE (step 1): workspace.js still requires a primary folder until step 2 removes it. FOLDERS_ROOT stands in, with no git sync.
const workspace = await createWorkspace({ primary: { path: cfg.foldersRoot, git: null }, backupsDir: cfg.backupsDir, file: cfg.statePath, foldersRoot: cfg.foldersRoot });
const server = createServer({
  workspace,
  canvas: createCanvas(cfg.canvasUrl),
  canvasPublicUrl: cfg.canvasPublicUrl,
  allowedHosts: cfg.allowedHosts,
});
server.listen(cfg.port, cfg.host, () => console.log(`excalidraw-hub on http://${cfg.host}:${cfg.port} (state ${cfg.statePath}, folders root ${cfg.foldersRoot}, backups ${cfg.backupsDir}, canvas ${cfg.canvasUrl})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
