import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  createTransferInstruction,
  createApproveInstruction,
  createApproveCheckedInstruction,
  createSetAuthorityInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  AuthorityType,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ColdstarWallet, InMemorySpendLedger, type SpendLedger } from "../wallet/coldstarWallet.js";
import { FileSpendLedger } from "../wallet/ledger.js";
import { associatedTokenAddress, expandTokenAccounts } from "../wallet/tokens.js";
import { parseTx } from "../adapter/parseTx.js";
import { projectTransaction } from "../wallet/project.js";
import type { Policy } from "./schema.js";

const session = Keypair.generate();
const allowed = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // devnet USDC
const OTHER_MINT = Keypair.generate().publicKey;
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const SIX = 6; // USDC decimals
const usdc = (n: number) => BigInt(Math.round(n * 10 ** SIX));

const ourAta = getAssociatedTokenAddressSync(USDC, session.publicKey, true);
const allowedAta = getAssociatedTokenAddressSync(USDC, allowed, true);
const strangerAta = getAssociatedTokenAddressSync(USDC, stranger, true);

/** The policy people actually write when they want an agent to pay in USDC. */
function policy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    limits: { perTxSol: 0.1, dailySol: 0.25 },
    allowPrograms: [SystemProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58()],
    allowRecipients: [allowed.toBase58()],
    allowTokens: ["SOL", USDC.toBase58()],
    tokenLimits: { [USDC.toBase58()]: { perTx: usdc(25).toString(), daily: usdc(50).toString() } },
    blockRecipients: [],
    escalateAboveSol: 0.1,
    ...over,
  };
}

function tx(...ixs: Parameters<Transaction["add"]>): Transaction {
  return new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH }).add(...ixs);
}
const transferChecked = (dest: PublicKey, amount: bigint, authority = session.publicKey) =>
  createTransferCheckedInstruction(ourAta, USDC, dest, authority, amount, SIX);

function wallet(p: Policy = policy(), ledger: SpendLedger = new InMemorySpendLedger()) {
  return new ColdstarWallet({ policy: p, session, rpcUrl: "http://127.0.0.1:1", ledger });
}
const verdict = (w: ColdstarWallet, t: Transaction) => w.evaluateTx(t);

describe("associated token account derivation matches @solana/spl-token", () => {
  it("agrees with getAssociatedTokenAddressSync for several owners and mints", () => {
    for (const owner of [session.publicKey, allowed, stranger]) {
      for (const mint of [USDC, OTHER_MINT]) {
        expect(associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID).toBase58()).toBe(
          getAssociatedTokenAddressSync(mint, owner, true).toBase58(),
        );
      }
    }
  });

  it("expandTokenAccounts adds the recipients' token accounts and does not mutate the input", () => {
    const p = policy();
    const before = JSON.stringify(p);
    const expanded = expandTokenAccounts(p);
    expect(expanded.allowTokenAccounts).toContain(allowedAta.toBase58());
    expect(expanded.allowTokenAccounts).not.toContain(strangerAta.toBase58());
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("THE HOLE: a policy that says SOL must not permit unlimited USDC", () => {
  it("moving USDC under allowTokens:['SOL'] escalates instead of auto-signing", async () => {
    const w = wallet(policy({ allowTokens: ["SOL"], tokenLimits: {} }));
    const v = await verdict(w, tx(transferChecked(allowedAta, usdc(1_000_000))));
    expect(v.decision).not.toBe("AUTO_SIGN");
    expect(v.reason).toMatch(/not in allowTokens/);
  });

  it("a huge USDC transfer is not disguised by a zero SOL amount", async () => {
    const w = wallet();
    const v = await verdict(w, tx(transferChecked(allowedAta, usdc(1_000_000))));
    expect(v.intent?.outSol).toBe(0); // exactly what used to make this pass
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/per-transaction limit/);
  });
});

describe("instructions that cannot be bounded are refused", () => {
  const cases: Array<[string, () => Parameters<Transaction["add"]>[0]]> = [
    ["Approve", () => createApproveInstruction(ourAta, stranger, session.publicKey, usdc(1))],
    ["ApproveChecked", () => createApproveCheckedInstruction(ourAta, USDC, stranger, session.publicKey, usdc(1), SIX)],
    ["SetAuthority", () => createSetAuthorityInstruction(ourAta, session.publicKey, AuthorityType.AccountOwner, stranger)],
    ["Burn", () => createBurnInstruction(ourAta, USDC, session.publicKey, usdc(1))],
    ["CloseAccount", () => createCloseAccountInstruction(ourAta, stranger, session.publicKey)],
  ];
  for (const [name, build] of cases) {
    it(`${name} escalates rather than signing`, async () => {
      const v = await verdict(wallet(), tx(build()));
      expect(v.decision).toBe("ESCALATE");
    });
  }

  it("Approve is the important one: a delegate could drain later with no further signing", async () => {
    const w = wallet();
    const t = tx(createApproveInstruction(ourAta, stranger, session.publicKey, usdc(1_000_000_000)));
    const v = await verdict(w, t);
    expect(v.reason).toMatch(/delegates open-ended spending authority/);
    await expect(w.signTransaction(t)).rejects.toMatchObject({ decision: "ESCALATE" });
    expect(t.signatures.every((s) => s.signature === null)).toBe(true);
  });

  it("Revoke is allowed: it only removes authority", async () => {
    const v = await verdict(wallet(), tx(createRevokeInstruction(ourAta, session.publicKey)));
    expect(v.decision).toBe("AUTO_SIGN");
  });
});

describe("bare Transfer cannot be attributed to a mint", () => {
  it("escalates, because its accounts do not include the mint", async () => {
    const v = await verdict(wallet(), tx(createTransferInstruction(ourAta, allowedAta, session.publicKey, usdc(1))));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/does not name a mint/);
  });

  it("the same payment as TransferChecked is fine", async () => {
    const v = await verdict(wallet(), tx(transferChecked(allowedAta, usdc(1))));
    expect(v.decision).toBe("AUTO_SIGN");
  });
});

describe("token limits and allowlists", () => {
  it("an in-policy USDC payment to an allowlisted recipient auto-signs", async () => {
    const w = wallet();
    const out = await w.signTransaction(tx(transferChecked(allowedAta, usdc(10))));
    expect(out.verifySignatures()).toBe(true);
  });

  it("over the per-transaction limit escalates", async () => {
    const v = await verdict(wallet(), tx(transferChecked(allowedAta, usdc(26))));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/per-transaction limit/);
  });

  it("two movements in one transaction accumulate against the per-transaction limit", async () => {
    const v = await verdict(wallet(), tx(transferChecked(allowedAta, usdc(20)), transferChecked(allowedAta, usdc(20))));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/per-transaction limit/);
  });

  it("a mint outside allowTokens escalates even when the Token program is allowed", async () => {
    const otherAta = getAssociatedTokenAddressSync(OTHER_MINT, allowed, true);
    const ix = createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(OTHER_MINT, session.publicKey, true), OTHER_MINT, otherAta, session.publicKey, 1n, 0,
    );
    const v = await verdict(wallet(), tx(ix));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/not in allowTokens/);
  });

  it("a destination that is not an allowlisted recipient's token account escalates", async () => {
    const v = await verdict(wallet(), tx(transferChecked(strangerAta, usdc(1))));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/not an allowed token account/);
  });

  it("tokens moving under someone else's authority are not our exposure", async () => {
    const theirs = Keypair.generate();
    const ix = createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(USDC, theirs.publicKey, true), USDC, strangerAta, theirs.publicKey, usdc(999), SIX,
    );
    const v = await verdict(wallet(), tx(ix));
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.tokenMovements).toHaveLength(0);
  });

  it("SOL is an asset too: a USDC-only policy does not move SOL", async () => {
    const w = wallet(policy({ allowTokens: [USDC.toBase58()] }));
    const t = tx(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: allowed, lamports: 0.01 * LAMPORTS_PER_SOL }));
    const v = await verdict(w, t);
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/allowTokens does not include SOL/);
  });
});

