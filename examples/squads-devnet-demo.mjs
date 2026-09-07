#!/usr/bin/env node
// A real Squads vault on devnet, with an agent bounded twice.
//
//   node examples/squads-devnet-demo.mjs --funder ~/path/to/funded.json
//
// Sets up, on chain:
//   * a Squads v4 multisig, controlled by the funder
//   * a vault holding SOL
//   * a spending limit naming the agent's SESSION key as its only member,
//     with one allowed destination
//
// Then shows the two bounds that make this pairing worth having:
//   1. an in-policy spend signs locally and lands on chain
//   2. a spend Coldstar's policy dislikes never reaches the chain at all
//   3. the agent trying to raise its own ceiling is refused before signing
//
// State is written to .squads-demo.json so re-runs reuse the multisig instead
// of paying to create another.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { ColdstarWallet, InMemorySpendLedger, SQUADS_PROGRAM_ID, parsePolicy } from "../dist/index.js";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
if (!/devnet/.test(RPC)) throw new Error("This demo is devnet-only.");
const connection = new Connection(RPC, "confirmed");
const STATE = ".squads-demo.json";
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace(/^~/, process.env.HOME), "utf8"))));
const sol = (n) => Math.round(n * LAMPORTS_PER_SOL);
const explorer = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

const funder = load(arg("funder") ?? (() => { throw new Error("--funder <keyfile> is required (a devnet wallet with ~0.1 SOL)"); })());
console.log(`funder            ${funder.publicKey.toBase58()}`);
console.log(`balance           ${(await connection.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL} SOL\n`);

// ---------------------------------------------------------------- setup

let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
if (state && !state.spendingLimit) state = null; // resume a half-finished setup
const session = state ? Keypair.fromSecretKey(Uint8Array.from(state.session)) : Keypair.generate();
const payee = state ? new PublicKey(state.payee) : Keypair.generate().publicKey;

if (!state) {
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const { treasury } = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);

  console.log("creating the multisig…");
  const sig1 = await multisig.rpc.multisigCreateV2({
    connection, createKey, creator: funder, multisigPda, treasury,
    configAuthority: funder.publicKey,      // controlled: the funder can set limits directly
    threshold: 1,
    members: [{ key: funder.publicKey, permissions: multisig.types.Permissions.all() }],
    timeLock: 0, rentCollector: funder.publicKey,
    sendOptions: { skipPreflight: false },
  });
  await connection.confirmTransaction(sig1, "confirmed");

  // Persist immediately: a failure after this point must not strand a paid-for multisig.
  state = { multisigPda: multisigPda.toBase58(), session: Array.from(session.secretKey), payee: payee.toBase58() };
  writeFileSync(STATE, JSON.stringify(state, null, 2));

  const limitKey = Keypair.generate();
  const [spendingLimit] = multisig.getSpendingLimitPda({ multisigPda, createKey: limitKey.publicKey });
  console.log("adding a spending limit for the agent's session key…");
  const sig2 = await multisig.rpc.multisigAddSpendingLimit({
    connection, feePayer: funder, multisigPda, configAuthority: funder.publicKey, rentPayer: funder,
    spendingLimit, createKey: limitKey.publicKey, vaultIndex: 0,
    mint: SystemProgram.programId,          // Pubkey::default means SOL
    amount: sol(0.05),                      // the CHAIN's ceiling, per period
    period: multisig.types.Period.Day,
    members: [session.publicKey],           // only the agent may use it
    destinations: [payee],                  // and only to this address
    sendOptions: { skipPreflight: false },
  });
  await connection.confirmTransaction(sig2, "confirmed");

  state.spendingLimit = spendingLimit.toBase58();
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`  multisig        ${multisigPda.toBase58()}\n  spending limit  ${spendingLimit.toBase58()}\n`);
}

const multisigPda = new PublicKey(state.multisigPda);
const spendingLimit = new PublicKey(state.spendingLimit);
const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });

