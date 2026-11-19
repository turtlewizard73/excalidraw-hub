// Boot-race guard. Docker Desktop can start the container before it connects the WSL bind mount,
// leaving an empty folder for the container's whole life. main.js exits on a reason here, so the
// restart policy retries until the real folder is connected (spec: "Boot race").
import fs from 'node:fs/promises';

/** Returns null when `dir` (FOLDERS_ROOT) is readable and has at least one entry, otherwise why it is not usable. */
export async function checkDrawingsDir(dir) {
  if (!dir) return 'FOLDERS_ROOT is not set';
  let entries;
  try { entries = await fs.readdir(dir); } catch (e) { return `cannot read FOLDERS_ROOT ${dir}: ${e.code ?? e.message}`; }
  return entries.length ? null : `FOLDERS_ROOT ${dir} is empty (under Docker: bind mount not connected yet?)`;
}
