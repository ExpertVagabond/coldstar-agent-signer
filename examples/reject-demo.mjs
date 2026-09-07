// The 45-second version of the argument.
//
// An agent is handed a session key and a policy. It makes three payment attempts:
// one ordinary, one that a prompt injection redirected to an attacker, and one
// that is simply too large. The signer decides each one.
//
// Everything here runs against the real policy engine, the real decoder, and a
// real Ed25519 session key. No network: the signatures below are produced and
// verified locally, so the demo cannot fail for reasons that have nothing to do
// with the point it is making.
//
//   node examples/reject-demo.mjs

import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ColdstarWallet, ColdstarRejected, ColdstarEscalation } from "../dist/index.js";

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

// The session key. It can spend, but only inside the policy. The root key that
// signed the policy is on a machine with no network interface and is not here.
const session = Keypair.generate();
const payroll = Keypair.generate().publicKey;   // an address the root approved
const attacker = Keypair.generate().publicKey;  // an address the root blocklisted

const policy = {
  version: 1,
  limits: { perTxSol: 0.1, dailySol: 0.5 },
  allowPrograms: ["11111111111111111111111111111111"],
  allowRecipients: [payroll.toBase58()],
  blockRecipients: [attacker.toBase58()],
  allowTokens: ["SOL"],
  escalateAboveSol: 0.1,
};

const wallet = new ColdstarWallet({
  policy,
  session,
  rpcUrl: "https://api.devnet.solana.com", // never called in this demo
});

function transfer(to, sol) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: session.publicKey,
      toPubkey: to,
      lamports: Math.round(sol * LAMPORTS_PER_SOL),
    }),
  );
  tx.feePayer = session.publicKey;
  tx.recentBlockhash = new PublicKey(Keypair.generate().publicKey).toBase58();
  return tx;
}

async function attempt(label, to, sol, note) {
  console.log("");
  console.log(c.bold(label));
  console.log(c.dim(`   ${sol} SOL  →  ${to.toBase58().slice(0, 20)}…`));
  if (note) console.log(c.dim(`   ${note}`));
  await sleep(PACE);

  try {
    const signed = await wallet.signTransaction(transfer(to, sol));
    const sig = signed.signatures.find((s) => s.publicKey.equals(session.publicKey))?.signature;
    console.log(c.green(`   AUTO_SIGN`) + c.dim(`   signature ${sig.toString("base64").slice(0, 32)}…`));
  } catch (e) {
    if (e instanceof ColdstarRejected) {
      console.log(c.red(`   REJECT`) + c.dim(`      ${e.reason}`));
      console.log(c.red(`   no signature was produced`));
    } else if (e instanceof ColdstarEscalation) {
      console.log(c.yellow(`   ESCALATE`) + c.dim(`    ${e.reason}`));
      console.log(c.dim(`   unsigned transaction handed to the air-gapped device`));
    } else {
      throw e;
    }
  }
  await sleep(PACE);
}

console.log("");
console.log(c.cyan("  coldstar-agent-signer") + c.dim("  — the agent holds a session key, never the root key"));
console.log("");
console.log(c.dim(`  session    ${session.publicKey.toBase58()}`));
console.log(c.dim(`  per tx     ${policy.limits.perTxSol} SOL      daily  ${policy.limits.dailySol} SOL`));
console.log(c.dim(`  allowed    ${payroll.toBase58().slice(0, 20)}…`));
console.log(c.dim(`  blocked    ${attacker.toBase58().slice(0, 20)}…`));
await sleep(PACE);

await attempt("1. The ordinary payment the agent was built to make", payroll, 0.05);
await attempt(
  "2. A prompt injection redirects the payment",
  attacker,
  0.05,
  "the agent is fully compromised and asks in good faith",
);
await attempt("3. The agent tries to move everything at once", payroll, 5);

console.log("");
console.log(c.dim("  The compromised agent asked correctly and was refused anyway."));
console.log(c.dim("  The signature does not exist to be leaked, revoked, or clawed back."));
console.log("");
