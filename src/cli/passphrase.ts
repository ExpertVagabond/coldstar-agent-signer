// Reading a passphrase without putting it somewhere it will be found later.
//
// Not an argument: process arguments are visible in `ps` and land in shell
// history. Env var only when explicitly asked for, because it is inherited by
// every child process. A terminal prompt with echo disabled otherwise.

import { createInterface } from "node:readline";

let pipedPassphrase: string | undefined;

/** Read a passphrase. Prefers the terminal; falls back to a piped line. */
export async function readPassphrase(prompt: string): Promise<string> {
  const fromEnv = process.env.COLDSTAR_PASSPHRASE;
  if (fromEnv) {
    process.stderr.write("warning: using COLDSTAR_PASSPHRASE from the environment; it is inherited by child processes\n");
    return fromEnv;
  }

  if (!process.stdin.isTTY) {
    // Piped, e.g. from a password manager: read one line and remember it. The
    // stream yields that line once, so a second caller must get the cached copy
    // rather than an "empty stdin" error.
    if (pipedPassphrase === undefined) {
      const rl = createInterface({ input: process.stdin });
      for await (const line of rl) {
        pipedPassphrase = line.replace(/\r$/, "");
        break;
      }
      rl.close();
    }
    if (pipedPassphrase === undefined) throw new Error("no passphrase on stdin");
    return pipedPassphrase;
  }

  process.stderr.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let out = "";
  try {
    for await (const chunk of stdin) {
      const s = chunk.toString("utf8");
      let done = false;
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") { done = true; break; }
        if (ch === "\u0003") { process.stderr.write("\n"); process.exit(130); }               // Ctrl-C
        if (ch === "\u0004" && out === "") { process.stderr.write("\n"); process.exit(130); } // Ctrl-D on an empty line
        if (ch === "\u007f" || ch === "\b") { out = out.slice(0, -1); continue; }             // backspace
        if (ch === "\u0015") { out = ""; continue; }                                           // Ctrl-U clears the line
        if (ch >= " ") out += ch;
      }
      if (done) break;
    }
  } finally {
    stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
    process.stderr.write("\n");
  }
  return out;
}

/**
 * Read a passphrase that is about to encrypt a key for the first time.
 *
 * Confirmed by typing it twice, because a typo here loses the key permanently
 * — but only at a terminal. A piped passphrase has no human to re-type it, and
 * asking twice would just consume a line that is not coming.
 */
export async function readNewPassphrase(): Promise<string> {
  const interactive = process.stdin.isTTY && !process.env.COLDSTAR_PASSPHRASE;
  const first = await readPassphrase("New passphrase for the root key: ");
  if (first.length < 8) throw new Error("passphrase must be at least 8 characters");
  if (!interactive) return first;
  const again = await readPassphrase("Confirm: ");
  if (first !== again) throw new Error("passphrases do not match");
  return first;
}
