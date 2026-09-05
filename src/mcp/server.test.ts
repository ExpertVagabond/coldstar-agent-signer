import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type PublicKey,
} from "@solana/web3.js";
import { ColdstarWallet } from "../wallet/coldstarWallet.js";
import { createColdstarMcpServer } from "./server.js";
import type { Policy } from "../policy/schema.js";

const session = Keypair.generate();
const allowed = Keypair.generate().publicKey;
const blocked = Keypair.generate().publicKey;
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const policy: Policy = {
  version: 1,
  limits: { perTxSol: 0.1, dailySol: 0.25 },
  allowPrograms: [SystemProgram.programId.toBase58()],
  allowRecipients: [allowed.toBase58()],
  allowTokens: ["SOL"],
  blockRecipients: [blocked.toBase58()],
  escalateAboveSol: 0.1,
};

function legacyB64(to: PublicKey, sol: number): string {
  const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH }).add(
    SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
  );
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
}

function v0B64(to: PublicKey, sol: number): string {
  const msg = new TransactionMessage({
    payerKey: session.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

let client: Client;

beforeAll(async () => {
  const wallet = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1" });
  const server = createColdstarMcpServer({ wallet, policy, rpcUrl: "http://127.0.0.1:1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(b);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return r.structuredContent as Record<string, unknown>;
}

describe("Coldstar MCP server", () => {
  it("lists the five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["coldstar_sign", "coldstar_sign_and_send", "coldstar_status", "coldstar_transfer_sol", "coldstar_verdict"],
    );
  });

  it("status exposes the session address and policy, never a secret", async () => {
    const s = await call("coldstar_status");
    expect(s.session_address).toBe(session.publicKey.toBase58());
    expect((s.policy as Policy).blockRecipients).toEqual([blocked.toBase58()]);
    expect(JSON.stringify(s)).not.toContain(Buffer.from(session.secretKey).toString("base64"));
    expect(s.daily_spent_sol).toBe(0);
  });

  it("verdict returns REJECT for a blocklisted recipient without signing", async () => {
    const v = await call("coldstar_verdict", { transaction_base64: legacyB64(blocked, 0.001) });
    expect(v.decision).toBe("REJECT");
    expect(v.recipients).toEqual([blocked.toBase58()]);
  });

  it("sign: in-policy legacy tx comes back signed by the session key", async () => {
    const out = await call("coldstar_sign", { transaction_base64: legacyB64(allowed, 0.01) });
    expect(out.status).toBe("signed");
    const tx = VersionedTransaction.deserialize(Buffer.from(out.signed_transaction_base64 as string, "base64"));
    expect(tx.signatures[0]!.some((x) => x !== 0)).toBe(true);
  });

  it("sign: in-policy v0 tx is signed too", async () => {
    const out = await call("coldstar_sign", { transaction_base64: v0B64(allowed, 0.01) });
    expect(out.status).toBe("signed");
  });

  it("sign: over-threshold tx is escalated with the unsigned payload, not signed", async () => {
    const out = await call("coldstar_sign", { transaction_base64: legacyB64(allowed, 0.5) });
    expect(out.status).toBe("escalated");
    expect(out.reason).toMatch(/escalate threshold/);
    expect(out.signed_transaction_base64).toBeUndefined();
    const tx = VersionedTransaction.deserialize(Buffer.from(out.unsigned_transaction_base64 as string, "base64"));
    expect(tx.signatures[0]!.every((x) => x === 0)).toBe(true);
  });

  it("sign: blocklisted recipient is rejected and no signature exists", async () => {
    const out = await call("coldstar_sign", { transaction_base64: legacyB64(blocked, 0.001) });
    expect(out.status).toBe("rejected");
    expect(out.signed_transaction_base64).toBeUndefined();
    expect(out.unsigned_transaction_base64).toBeUndefined();
  });

  it("daily cap accumulates across MCP calls", async () => {
    await call("coldstar_sign", { transaction_base64: legacyB64(allowed, 0.1) });
    await call("coldstar_sign", { transaction_base64: legacyB64(allowed, 0.1) });
    const out = await call("coldstar_sign", { transaction_base64: legacyB64(allowed, 0.1) });
    expect(out.status).toBe("escalated");
    expect(out.reason).toMatch(/daily cap/);
    const s = await call("coldstar_status");
    expect(s.daily_spent_sol).toBeCloseTo(0.22, 6); // 0.01 legacy + 0.01 v0 + 0.1 + 0.1 from the signed calls above
  });

  it("sign_and_send does not broadcast escalated or rejected outcomes", async () => {
    // rpcUrl is unroutable; if this tried to send, it would throw a connection error.
    const out = await call("coldstar_sign_and_send", { transaction_base64: legacyB64(blocked, 0.001) });
    expect(out.status).toBe("rejected");
    expect(out.signature).toBeUndefined();
  });

  it("sign_and_send returns send_failed (not an MCP error) when the RPC cannot be reached", async () => {
    const out = await call("coldstar_sign_and_send", { transaction_base64: legacyB64(allowed, 0.005) });
    expect(out.status).toBe("send_failed");
    expect(out.decision).toBe("AUTO_SIGN");
    expect(out.reason).toMatch(/broadcast failed/);
    expect(out.signature).toBeUndefined();
  });
});