// Fund the vault, and the session key for fees.
const need = [[vault, 0.03], [session.publicKey, 0.01]];
const top = new Transaction();
for (const [key, want] of need) {
  const have = (await connection.getBalance(key)) / LAMPORTS_PER_SOL;
  if (have < want) top.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: key, lamports: sol(want - have) }));
}
if (top.instructions.length) {
  top.feePayer = funder.publicKey;
  top.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  await connection.confirmTransaction(await connection.sendRawTransaction((top.sign(funder), top.serialize())), "confirmed");
}
console.log(`vault             ${vault.toBase58()}`);
console.log(`vault balance     ${(await connection.getBalance(vault)) / LAMPORTS_PER_SOL} SOL`);
console.log(`agent session key ${session.publicKey.toBase58()}`);
console.log(`allowed payee     ${payee.toBase58()}\n`);

// ---------------------------------------------------------------- the agent's wallet
//
// The LOCAL policy is deliberately tighter than the chain's: the vault allows
// 0.05 SOL a day, Coldstar allows 0.01 per transaction. Two independent bounds.

const policy = parsePolicy({
  version: 1,
  limits: { perTxSol: 0.01, dailySol: 0.02 },
  allowPrograms: [SystemProgram.programId.toBase58(), SQUADS_PROGRAM_ID],
  allowRecipients: [payee.toBase58()],
  allowTokens: ["SOL"],
  blockRecipients: [],
  escalateAboveSol: 0.01,
});
const wallet = new ColdstarWallet({
  policy, session, rpcUrl: RPC, ledger: new InMemorySpendLedger(),
  onDecision: (v) => console.log(`  [policy] ${v.decision.padEnd(9)} ${v.reason}`),
});

const spend = (amountSol) => multisig.instructions.spendingLimitUse({
  multisigPda, member: session.publicKey, spendingLimit, vaultIndex: 0,
  amount: sol(amountSol), decimals: 9, destination: payee, programId: multisig.PROGRAM_ID,
});
async function asTx(ix) {
  const t = new Transaction({ feePayer: session.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash });
  return t.add(ix);
}

// ---------------------------------------------------------------- 1. in policy

console.log("── 1. the agent spends 0.005 SOL, inside both bounds");
const before = await connection.getBalance(new PublicKey(state.payee));
try {
  const signed = await wallet.signTransaction(await asTx(spend(0.005)));
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  const after = await connection.getBalance(new PublicKey(state.payee));
  console.log(`  -> landed on chain: ${explorer(sig)}`);
  console.log(`  -> payee received ${(after - before) / LAMPORTS_PER_SOL} SOL from the vault\n`);
} catch (e) {
  console.log(`  -> ${e.name}: ${e.reason ?? e.message}\n`);
}

// ---------------------------------------------------------------- 2. chain would allow, Coldstar does not

console.log("── 2. the agent asks for 0.04 SOL — the VAULT would allow it, the local policy does not");
try {
  await wallet.signTransaction(await asTx(spend(0.04)));
  console.log("  -> unexpectedly signed\n");
} catch (e) {
  console.log(`  -> ${e.name}: ${e.reason}`);
  console.log("  -> no signature exists, so this never reached the chain\n");
}

// ---------------------------------------------------------------- 3. privilege escalation

console.log("── 3. the agent tries to raise its own ceiling");
const raise = multisig.instructions.multisigAddSpendingLimit({
  multisigPda, configAuthority: session.publicKey, rentPayer: session.publicKey,
  spendingLimit: multisig.getSpendingLimitPda({ multisigPda, createKey: Keypair.generate().publicKey })[0],
  createKey: Keypair.generate().publicKey, vaultIndex: 0, mint: SystemProgram.programId,
  amount: BigInt(sol(1000)), period: multisig.types.Period.Day,
  members: [session.publicKey], destinations: [session.publicKey], programId: multisig.PROGRAM_ID,
});
try {
  await wallet.signTransaction(await asTx(raise));
  console.log("  -> unexpectedly signed\n");
} catch (e) {
  console.log(`  -> ${e.name}: ${e.reason}`);
  console.log("  -> refused before signing. The chain would also have refused it, because the");
  console.log("     session key is not the config authority — but Coldstar never let it try.\n");
}

console.log("Two independent bounds. Coldstar stops the agent locally and can wake a human;");
console.log("the vault's limit holds even if the session key is stolen outright.");
