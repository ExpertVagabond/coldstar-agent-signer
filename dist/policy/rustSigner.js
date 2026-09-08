// Delegating to Coldstar's Rust signer when it is installed.
//
// This package decrypts the root key into an ordinary JavaScript heap. Nothing
// locks those pages against swap, and zeroing a buffer afterwards does not reach
// copies the runtime has already made. Coldstar's `secure_signer` does better:
// `secure_buffer.rs` locks with `mlock` and zeroizes on drop, including on panic,
// and `crypto.rs` routes every plaintext-key path through it.
//
// So when the `solana-signer` binary is present, hand it the work. The plaintext
// key then never exists in this process at all. When it is absent, the pure
// TypeScript path still runs, because it is the reason the air-gapped machine
// needs neither Node nor a package installer.
//
// The passphrase and the container go over stdin as one JSON line, never as
// arguments. `solana-signer sign --passphrase …` exists but would put the
// passphrase in `ps` output and shell history, so it is not used here.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
/** Where to look, in order. An explicit path always wins. */
function candidatePaths() {
    const out = [];
    if (process.env.COLDSTAR_SIGNER_BIN)
        out.push(process.env.COLDSTAR_SIGNER_BIN);
    if (process.env.COLDSTAR_HOME) {
        out.push(join(process.env.COLDSTAR_HOME, "secure_signer", "target", "release", "solana-signer"));
    }
    return out;
}
function isExecutable(p) {
    try {
        accessSync(p, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Locate the signer, or return null. Never throws: absence is the normal case,
 * not an error, and the caller falls back to the in-process path.
 */
export function findRustSigner() {
    for (const p of candidatePaths())
        if (isExecutable(p))
            return p;
    try {
        // `which` rather than a PATH walk, so a shell alias or shim is honoured.
        const found = execFileSync("which", ["solana-signer"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (found && isExecutable(found))
            return found;
    }
    catch {
        /* not on PATH */
    }
    return null;
}
function runOneCommand(bin, command, timeoutMs = 30_000) {
    const line = JSON.stringify(command) + "\n";
    let stdout;
    try {
        stdout = execFileSync(bin, ["--stdin"], {
            input: line,
            encoding: "utf8",
            timeout: timeoutMs,
            stdio: ["pipe", "pipe", "pipe"],
            maxBuffer: 4 * 1024 * 1024,
        });
    }
    catch (e) {
        const err = e;
        throw new Error(`solana-signer failed: ${(err.stderr || err.message || "unknown").toString().trim()}`);
    }
    const first = stdout.split("\n").find((l) => l.trim().length > 0);
    if (!first)
        throw new Error("solana-signer returned nothing");
    try {
        return JSON.parse(first);
    }
    catch {
        throw new Error(`solana-signer returned unparseable output: ${first.slice(0, 200)}`);
    }
}
/** Ask the binary what it can do here. Memory locking can fail at runtime. */
export function rustSignerCapabilities(bin) {
    const out = runOneCommand(bin, { action: "check" });
    const data = (out.data ?? {});
    const locking = data.mlock_supported ?? data.memory_locking ?? data.mlock ?? data.memlock_supported ?? false;
    return { memoryLocking: locking === true || locking === 1, raw: out.data };
}
/**
 * Sign arbitrary bytes with a key that never leaves the Rust process.
 *
 * The command is named `sign` and its field is `transaction`, but the signer
 * Ed25519-signs whatever bytes it is given and returns a detached signature
 * (`sign_with_secure_key` in `crypto.rs`), so a canonical policy payload works.
 * The `signed_transaction` field it also returns is meaningless here; ignore it.
 */
export function signWithRustSigner(bin, containerJson, passphrase, payload) {
    const out = runOneCommand(bin, {
        action: "sign",
        container: containerJson,
        passphrase,
        transaction: Buffer.from(payload).toString("base64"),
    }, 120_000);
    if (!out.success) {
        const msg = (out.error ?? "unknown error").toString();
        if (/decrypt|passphrase|InvalidTag|DecryptionFailed/i.test(msg)) {
            throw new Error("wrong passphrase, or the key file has been altered");
        }
        throw new Error(`solana-signer: ${msg}`);
    }
    const data = (out.data ?? {});
    const signature = data.signature;
    const publicKey = data.public_key ?? data.publicKey;
    if (typeof signature !== "string" || typeof publicKey !== "string") {
        throw new Error("solana-signer returned no signature");
    }
    return { signature, publicKey };
}
//# sourceMappingURL=rustSigner.js.map