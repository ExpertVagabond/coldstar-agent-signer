import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { FileSpendLedger } from "./ledger.js";
import { ColdstarWallet } from "./coldstarWallet.js";
import type { Policy } from "../policy/schema.js";

const dir = () => mkdtempSync(join(tmpdir(), "cs-ledger-"));

describe("FileSpendLedger", () => {
  it("starts at 0 with no file, and only creates the file on first write", () => {
    const p = join(dir(), "ledger.json");
    const l = new FileSpendLedger(p);
    expect(l.get().dailySpentSol).toBe(0);
    expect(existsSync(p)).toBe(false);
    l.add(0.1);
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toMatchObject({ version: 1, spentSol: 0.1 });
  });

  it("survives a process restart: a new instance reads the previous spend", () => {
    const p = join(dir(), "ledger.json");
    new FileSpendLedger(p).add(0.12);
    const again = new FileSpendLedger(p);
    expect(again.get().dailySpentSol).toBeCloseTo(0.12, 9);
    again.add(0.03);
    expect(new FileSpendLedger(p).get().dailySpentSol).toBeCloseTo(0.15, 9);
  });

  it("rolls over at the UTC day boundary and persists the reset", () => {
    const p = join(dir(), "ledger.json");
    let now = new Date("2026-09-05T23:59:00Z");
    const l = new FileSpendLedger(p, () => now);
    l.add(0.2);
    now = new Date("2026-09-06T00:00:30Z");
    expect(l.get().dailySpentSol).toBe(0);
    expect(JSON.parse(readFileSync(p, "utf8"))).toMatchObject({ day: "2026-09-06", spentSol: 0 });
  });

  it("refuses to start from a corrupt file instead of silently resetting the cap", () => {
    const p = join(dir(), "ledger.json");
    writeFileSync(p, "{ not json");
    expect(() => new FileSpendLedger(p)).toThrow(/not valid JSON/);
    writeFileSync(p, JSON.stringify({ version: 1, day: "2026-09-05", spentSol: -1 }));
    expect(() => new FileSpendLedger(p)).toThrow(/unexpected shape/);
  });

  it("refuses to record nonsense amounts", () => {
    const l = new FileSpendLedger(join(dir(), "ledger.json"));
    expect(() => l.add(-0.1)).toThrow();
    expect(() => l.add(Number.NaN)).toThrow();
  });

  it("writes the file with owner-only permissions", () => {
    const p = join(dir(), "ledger.json");
    new FileSpendLedger(p).add(0.01);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("the daily cap holds across wallet restarts", async () => {
    const p = join(dir(), "ledger.json");
    const session = Keypair.generate();
    const allowed = Keypair.generate().publicKey;
    const policy: Policy = {
      version: 1, limits: { perTxSol: 0.1, dailySol: 0.25 },
      allowPrograms: [SystemProgram.programId.toBase58()], allowRecipients: [allowed.toBase58()],
      allowTokens: ["SOL"], blockRecipients: [], escalateAboveSol: 0.1,
    };
    const tx = () => new Transaction({ feePayer: session.publicKey, recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" })
      .add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: allowed, lamports: 0.1 * LAMPORTS_PER_SOL }));

    const w1 = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", ledger: new FileSpendLedger(p) });
    await w1.signTransaction(tx());
    await w1.signTransaction(tx());
    // "restart": a brand-new wallet and ledger instance over the same file
    const w2 = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", ledger: new FileSpendLedger(p) });
    await expect(w2.signTransaction(tx())).rejects.toMatchObject({ decision: "ESCALATE", reason: expect.stringContaining("daily cap") });
  });
});