describe("the per-mint daily cap", () => {
  it("accumulates across transactions and escalates at the cap", async () => {
    const w = wallet();
    await w.signTransaction(tx(transferChecked(allowedAta, usdc(25))));
    await w.signTransaction(tx(transferChecked(allowedAta, usdc(25))));
    const v = await verdict(w, tx(transferChecked(allowedAta, usdc(1))));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/daily cap/);
  });

  it("survives a restart through the file ledger", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cs-tok-")), "l.json");
    const w1 = wallet(policy(), new FileSpendLedger(path));
    await w1.signTransaction(tx(transferChecked(allowedAta, usdc(25))));
    await w1.signTransaction(tx(transferChecked(allowedAta, usdc(25))));
    const w2 = wallet(policy(), new FileSpendLedger(path)); // "restart"
    const v = await verdict(w2, tx(transferChecked(allowedAta, usdc(1))));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/daily cap/);
  });

  it("one mint's cap does not bound another", async () => {
    const p = policy({
      allowTokens: ["SOL", USDC.toBase58(), OTHER_MINT.toBase58()],
      tokenLimits: { [USDC.toBase58()]: { perTx: usdc(25).toString(), daily: usdc(25).toString() } },
    });
    const w = wallet(p);
    await w.signTransaction(tx(transferChecked(allowedAta, usdc(25))));
    // USDC is now capped out, but a different mint with no limit is unaffected
    const other = createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(OTHER_MINT, session.publicKey, true), OTHER_MINT,
      getAssociatedTokenAddressSync(OTHER_MINT, allowed, true), session.publicKey, 5n, 0,
    );
    expect((await verdict(w, tx(other))).decision).toBe("AUTO_SIGN");
    expect((await verdict(w, tx(transferChecked(allowedAta, usdc(1))))).decision).toBe("ESCALATE");
  });

  it("a malformed limit escalates rather than being read as unlimited", async () => {
    const w = wallet(policy({ tokenLimits: { [USDC.toBase58()]: { perTx: "25.5" } } }));
    const v = await verdict(w, tx(transferChecked(allowedAta, usdc(1))));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/not a whole number of base units/);
  });
});

describe("the decoder reads what @solana/spl-token emits", () => {
  it("extracts amount, mint, decimals and destination from a real TransferChecked", () => {
    const t = tx(transferChecked(allowedAta, usdc(12.5)));
    const p = projectTransaction(t);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = parseTx(p.message);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [m] = r.intent.tokenMovements;
    expect(m?.amount).toBe(usdc(12.5));
    expect(m?.mint).toBe(USDC.toBase58());
    expect(m?.decimals).toBe(SIX);
    expect(m?.destination).toBe(allowedAta.toBase58());
    expect(r.intent.outSol).toBe(0);
  });
});
