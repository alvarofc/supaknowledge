// Runs `npx <args>` without handing the arguments to a shell. On Windows npx is npx.cmd, which spawnSync can
// only start through cmd.exe (whose parsing would split or interpret an argument such as $DENO), so there we
// run npm's own npx-cli.js with the current node instead. If it cannot be found we fall back to the shell, but
// only for arguments made of characters cmd.exe treats literally.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SHELL_SAFE = /^[A-Za-z0-9@._\/\\:=+-]+$/;

function npxCli() {
  const candidates = [
    process.env.npm_execpath && join(dirname(process.env.npm_execpath), "npx-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  return candidates.find((p) => p && existsSync(p));
}

/** spawnSync("npx", args, opts), safe on every platform. */
export function spawnNpx(args, opts = {}) {
  if (process.platform !== "win32") return spawnSync("npx", args, opts);
  const cli = npxCli();
  if (cli) return spawnSync(process.execPath, [cli, ...args], opts);
  const unsafe = args.find((a) => !SHELL_SAFE.test(a));
  if (unsafe !== undefined) throw new Error(`refusing to pass ${JSON.stringify(unsafe)} through cmd.exe (npx-cli.js not found)`);
  return spawnSync("npx", args, { ...opts, shell: true });
}
