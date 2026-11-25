import { createInterface } from "node:readline";
import { main } from "./program.ts";
import type { Io } from "./context.ts";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function prompt(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new Error(`cannot prompt for "${question.trim()}" without a terminal`));
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      // mute echo while typing
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
        else if (s === "\r\n" || s === "\n") out.output.write("\n");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(answer);
    });
  });
}

const io: Io = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  readStdin,
  prompt,
  isTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  env: process.env,
  cwd: process.cwd(),
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

main(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`fatal: ${(e as Error)?.stack ?? e}\n`);
    process.exitCode = 1;
  },
);
