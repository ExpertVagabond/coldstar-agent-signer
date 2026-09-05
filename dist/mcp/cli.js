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
//   COLDSTAR_POLICY               path to the policy JSON (default ./coldstar.policy.json)
//   COLDSTAR_SESSION_KEYFILE      path to a JSON byte-array keypair (solana-keygen format)
//   COLDSTAR_SESSION_KEY          or the base58 secret key
//   COLDSTAR_ALLOW_MESSAGE_SIGNING  "1" to enable off-chain message signing (off by default)
//
// The session key is the disposable key the cold root authorised. It is NOT
// the root key; the root never lives on a networked machine.
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ColdstarWallet } from "../wallet/coldstarWallet.js";
import { createColdstarMcpServer } from "./server.js";
function fail(msg) {
    process.stderr.write(`coldstar-signer-mcp: ${msg}\n`);
    process.exit(2);
}
const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const policyPath = process.env.COLDSTAR_POLICY ?? "coldstar.policy.json";
let policy;
try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
}
catch (e) {
    fail(`cannot read policy at ${policyPath}: ${e.message}`);
}
for (const k of ["allowRecipients", "blockRecipients"]) {
    if (policy[k].some((v) => v.startsWith("<")))
        fail(`policy.${k} still has a placeholder; fill in real public keys`);
}
let session;
if (process.env.COLDSTAR_SESSION_KEYFILE) {
    session = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.COLDSTAR_SESSION_KEYFILE, "utf8"))));
}
else if (process.env.COLDSTAR_SESSION_KEY) {
    session = Keypair.fromSecretKey(bs58.decode(process.env.COLDSTAR_SESSION_KEY));
}
else {
    fail("set COLDSTAR_SESSION_KEYFILE or COLDSTAR_SESSION_KEY (the session key, never the root)");
}
const wallet = new ColdstarWallet({
    policy,
    session,
    rpcUrl,
    allowMessageSigning: process.env.COLDSTAR_ALLOW_MESSAGE_SIGNING === "1",
    onDecision: (v) => process.stderr.write(`[coldstar] ${v.decision} ${v.intent?.outSol ?? "?"} SOL — ${v.reason}\n`),
});
const server = createColdstarMcpServer({ wallet, policy, rpcUrl });
await server.connect(new StdioServerTransport());
process.stderr.write(`[coldstar] MCP signer up. session=${session.publicKey.toBase58()} rpc=${rpcUrl}\n`);
//# sourceMappingURL=cli.js.map