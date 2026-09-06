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
// Nothing here touches a network. The root secret never leaves this process.
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { signPolicyEnvelope, parsePolicy } from "../policy/envelope.js";
import { checkAirGap, describeAirGap } from "../policy/airgap.js";
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
const root = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(rootPath, "utf8"))));
const policy = parsePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
for (const k of ["allowRecipients", "blockRecipients"]) {
    if (policy[k].some((v) => v.startsWith("<") || v.startsWith("$")))
        fail(`policy.${k} still has a placeholder`);
}
const envelope = signPolicyEnvelope({ rootSecretKey: root.secretKey, policy, sessionPubkey, expiresAt, ...(revoker ? { revoker } : {}) });
process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
process.stderr.write(`signed by root ${envelope.rootPubkey} for session ${sessionPubkey}` +
    (expiresAt ? `, expires ${envelope.expiresAt}` : ", no expiry (consider --expires)") +
    (revoker ? `, revocable by ${revoker}` : "") + "\n");
process.stderr.write(`air gap: ${describeAirGap(gap)}\n`);
//# sourceMappingURL=signPolicy.js.map