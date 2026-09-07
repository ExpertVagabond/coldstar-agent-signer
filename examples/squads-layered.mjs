// Coldstar in front of a Squads v4 spending limit.
//
// The two mechanisms stop different attackers, which is the whole reason to run
// both:
//
//   A Squads spending limit is enforced ON-CHAIN. It bounds someone who has
//   STOLEN THE KEY, because the program does not care what software signed.
//   It is the answer to Coldstar's admitted hole.
//
//   A Coldstar policy is enforced BEFORE A SIGNATURE EXISTS. It bounds a
//   COMPROMISED AGENT that still has to ask this signer, and it can be tighter
//   than the on-chain limit without a governance vote. It is the answer to
//   signing from a hot wallet.
//
// Every instruction below is built with the real @sqds/multisig SDK, so this
// exercises the decoder against what the program actually dispatches on. No
// network: the multisig is a derived address, nothing is submitted.
//
//   node examples/squads-layered.mjs

import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import { ColdstarWallet, ColdstarRejected, ColdstarEscalation, InMemorySpendLedger, SQUADS_PROGRAM_ID } from "../dist/index.js";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.DEMO_PACE ?? 900);

const session = Keypair.generate();          // the agent's key: a Squads member
const payee = Keypair.generate().publicKey;  // an approved destination
const attacker = Keypair.generate().publicKey;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const usdc = (n) => Math.round(n * 1e6);

const createKey = Keypair.generate().publicKey;
const [multisigPda] = multisig.getMultisigPda({ createKey });
const [spendingLimitPda] = multisig.getSpendingLimitPda({ multisigPda, createKey: Keypair.generate().publicKey });

// Deliberately tighter than the vault's on-chain limit. The chain is the floor
// you cannot go under; the policy is the ceiling you choose for this agent.
const policy = {
  version: 1,
  limits: { perTxSol: 0.1, dailySol: 0.25 },
  allowPrograms: [SystemProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58(), SQUADS_PROGRAM_ID],
  allowRecipients: [payee.toBase58()],
  allowTokens: ["SOL", USDC.toBase58()],
  tokenLimits: { [USDC.toBase58()]: { perTx: String(usdc(25)), daily: String(usdc(50)) } },
  blockRecipients: [attacker.toBase58()],
  escalateAboveSol: 0.1,
};

const wallet = new ColdstarWallet({
  policy,
  session,
  rpcUrl: "http://127.0.0.1:1", // never called
  ledger: new InMemorySpendLedger(),
});

const wrap = (ix) =>
  new Transaction({ feePayer: session.publicKey, recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" }).add(ix);

const spend = (opts) =>
  multisig.instructions.spendingLimitUse({
    multisigPda,
    member: session.publicKey,
    spendingLimit: spendingLimitPda,
    vaultIndex: 0,
    programId: multisig.PROGRAM_ID,
    ...opts,
  });

// Policy reasons are full sentences and some of them are long. Wrapping them
// with a hanging indent keeps the verdict column readable instead of letting
// the terminal wrap them back to column zero.
function reason(verdict, colour, text) {
  const head = `   ${verdict}`.padEnd(15);
  const width = 74;
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  console.log(colour(head) + c.dim(lines[0] ?? ""));
  for (const l of lines.slice(1)) console.log(c.dim(" ".repeat(15) + l));
}

async function attempt(label, ix, note) {
  console.log("");
  console.log(c.bold(label));
  if (note) console.log(c.dim(`   ${note}`));
  await sleep(PACE);
  try {
    await wallet.signTransaction(wrap(ix));
    reason("AUTO_SIGN", c.green, "both layers agree; signed on the session key");
  } catch (e) {
    if (e instanceof ColdstarRejected) {
      reason("REJECT", c.red, e.reason);
      console.log(c.red("   no signature was produced"));
    } else if (e instanceof ColdstarEscalation) {
      reason("ESCALATE", c.yellow, e.reason);
      console.log(c.dim("   held for air-gapped human approval"));
    } else throw e;
  }
  await sleep(PACE);
}

console.log("");
console.log(c.cyan("  Coldstar × Squads v4") + c.dim("  — off-chain policy in front of an on-chain limit"));
console.log("");
console.log(c.dim(`  multisig        ${multisigPda.toBase58()}`));
console.log(c.dim(`  member/session  ${session.publicKey.toBase58()}`));
console.log(c.dim(`  policy caps     0.1 SOL/tx · 25 USDC/tx · destinations allowlisted`));
await sleep(PACE);

await attempt(
  "1. A routine vendor payment through the spending limit",
  spend({ amount: Math.round(0.05 * LAMPORTS_PER_SOL), decimals: 9, destination: payee }),
);

await attempt(
  "2. 30 USDC — inside the vault's on-chain limit, outside ours",
  spend({ amount: usdc(30), decimals: 6, destination: payee, mint: USDC, tokenProgram: TOKEN_PROGRAM_ID }),
  "the chain would allow this; the policy is deliberately tighter",
);

await attempt(
  "3. The agent tries to raise its own ceiling",
  multisig.instructions.multisigAddSpendingLimit({
    multisigPda,
    configAuthority: session.publicKey,
    rentPayer: session.publicKey,
    spendingLimit: spendingLimitPda,
    createKey: Keypair.generate().publicKey,
    vaultIndex: 0,
    mint: new PublicKey("11111111111111111111111111111111"),
    amount: BigInt(1_000_000_000_000),
    period: multisig.types.Period.Day,
    members: [session.publicKey],
    destinations: [attacker],
    programId: multisig.PROGRAM_ID,
  }),
  "a member CAN propose this on-chain — it is refused here by instruction name",
);

await attempt(
  "4. A payment redirected to a blocklisted address",
  spend({ amount: Math.round(0.001 * LAMPORTS_PER_SOL), decimals: 9, destination: attacker }),
  "small enough that every amount limit would have passed it",
);

console.log("");
console.log(c.dim("  Layer 1 (Coldstar, off-chain) caught: an over-policy amount, a privilege"));
console.log(c.dim("  escalation, and a blocklisted destination — before any signature existed."));
console.log(c.dim("  Layer 2 (Squads, on-chain) catches the one Coldstar cannot: an attacker"));
console.log(c.dim("  holding the stolen session key, signing with web3.js, never touching this code."));
console.log("");
