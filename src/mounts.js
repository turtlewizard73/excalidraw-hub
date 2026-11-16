// Boot-race guard. Docker Desktop can start the container before it connects the WSL bind mount,
// leaving an empty folder for the container's whole life. main.js exits on a reason here, so the
// restart policy retries until the real folder is connected (spec: "Boot race").
import fs from 'node:fs/promises';

/** Returns null when `dir` has at least one entry, otherwise why the drawings folder is not usable. */
export async function checkDrawingsDir(dir) {
  let entries;
  try { entries = await fs.readdir(dir); } catch (e) { return `cannot read drawings folder ${dir}: ${e.code ?? e.message}`; }
  return entries.length ? null : `drawings folder ${dir} is empty (under Docker: bind mount not connected yet?)`;
}
