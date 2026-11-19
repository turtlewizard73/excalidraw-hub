// The only place that reads environment variables. loadConfig is pure: pass an env object, get settings back.
import os from 'node:os';
import path from 'node:path';

const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  // Empty strings count as unset, so `FOO=` in a .env file falls back to the default.
  const get = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : env[name]);

  // CANVAS_PORT only builds the default CANVAS_URL; it is not part of the returned config.
  const canvasPort = get('CANVAS_PORT', '3000');
  const canvasUrl = get('CANVAS_URL', `http://127.0.0.1:${canvasPort}`);
  const port = Number(get('HUB_PORT', '3080'));
  const allowedHosts = get('HUB_ALLOWED_HOSTS', null);

  return {
    // Port the hub listens on.
    port,
    // Bind address. Undocumented debug override: the hub has no auth, so keep it on loopback.
    host: get('HUB_HOST', '127.0.0.1'),
    // How the hub server reaches the canvas (server to server).
    canvasUrl,
    // How the browser reaches the canvas (links, iframe). Defaults to CANVAS_URL.
    canvasPublicUrl: get('CANVAS_PUBLIC_URL', canvasUrl),
    // Folders may only be attached inside this root. Default: the user's home.
    foldersRoot: path.resolve(get('FOLDERS_ROOT', os.homedir())),
    // State file written by the hub (attached folders, recent folders).
    statePath: path.resolve(get('HUB_STATE', './config/hub.json')),
    // Where backups of overwritten drawings are kept.
    backupsDir: path.resolve(get('BACKUPS_DIR', './backups')),
    // Branches where the sync button commits and pushes without asking.
    autoSyncBranches: list(get('HUB_AUTO_SYNC_BRANCHES', 'development,dev')),
    // 1 = exit at start while FOLDERS_ROOT is empty or unreadable (Docker restarts the hub until the mount is ready).
    waitForMount: get('HUB_WAIT_FOR_MOUNT', '0') === '1',
    // Host header allowlist (DNS-rebinding guard). Default: the loopback names a local browser uses.
    allowedHosts: allowedHosts ? list(allowedHosts) : [`127.0.0.1:${port}`, `localhost:${port}`],
  };
}
