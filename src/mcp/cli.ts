#!/usr/bin/env node
// `coldstar-signer-mcp` — run the Coldstar policy signer as an MCP server over stdio.
//
// Configuration is by environment, so it drops into any MCP client config:
//
//   {
//     "mcpServers": {
//       "coldstar": {
//         "command": "npx",
//         "args": ["-y", "github:ExpertVagabond/coldstar-agent-signer"],
//         "env": {
//           "RPC_URL": "https://api.devnet.solana.com",
//           "COLDSTAR_POLICY": "/path/to/coldstar.policy.json",
//           "COLDSTAR_SESSION_KEYFILE": "/path/to/session.json"
//         }
//       }
//     }
//   }
//
//   RPC_URL                       default https://api.devnet.solana.com
//   COLDSTAR_POLICY               path to the policy JSON, or a root-signed ENVELOPE from
//                                 coldstar-sign-policy (default ./coldstar.policy.json)
//   COLDSTAR_ROOT_PUBKEY          pin the root that must have signed the envelope (base58)
//   COLDSTAR_REQUIRE_ENVELOPE     "1" to refuse a bare, unsigned policy
//   COLDSTAR_SESSION_KEYFILE      path to a JSON byte-array keypair (solana-keygen format)
//   COLDSTAR_SESSION_KEY          or the base58 secret key
//   COLDSTAR_ALLOW_MESSAGE_SIGNING  "1" to enable off-chain message signing (off by default)
//   COLDSTAR_LEDGER               path of the persistent daily-spend ledger (default ./.coldstar-ledger.json)
//   COLDSTAR_SIMULATE             "1" to simulate txs through allowlisted non-System programs and
//                                 apply the measured debit to the limits; "always" to simulate every tx
//
// The session key is the disposable key the cold root authorised. It is NOT
// the root key; the root never lives on a networked machine.

import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ColdstarWallet } from "../wallet/coldstarWallet.js";
import { rpcSimulator } from "../wallet/simulate.js";
import { FileSpendLedger } from "../wallet/ledger.js";
import type { Policy } from "../policy/schema.js";
import { isEnvelope, parsePolicy } from "../policy/envelope.js";
import { createColdstarMcpServer } from "./server.js";

function fail(msg: string): never {
  process.stderr.write(`coldstar-signer-mcp: ${msg}\n`);
  process.exit(2);
}

const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const policyPath = process.env.COLDSTAR_POLICY ?? "coldstar.policy.json";

let policyRaw: unknown;
try {
  policyRaw = JSON.parse(readFileSync(policyPath, "utf8"));
} catch (e) {
  fail(`cannot read policy at ${policyPath}: ${(e as Error).message}`);
}
const envelopeMode = isEnvelope(policyRaw);
const expectedRoot = process.env.COLDSTAR_ROOT_PUBKEY;
if (!envelopeMode && process.env.COLDSTAR_REQUIRE_ENVELOPE === "1") {
  fail(`${policyPath} is a bare policy but COLDSTAR_REQUIRE_ENVELOPE=1; sign it on the cold machine with coldstar-sign-policy`);
}
let policy: Policy;
try {
  policy = envelopeMode ? (policyRaw as { policy: Policy }).policy : parsePolicy(policyRaw);
} catch (e) {
  fail((e as Error).message);
}
for (const k of ["allowRecipients", "blockRecipients"] as const) {
  if (policy[k].some((v) => v.startsWith("<") || v.startsWith("$"))) fail(`policy.${k} still has a placeholder; fill in real public keys`);
}

let session: Keypair;
if (process.env.COLDSTAR_SESSION_KEYFILE) {
  session = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.COLDSTAR_SESSION_KEYFILE, "utf8")) as number[]),
  );
} else if (process.env.COLDSTAR_SESSION_KEY) {
  session = Keypair.fromSecretKey(bs58.decode(process.env.COLDSTAR_SESSION_KEY));
} else {
  fail("set COLDSTAR_SESSION_KEYFILE or COLDSTAR_SESSION_KEY (the session key, never the root)");
}

// The daily cap must survive restarts, so the MCP binary always uses a file ledger.
const ledgerPath = process.env.COLDSTAR_LEDGER ?? ".coldstar-ledger.json";
const walletOpts = {
  session,
  rpcUrl,
  ledger: new FileSpendLedger(ledgerPath),
  allowMessageSigning: process.env.COLDSTAR_ALLOW_MESSAGE_SIGNING === "1",
  // COLDSTAR_SIMULATE=1 turns on simulation-based accounting for transactions
  // that touch allowlisted non-System programs (posture (b)); "always" simulates everything.
  ...(process.env.COLDSTAR_SIMULATE
    ? { preflight: { simulate: rpcSimulator(rpcUrl), when: process.env.COLDSTAR_SIMULATE === "always" ? "always" as const : "opaque" as const } }
    : {}),
  onDecision: (v: { decision: string; intent?: { outSol: number } | undefined; reason: string }) =>
    process.stderr.write(`[coldstar] ${v.decision} ${v.intent?.outSol ?? "?"} SOL — ${v.reason}\n`),
};

let wallet: ColdstarWallet;
try {
  wallet = envelopeMode
    ? ColdstarWallet.fromEnvelope({ ...walletOpts, envelope: policyRaw, ...(expectedRoot ? { expectedRoot } : {}) })
    : new ColdstarWallet({ ...walletOpts, policy });
} catch (e) {
  fail((e as Error).message);
}
if (envelopeMode && !expectedRoot) {
  process.stderr.write("[coldstar] WARNING: envelope accepted without COLDSTAR_ROOT_PUBKEY pinned; any key could have signed it\n");
}

const server = createColdstarMcpServer({ wallet, policy, rpcUrl });
await server.connect(new StdioServerTransport());
process.stderr.write(`[coldstar] MCP signer up. session=${session.publicKey.toBase58()} rpc=${rpcUrl}` + (wallet.envelope ? ` policy signed by root ${wallet.envelope.rootPubkey}` + (wallet.envelope.expiresAt ? ` until ${wallet.envelope.expiresAt}` : "") : " policy UNSIGNED (devnet only)") + `\n`);
