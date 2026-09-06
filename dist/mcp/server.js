// Coldstar Agent-Safe Signing — MCP server.
//
// Exposes a ColdstarWallet to any MCP client (Claude Desktop/Code, Cursor,
// custom agents) as a handful of tools. The model never receives a key; it
// hands over an unsigned transaction and gets back one of three outcomes:
//
//   signed     -> the session key signed it (AUTO_SIGN)
//   escalated  -> policy says a human must approve; the unsigned tx is returned
//                 so the caller can route it to the air-gapped device (QR)
//   rejected   -> policy says no; no signature exists (REJECT)
//
// Outcomes are returned as structured content, not thrown, so an agent can
// read the reason and stop, rather than retry blindly.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, } from "@solana/web3.js";
import { z } from "zod";
import { ColdstarEscalation, ColdstarRejected } from "../wallet/coldstarWallet.js";
const b64 = {
    decode(s) {
        return Uint8Array.from(Buffer.from(s, "base64"));
    },
    encode(b) {
        return Buffer.from(b).toString("base64");
    },
};
function deserialize(base64Tx) {
    // VersionedTransaction.deserialize understands legacy messages too, so one
    // code path covers both wire formats.
    return VersionedTransaction.deserialize(b64.decode(base64Tx));
}
const Outcome = {
    decision: z.enum(["AUTO_SIGN", "ESCALATE", "REJECT"]),
    status: z.enum(["signed", "escalated", "rejected", "send_failed"]),
    reason: z.string(),
    signed_transaction_base64: z.string().optional(),
    unsigned_transaction_base64: z.string().optional(),
    signature: z.string().optional(),
    explorer_url: z.string().optional(),
};
/**
 * Broadcast a signed transaction. RPC failures (unfunded wallet, expired
 * blockhash, node down) come back as a `send_failed` outcome rather than a
 * thrown MCP error, so the model sees what happened and does not retry blindly.
 * The signature was produced under policy either way; the ledger has counted it.
 */
