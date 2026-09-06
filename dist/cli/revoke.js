#!/usr/bin/env node
// `coldstar-revoke` — cancel a grant early by writing a signed marker on chain.
//
//   coldstar-revoke --authority revoker.json --session <session pubkey> [--rpc <url>]
//   coldstar-revoke --authority root.json    --session <session pubkey> --unsigned  > revoke.b64
//
// The authority must be the ROOT that signed the envelope, or the REVOKER the
// envelope names. A revoker is a hot key with no spending power, so an
// emergency stop does not require opening the safe.
//
// --unsigned prints the transaction for the air-gapped machine to sign instead
// of broadcasting, for when the root is the only authority.
//
// What this does and does not stop is in src/policy/revocation.ts: it stops a
// compromised AGENT, which must go through the signer. It does not stop someone
// holding the session SECRET KEY, who does not need this package at all.
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { buildRevocationTransaction, revocationMemo } from "../policy/revocation.js";
import { checkAirGap } from "../policy/airgap.js";
function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg) {
    process.stderr.write(`coldstar-revoke: ${msg}\n`);
    process.exit(2);
}
const authorityPath = arg("authority") ?? fail("--authority <keyfile> is required (the root, or the envelope's revoker)");
const sessionPubkey = arg("session") ?? fail("--session <base58 pubkey> is required");
const rpcUrl = arg("rpc") ?? process.env.RPC_URL ?? "https://api.devnet.solana.com";
const unsigned = process.argv.includes("--unsigned");
try {
    new PublicKey(sessionPubkey);
}
catch {
    fail(`--session: '${sessionPubkey}' is not a valid public key`);
}
// --unsigned is the air-gapped path (the root signs offline). Broadcasting is
// not, so only warn there: a revoker key is meant to be hot.
if (unsigned && !checkAirGap().airGapped) {
    process.stderr.write("coldstar-revoke: note — building an unsigned revocation on a networked machine.\n");
}
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(authorityPath, "utf8"))));
const connection = new Connection(rpcUrl, "confirmed");
const { blockhash } = await connection.getLatestBlockhash();
const tx = buildRevocationTransaction({ authority: authority.publicKey, sessionPubkey, recentBlockhash: blockhash });
process.stderr.write(`marker: ${revocationMemo(sessionPubkey)}\nauthority: ${authority.publicKey.toBase58()}\n`);
if (unsigned) {
    process.stdout.write(Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64") + "\n");
    process.stderr.write("unsigned transaction printed; sign it on the air-gapped machine and broadcast.\n");
}
else {
    tx.sign(authority);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    const cluster = /devnet/.test(rpcUrl) ? "?cluster=devnet" : /testnet/.test(rpcUrl) ? "?cluster=testnet" : "";
    process.stdout.write(sig + "\n");
    process.stderr.write(`revoked. https://explorer.solana.com/tx/${sig}${cluster}\nSigners already running will refuse within their freshness window (default 60s).\n`);
}
//# sourceMappingURL=revoke.js.map