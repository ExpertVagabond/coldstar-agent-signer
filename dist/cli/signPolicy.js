#!/usr/bin/env node
// `coldstar-sign-policy` — run on the AIR-GAPPED machine. Signs a policy for one
// session key with the root key and prints the envelope JSON to stdout. Move the
// output across the gap (QR, file); the online signer verifies it at startup.
//
//   coldstar-sign-policy --root /path/to/root.json --policy coldstar.policy.json \
//                        --session <session pubkey base58> [--expires 24h|7d|2026-12-31T00:00:00Z]
//                        [--revoker <pubkey>]   a hot key that may revoke this grant on chain
//                        [--allow-network]      override the air-gap check (do not, for a real root)
//
// The root may be an encrypted container from `coldstar-encrypt-key` (preferred,
// and the same format the Coldstar signer uses) or a plaintext solana-keygen
// file (deprecated, and warned about loudly).
//
// Nothing here touches a network. The root secret never leaves this process.
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { signPolicyEnvelope, buildPolicyEnvelope, parsePolicy } from "../policy/envelope.js";
import { findRustSigner, rustSignerCapabilities, signWithRustSigner } from "../policy/rustSigner.js";
import { checkAirGap, describeAirGap } from "../policy/airgap.js";
import { decryptRootKey, isEncryptedKeyContainer, normalizeKeyContainer, wipe } from "../policy/keyfile.js";
import { decryptLegacyRootKey, isLegacyKeyContainer } from "../policy/legacyKeyfile.js";
import { wrapPolicyEnvelope } from "../policy/wireEnvelope.js";
import { readPassphrase } from "./passphrase.js";
function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg) {
    process.stderr.write(`coldstar-sign-policy: ${msg}\n`);
    process.exit(2);
}
const rootPath = arg("root") ?? fail("--root <keyfile> is required (the ROOT key, on the offline machine)");
const policyPath = arg("policy") ?? "coldstar.policy.json";
const sessionPubkey = arg("session") ?? fail("--session <base58 pubkey> is required");
const expiresArg = arg("expires");
const revoker = arg("revoker"); // hot key allowed to revoke this grant on chain
let expiresAt = null;
if (expiresArg) {
    const m = /^(\d+)([hd])$/.exec(expiresArg);
    if (m) {
        const n = Number(m[1]);
        expiresAt = new Date(Date.now() + n * (m[2] === "h" ? 3_600_000 : 86_400_000));
    }
    else {
        expiresAt = new Date(expiresArg);
        if (Number.isNaN(expiresAt.getTime()))
            fail(`--expires: cannot parse '${expiresArg}' (use 24h, 7d, or ISO-8601)`);
    }
}
// The root secret is about to be read into memory. If this machine has a live
// network path it is not the air-gapped machine, whatever the operator believes.
const gap = checkAirGap();
if (!gap.airGapped && !process.argv.includes("--allow-network")) {
    process.stderr.write(`coldstar-sign-policy: ${describeAirGap(gap)}\n` +
        "Refusing to read the root key on a networked machine. Move to the offline machine, or pass\n" +
        "--allow-network if you have decided this is acceptable (it is not, for a real root key).\n");
    process.exit(3);
}
if (!gap.airGapped) {
    process.stderr.write("coldstar-sign-policy: WARNING — signing the root key on a NETWORKED machine (--allow-network).\n");
}
// The root may be an encrypted container (preferred) or a plaintext
// solana-keygen array (deprecated: it is the thing Coldstar exists to avoid).
let rootRaw;
try {
    rootRaw = JSON.parse(readFileSync(rootPath, "utf8"));
}
catch (e) {
    fail(`cannot read ${rootPath}: ${e.message}`);
}
let root;
let seed;
/** Set when Coldstar's Rust signer will do the signing instead of this process. */
let delegate;
const rootContainer = normalizeKeyContainer(rootRaw);
const rustBin = process.argv.includes("--no-rust-signer") ? null : findRustSigner();
if (isEncryptedKeyContainer(rootContainer) && rustBin) {
    // The better path. secure_buffer.rs locks the key's pages against swap and
    // zeroizes on drop, which nothing in Node can do.
    const caps = rustSignerCapabilities(rustBin);
    process.stderr.write(`using Coldstar's signer at ${rustBin}` +
        (caps.memoryLocking ? " (memory locking available)" : " (WARNING: this machine cannot lock memory)") +
        "\n");
    const passphrase = await readPassphrase(`Passphrase for ${rootContainer.public_key ?? rootPath}: `);
    delegate = { bin: rustBin, containerJson: JSON.stringify(rootContainer), passphrase };
}
else if (isEncryptedKeyContainer(rootContainer)) {
    const passphrase = await readPassphrase(`Passphrase for ${rootContainer.public_key ?? rootPath}: `);
    process.stderr.write("deriving the key (Argon2id, 64 MB)…\n");
    try {
        seed = decryptRootKey(rootContainer, passphrase);
    }
    catch (e) {
        fail(e.message);
    }
    root = Keypair.fromSeed(seed);
    if (rootContainer.public_key && rootContainer.public_key !== root.publicKey.toBase58()) {
        fail("the container's public_key does not match the key inside it");
    }
}
else if (isLegacyKeyContainer(rootRaw)) {
    // An older Coldstar wallet that has not been opened by a recent build. Read it
    // rather than tell a Coldstar user their own key file is not a key file.
    const passphrase = await readPassphrase(`Passphrase for ${rootPath}: `);
    process.stderr.write("legacy Coldstar key file; deriving the key (Argon2id, libsodium parameters)…\n");
    try {
        seed = decryptLegacyRootKey(rootRaw, passphrase);
    }
    catch (e) {
        fail(e.message);
    }
    root = Keypair.fromSeed(seed);
    process.stderr.write("NOTE: this key file is in Coldstar's older format. Convert it with\n" +
        `      \`coldstar-encrypt-key --in ${rootPath} --out <new file>\`\n`);
}
else if (Array.isArray(rootRaw)) {
    process.stderr.write("WARNING: this root key is stored in PLAINTEXT. Encrypt it with `coldstar-encrypt-key`;\n" +
        "         a plaintext key on disk is exactly what Coldstar exists to avoid.\n");
    root = Keypair.fromSecretKey(Uint8Array.from(rootRaw));
}
else {
    fail(`${rootPath} is neither an encrypted container nor a solana-keygen key file`);
}
const policy = parsePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
for (const k of ["allowRecipients", "blockRecipients"]) {
    if (policy[k].some((v) => v.startsWith("<") || v.startsWith("$")))
        fail(`policy.${k} still has a placeholder`);
}
const envelope = delegate
    ? buildPolicyEnvelope({
        signPayload: (payload) => {
            const { signature, publicKey } = signWithRustSigner(delegate.bin, delegate.containerJson, delegate.passphrase, payload);
            return { signature, rootPubkey: publicKey };
        },
        policy,
        sessionPubkey,
        expiresAt,
        ...(revoker ? { revoker } : {}),
    })
    : signPolicyEnvelope({ rootSecretKey: root.secretKey, policy, sessionPubkey, expiresAt, ...(revoker ? { revoker } : {}) });
if (delegate && rootContainer && rootContainer.public_key) {
    // The Rust signer reports which key it used; check it is the one claimed.
    const claimed = rootContainer.public_key;
    if (claimed !== envelope.rootPubkey)
        fail("the container's public_key does not match the key inside it");
}
wipe(seed); // the signature is made; the key material has no further use here
if (process.argv.includes("--wire")) {
    // Coldstar's air-gap wrapper, so the grant can cross the gap by the same route
    // a transaction does, including as a QR code.
    process.stdout.write(wrapPolicyEnvelope(envelope) + "\n");
}
else {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
}
process.stderr.write(`signed by root ${envelope.rootPubkey} for session ${sessionPubkey}` +
    (expiresAt ? `, expires ${envelope.expiresAt}` : ", no expiry (consider --expires)") +
    (revoker ? `, revocable by ${revoker}` : "") + "\n");
process.stderr.write(`air gap: ${describeAirGap(gap)}\n`);
//# sourceMappingURL=signPolicy.js.map