async function broadcast(rpcUrl, cluster, out) {
    try {
        const connection = new Connection(rpcUrl, "confirmed");
        const signature = await connection.sendRawTransaction(b64.decode(out.signed_transaction_base64));
        return { ...out, signature, explorer_url: `https://explorer.solana.com/tx/${signature}${cluster}` };
    }
    catch (e) {
        const msg = e.message ?? String(e);
        return { ...out, status: "send_failed", reason: `signed under policy, but broadcast failed: ${msg.split("\n")[0]}` };
    }
}
function text(o) {
    return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }], structuredContent: o };
}
export function createColdstarMcpServer(opts) {
    const { wallet, policy, rpcUrl } = opts;
    const server = new McpServer({ name: opts.name ?? "coldstar-signer", version: opts.version ?? "0.1.0" });
    const cluster = /devnet/.test(rpcUrl) ? "?cluster=devnet" : /testnet/.test(rpcUrl) ? "?cluster=testnet" : "";
    async function signOrExplain(tx) {
        try {
            const signed = await wallet.signTransaction(tx);
            return {
                decision: "AUTO_SIGN",
                status: "signed",
                reason: "within policy",
                signed_transaction_base64: b64.encode(signed.serialize()),
            };
        }
        catch (e) {
            if (e instanceof ColdstarRejected) {
                return { decision: "REJECT", status: "rejected", reason: e.reason };
            }
            if (e instanceof ColdstarEscalation) {
                return {
                    decision: "ESCALATE",
                    status: "escalated",
                    reason: e.reason,
                    unsigned_transaction_base64: e.unsignedTxBase64,
                };
            }
            throw e;
        }
    }
    server.registerTool("coldstar_status", {
        title: "Coldstar wallet status",
        description: "The agent's session wallet address, the policy it is bound by, and how much of today's daily cap is used. The root key is never available here.",
        inputSchema: {},
        outputSchema: {
            session_address: z.string(),
            rpc_url: z.string(),
            policy: z.object({
                version: z.number(),
                limits: z.object({ perTxSol: z.number(), dailySol: z.number() }),
                allowPrograms: z.array(z.string()),
                allowRecipients: z.array(z.string()),
                allowTokens: z.array(z.string()),
                tokenLimits: z.record(z.string(), z.object({ perTx: z.string().optional(), daily: z.string().optional() })).optional(),
                allowTokenAccounts: z.array(z.string()).optional(),
                blockRecipients: z.array(z.string()),
                escalateAboveSol: z.number(),
            }),
            daily_spent_sol: z.number(),
        },
    }, async () => text({
        session_address: wallet.publicKey.toBase58(),
        rpc_url: rpcUrl,
        policy,
        daily_spent_sol: wallet.dailySpentSol(),
    }));
    server.registerTool("coldstar_verdict", {
        title: "Check a transaction against policy (no signing)",
        description: "Evaluate a base64-encoded Solana transaction against the wallet policy and return AUTO_SIGN, ESCALATE, or REJECT with the reason. Nothing is signed. Use this to pre-flight a plan.",
        inputSchema: { transaction_base64: z.string().describe("Unsigned transaction, base64 (legacy or v0)") },
        outputSchema: {
            decision: z.enum(["AUTO_SIGN", "ESCALATE", "REJECT"]),
            reason: z.string(),
            out_sol: z.number().optional(),
            recipients: z.array(z.string()).optional(),
        },
    }, async ({ transaction_base64 }) => {
        const v = await wallet.evaluateTx(deserialize(transaction_base64));
        return text({ decision: v.decision, reason: v.reason, out_sol: v.intent?.outSol, recipients: v.intent?.recipients });
    });
    server.registerTool("coldstar_sign", {
        title: "Sign a transaction under policy",
        description: "Sign a base64 Solana transaction with the session key if policy allows. Returns status 'signed' with the signed transaction, 'escalated' with the unsigned transaction for a human to approve on the air-gapped device, or 'rejected' with no signature. Does not broadcast.",
        inputSchema: { transaction_base64: z.string().describe("Unsigned transaction, base64 (legacy or v0)") },
        outputSchema: Outcome,
    }, async ({ transaction_base64 }) => text(await signOrExplain(deserialize(transaction_base64))));
    server.registerTool("coldstar_sign_and_send", {
        title: "Sign under policy and broadcast",
        description: "Like coldstar_sign, then broadcasts a signed transaction to the configured RPC and returns the signature. Escalated and rejected outcomes are returned, not broadcast. A broadcast failure returns status send_failed with the RPC reason.",
        inputSchema: { transaction_base64: z.string().describe("Unsigned transaction, base64 (legacy or v0)") },
        outputSchema: Outcome,
    }, async ({ transaction_base64 }) => {
        const out = await signOrExplain(deserialize(transaction_base64));
        if (out.status !== "signed")
            return text(out);
        return text(await broadcast(rpcUrl, cluster, out));
    });
    server.registerTool("coldstar_transfer_sol", {
        title: "Transfer SOL under policy",
        description: "Build a SOL transfer from the session wallet, evaluate it against policy, and broadcast if allowed. Amounts over the escalate threshold or to non-allowlisted recipients are escalated; blocklisted recipients are rejected with no signature.",
        inputSchema: {
            to: z.string().describe("Recipient public key, base58"),
            sol: z.number().positive().describe("Amount in SOL"),
            dry_run: z.boolean().optional().describe("If true, return the verdict without signing or sending"),
        },
        outputSchema: { ...Outcome, decision: z.enum(["AUTO_SIGN", "ESCALATE", "REJECT"]) },
    }, async ({ to, sol, dry_run }) => {
        const connection = new Connection(rpcUrl, "confirmed");
        const { blockhash } = await connection.getLatestBlockhash();
        const msg = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: new PublicKey(to),
                    lamports: Math.round(sol * LAMPORTS_PER_SOL),
                }),
            ],
        }).compileToLegacyMessage();
        const tx = new VersionedTransaction(msg);
        if (dry_run) {
            const v = await wallet.evaluateTx(tx);
            const status = v.decision === "AUTO_SIGN" ? "signed" : v.decision === "ESCALATE" ? "escalated" : "rejected";
            return text({ decision: v.decision, status, reason: `dry run: ${v.reason}` });
        }
        const out = await signOrExplain(tx);
        if (out.status !== "signed")
            return text(out);
        return text(await broadcast(rpcUrl, cluster, out));
    });
    return server;
}
//# sourceMappingURL=server.js.map