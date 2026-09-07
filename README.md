# coldstar-agent-signer

Agent-safe signing for Coldstar. Lets an AI agent transact on Solana **without ever holding the root key**: routine, in-policy transactions auto-sign on a cold-rooted session key; out-of-policy transactions escalate to **air-gapped human approval**; disallowed/injected transactions are **rejected**.

Three layers, all here and tested: a pure policy engine, a fail-closed transaction decoder, and two ways to hold the wallet — `ColdstarWallet` (a drop-in for Solana Agent Kit's `BaseWallet`) and `coldstar-signer-mcp` (an MCP server for Claude, Cursor, or any MCP client). Beta, devnet.

![A compromised agent asks for a payment to a blocklisted address and is refused](examples/out/reject-demo.gif)

That runs here: `npm run demo`. Real policy engine, real decoder, real Ed25519 session key, no network. The compromised agent asks correctly and is refused anyway, and the signature it wanted never exists.

## Why this shape

The decision logic (`src/policy/evaluate.ts`) is a **pure function** over a normalized `TxIntent` — no I/O, no `@solana/*` imports. That's deliberate: the part that must be correct is exhaustively unit-testable without a validator, a network, or a wallet. Parsing a raw transaction into `{ outSol, recipients, instructions }` is the adapter's job, where a bug is a reliability issue, not a security hole.

```
raw tx ──(project + parseTx, fail-closed)──▶ TxIntent ──(evaluate)──▶ AUTO_SIGN | ESCALATE | REJECT
                                                             │
                              AUTO_SIGN ─▶ cold-rooted session signer
                              ESCALATE  ─▶ air-gapped device (QR)
                              REJECT    ─▶ no signature
```

## What's here

| File | Status |
|------|--------|
| `src/policy/schema.ts` | ✅ types: `Policy`, `TxIntent`, `Decision`, `EvalResult` |
| `src/policy/evaluate.ts` | ✅ the pure policy engine |
| `src/policy/evaluate.test.ts` | ✅ 7 unit tests incl. the compromised-agent case |
| `coldstar.policy.json` | ✅ example policy (fill the pubkeys) |
| `src/adapter/parseTx.ts` | ✅ decoder: decompiled message → `TxIntent`, fail-closed |
| `src/adapter/parseTx.test.ts` | ✅ 17 unit tests incl. the fail-closed cases |
| `src/wallet/tokens.ts` | ✅ associated-token-account derivation, verified against `@solana/spl-token` |
| `src/policy/tokens.test.ts` | ✅ 25 tests built with the real SPL library: the USDC hole, Approve, per-mint caps |
| `src/policy/squads.test.ts` | ✅ 11 tests built with `@sqds/multisig`: spending limits read, privilege escalation refused |
| `src/policy/programs.test.ts` | ✅ 13 tests: priority fees counted as spending, token-account rent, memo |
| `src/wallet/project.ts` | ✅ web3.js `Transaction`/`VersionedTransaction` → `DecompiledMessage`; fail-closed on lookup-table accounts |
| `src/wallet/coldstarWallet.ts` | ✅ `ColdstarWallet` — drop-in for Solana Agent Kit's `BaseWallet` (structurally typed, no framework dependency) |
| `src/wallet/coldstarWallet.test.ts` | ✅ 17 tests: the three decisions, daily cap, batch atomicity, fail-closed edges |
| `src/signer/escalate.ts` | ✅ `declineEscalation`, `terminalEscalation` (paste-back with same-message verification), `acceptSignedResponse` |
| `src/mcp/server.ts` | ✅ MCP server: `coldstar_status`, `coldstar_verdict`, `coldstar_sign`, `coldstar_sign_and_send`, `coldstar_transfer_sol` |
| `src/mcp/cli.ts` | ✅ `coldstar-signer-mcp` stdio binary, configured by env |
| `src/mcp/server.test.ts` | ✅ 10 tests over an in-memory MCP client |
| `src/wallet/simulate.ts` | ✅ posture (b), opt-in: `rpcSimulator` measures the fee payer's debit; wallet takes max(static, simulated); failure escalates |
| `src/wallet/simulate.test.ts` | ✅ 9 tests with an injected simulator |
| `src/wallet/ledger.ts` | ✅ `FileSpendLedger` — the daily cap survives restarts; atomic writes, 0600, refuses to start from a corrupt file |
| `src/wallet/ledger.test.ts` | ✅ 7 tests incl. cap-holds-across-wallet-restart |
| `src/wallet/chainLedger.ts` | ✅ `ChainSpendLedger` — the day's spend read back from the chain, so `rm`-ing the local ledger cannot reset the cap |
| `src/wallet/chainLedger.test.ts` | ✅ 7 tests incl. the delete-the-file attack |
| `src/policy/envelope.ts` | ✅ the root-signed policy envelope: `signPolicyEnvelope`, `verifyPolicyEnvelope`, `parsePolicy` (strict schema) |
| `src/cli/signPolicy.ts` | ✅ `coldstar-sign-policy` — run on the cold machine; emits the envelope |
| `tools/coldstar_sign_policy.py` | ✅ the same signer in Python with **no dependencies**, for an offline machine that has no Node |
| `ENVELOPE-SPEC.md` | ✅ the wire format, so any language can produce a valid envelope |
| `src/policy/crossLanguage.test.ts` | ✅ 7 tests: the Python output verifies in TypeScript, and both sign identical bytes |
| `src/policy/revocation.ts` | ✅ on-chain revocation: signed memo marker, `RevocationChecker`, fail-closed |
| `src/policy/airgap.ts` | ✅ the cold-side tool refuses to read the root key on a networked machine |
| `THREAT-MODEL.md` | ✅ what this protects, what it does not, and how to build an air gap that earns the name |
| `src/cli/revoke.ts` | ✅ `coldstar-revoke` — cancel a grant early |
| `src/policy/revocation.test.ts` | ✅ 13 tests incl. forged-marker and unreachable-chain cases |
| `src/policy/envelope.test.ts` | ✅ 11 tests: tamper, wrong root, wrong session, expiry, canonical ordering, wallet refuses bad envelopes |

## The root signs the policy, not the transaction

The cold root never signs transactions for the agent. It signs a **policy envelope** once, on the air-gapped machine: the policy, the one session public key it applies to, an issue time, and an expiry, canonically encoded and Ed25519-signed. The online signer verifies that signature at startup and refuses to run if the policy was edited, the session key is not the one named, the envelope has expired, or (when pinned) the root is not the expected one.

```bash
# on the AIR-GAPPED machine (root keyfile never leaves it)
coldstar-sign-policy --root /media/cold/root.json --policy coldstar.policy.json \
  --session <session pubkey> --expires 7d > envelope.json
# carry envelope.json across the gap (QR / file), then on the online host:
COLDSTAR_POLICY=envelope.json COLDSTAR_ROOT_PUBKEY=<root pubkey> COLDSTAR_REQUIRE_ENVELOPE=1 coldstar-signer-mcp
```

### Revoking a grant early

An envelope expires on its own, but a grant you want dead *now* needs revocation, and the check has to live where an attacker cannot quietly delete it. It lives on Solana: an authority publishes a signed memo naming the session key, and the signer reads the chain before every decision.

```bash
coldstar-sign-policy … --revoker <hot pubkey>   # version 2 envelope, revocable without the safe
coldstar-revoke --authority revoker.json --session <session pubkey>   # emergency stop
```

Turn the check on with `checkRevocation: true` (or `COLDSTAR_CHECK_REVOCATION=1`). Revoked is a hard **REJECT**; a chain the signer cannot reach is an **ESCALATE**, so cutting the signer off from RPC stops the agent rather than freeing it. Running signers notice within their freshness window, 60 seconds by default.

**Be clear about what this stops.** It stops a compromised *agent*, which is the case this package exists for: a prompt-injected agent proposes transactions through the signer, and a revoked grant refuses all of them. It does **not** stop someone who has stolen the session *secret key*. They do not need this package at all; they can sign with web3.js directly, and no off-chain control can stop them. The answer to a stolen key is to keep funds behind an on-chain program that enforces membership itself, which on Solana today means [Squads](https://squads.so) spending limits. We would rather say that plainly than let it be assumed.

In code: `ColdstarWallet.fromEnvelope({ envelope, expectedRoot, session, rpcUrl, checkRevocation: true })`.

### No Node on the air-gapped machine?

A machine that earns the name is usually a minimal install or a read-only live image. Those have `python3`; they often do not have Node, and `pip install` wants the network you just removed. So the same signer ships as one dependency-free Python file:

```bash
./tools/coldstar_sign_policy.py --root root.json --policy coldstar.policy.json \
  --session <session pubkey> --expires 7d > envelope.json
```

It produces byte-identical envelopes, uses PyNaCl when installed and a vendored RFC 8032 Ed25519 otherwise, and runs the same air-gap check. The format is written down in [`ENVELOPE-SPEC.md`](ENVELOPE-SPEC.md) so a third implementation is possible; `src/policy/crossLanguage.test.ts` runs the real script and verifies its output with the real verifier, and asserts both languages sign the same bytes.

The vendored fallback is not constant-time. That is stated in the file and is the reason it is scoped to the air-gapped machine, where there is no attacker present to observe timing. A bare, unsigned `coldstar.policy.json` still works for tests and devnet; set `COLDSTAR_REQUIRE_ENVELOPE=1` anywhere it matters.

## Use it from any MCP client (Claude, Cursor, …)

The same wallet as an MCP server. The model gets five tools and never a key; every outcome is returned as data (`signed` / `escalated` / `rejected`), so an agent can read the reason and stop instead of retrying.

```json
{
  "mcpServers": {
    "coldstar": {
      "command": "npx",
      "args": ["-y", "-p", "coldstar-agent-signer", "coldstar-signer-mcp"],
      "env": {
        "RPC_URL": "https://api.devnet.solana.com",
        "COLDSTAR_POLICY": "/abs/path/coldstar.policy.json",
        "COLDSTAR_SESSION_KEYFILE": "/abs/path/session.json"
      }
    }
  }
}
```

In Claude Code that is one command:

```bash
claude mcp add coldstar \
  -e COLDSTAR_POLICY=/abs/path/envelope.json \
  -e COLDSTAR_SESSION_KEYFILE=/abs/path/session.json \
  -e COLDSTAR_ROOT_PUBKEY=<root pubkey> \
  -e COLDSTAR_REQUIRE_ENVELOPE=1 \
  -- npx -y -p coldstar-agent-signer coldstar-signer-mcp
```

Point `COLDSTAR_POLICY` at a root-signed envelope rather than a bare policy file, and pin the root. A bare policy is a file the agent's own host can edit; an envelope is not.

| Tool | What it does |
|---|---|
| `coldstar_status` | Session address, the policy, today's spend against the daily cap |
| `coldstar_verdict` | Evaluate a base64 transaction; returns AUTO_SIGN / ESCALATE / REJECT and why. Signs nothing. |
| `coldstar_sign` | Sign under policy. `signed` returns the signed tx; `escalated` returns the unsigned tx for the air-gapped device; `rejected` returns no bytes at all. |
| `coldstar_sign_and_send` | As above, then broadcast if signed; an RPC failure returns `send_failed` with the reason instead of an error |
| `coldstar_transfer_sol` | Build + evaluate + send a SOL transfer from the session wallet (`dry_run: true` for the verdict only) |

Set `COLDSTAR_CHAIN_LEDGER=1` to put Solana behind the daily cap. The local file records everything this signer approved (including transactions that have not landed); the chain records everything that actually landed and cannot be deleted. The wallet uses the larger of the two, so an attacker who deletes the ledger file does not get a fresh daily allowance.

The binary keeps the daily-spend ledger in `COLDSTAR_LEDGER` (default `./.coldstar-ledger.json`) so the cap survives restarts. `COLDSTAR_SESSION_KEYFILE` is a `solana-keygen`-style JSON byte array; `COLDSTAR_SESSION_KEY` (base58) also works. It is the **session** key. The root key has no environment variable because it never lives on this machine.

## Install

```bash
npm install coldstar-agent-signer @solana/web3.js tweetnacl
```

`@solana/web3.js` and `tweetnacl` are peer dependencies (Solana Agent Kit already brings both). Published on npm as `coldstar-agent-signer` (unscoped); `npm install github:ExpertVagabond/coldstar-agent-signer` also works and tracks main.

Read [`THREAT-MODEL.md`](THREAT-MODEL.md) before trusting this with anything. It states plainly what the design does not protect against: no secure element, a keylogger on the offline machine defeats it entirely, a stolen session key is beyond any local control, and the code is unaudited.

**Status: beta, devnet.** The signing core and policy engine are in scope for Coldstar's planned independent audit. Run it against devnet, read the policy file before you trust it with anything, and see the posture note below.

### Layering with Squads

Coldstar's honest limit is that it cannot stop someone who has stolen the session key: that person signs with web3.js and never touches this code. Squads fixes exactly that, and Coldstar fixes what Squads leaves open, so the two compose better than either alone.

| | Alone | Together |
|---|---|---|
| **Squads** | On-chain spending limits the program enforces, but members typically sign from a hot browser wallet (its docs route Ledger through Phantom or Solflare with blind signing). | Members can be cold-rooted session keys under local policy. |
| **Coldstar** | Cold root, local policy, escalation to a human — all defeated by a stolen session key. | A stolen key is bounded by the on-chain limit, whoever holds it. |

Put the funds in a Squads vault, make the session key a member with a spending limit, and Coldstar decodes `spending_limit_use` so its own per-transaction, daily and per-mint limits apply on top of the chain's. Set `allowPrograms` to include `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`.

Crucially, Squads is not one opaque allowlisted program. The instructions that would let an agent raise its own ceiling are separate instructions, so they are named and refused: `multisig_add_spending_limit`, `multisig_remove_spending_limit`, `config_transaction_execute`, `vault_transaction_execute`, `proposal_create` and `proposal_vote` all escalate to a human. An agent can spend inside its limit and cannot change the limit.

Nothing here needs Squads' permission: the v4 program is AGPL and permissionless on mainnet and devnet, and the tests build their instructions with `@sqds/multisig` itself.

### What Coldstar can read

An integration, for a policy signer, is a decoder. A program it cannot read is either escalate-everything, which makes the agent useless, or trust-blindly, which makes the limits a decoration. So the list of decoded programs is the list of things an agent can actually do:

| Program | What Coldstar does with it |
|---|---|
| **System** | SOL transfers decoded exactly; unknown discriminants escalate |
| **SPL Token / Token-2022** | `TransferChecked` decoded to amount, mint and destination. `Approve`, `SetAuthority`, `Burn`, `MintTo`, `CloseAccount` and unknown instructions escalate. A bare `Transfer` escalates: it does not name the mint |
| **Associated Token Account** | Creating a payee's account is the ordinary first payment, so it is decoded rather than escalated. Rent is charged against the limits, because creating accounts in a loop is a slow drain |
| **Compute Budget** | The priority fee is computed from the unit limit and price and **counted as spending**. It is real SOL and it is not a transfer, so nothing else would have caught it |
| **Memo** | Read as moving nothing |
| **Squads v4** | `spending_limit_use` decoded; the instructions that raise the agent's own ceiling refused |
| **Anything else** | Bounded only by the program allowlist. Turn on `COLDSTAR_SIMULATE=1` to measure the real debit instead of trusting it |

Decoding is not permission. A program still has to be in `allowPrograms`; being decoded only means the limits mean something once it is.

### The air gap is the part people get wrong

Switching Wi-Fi off is not an air gap, and neither is a machine you also browse on. `coldstar-sign-policy` refuses to read the root key when the machine has a live network interface, prints what it found, and requires `--allow-network` to proceed anyway. It is a guard rail, not proof: it cannot see a VM's isolation, a tether attached later, or a radio the OS does not enumerate. The setup that earns the name is in [`THREAT-MODEL.md`](THREAT-MODEL.md).

### SPL tokens, and a hole that used to be here (read this)

Until 0.3.0 `allowTokens` was declared in the schema and **never read**. Allowlisting the Token program so an agent could pay in USDC therefore switched off every amount control, because the SOL limits count lamports and a token transfer moves none. A policy reading `"allowTokens": ["SOL"]` looked restrictive and bounded nothing. If you ran an earlier version with the Token program allowlisted, treat that wallet as having had no token limits at all.

Now:

- `allowTokens` is enforced. It holds `"SOL"` and/or mint addresses; a movement of anything else escalates. A policy that omits `"SOL"` no longer moves SOL either.
- `tokenLimits` sets per-transaction and daily caps **per mint, in base units as strings** (USDC has 6 decimals, so `"25000000"` is 25 USDC). Base units and strings because money and floats do not mix.
- Destinations are token accounts, not wallets, so the wallet derives the associated token account of every `allowRecipients` × mint pair and checks against those. You rarely need to write `allowTokenAccounts` by hand.
- The daily per-mint total persists in the ledger and, with `COLDSTAR_CHAIN_LEDGER=1`, is cross-checked against token balance deltas on chain.

**Instructions that cannot be bounded are refused**, which means ESCALATE, so a human sees them: `Approve` and `ApproveChecked` (a delegate can drain later with no further signing — this was the sharpest edge), `SetAuthority`, `MintTo`, `Burn`, `CloseAccount`, and any discriminant the decoder does not know. A bare `Transfer` also escalates: its accounts do not include the mint, so the asset cannot be identified and `allowTokens` cannot be applied. Use `TransferChecked`, which is the recommended instruction anyway.

### Posture on non-System programs (read this)

A swap through an allowlisted program such as Jupiter cannot be statically decoded to a SOL amount; the real number depends on routing and on-chain state. This release ships **posture (a): trust the program allowlist.** Allowlisting a program means "I accept that this program can move funds within its own logic." Per-transaction and daily caps therefore bound bare SOL transfers, not what an allowlisted program does internally. Keep `allowPrograms` short. You will almost always need the ComputeBudget program (`ComputeBudget111111111111111111111111111111`) in it: most SDKs, Solana Agent Kit included, prepend a priority-fee instruction to every transaction, and it moves no lamports. **Posture (b) is available opt-in:** pass `preflight: { simulate: rpcSimulator(rpcUrl) }` to `ColdstarWallet` (or set `COLDSTAR_SIMULATE=1` for the MCP binary) and any transaction touching a non-System program is simulated first; the fee payer's measured debit is applied to the per-transaction limit, escalate threshold, and daily cap when it exceeds the static figure, and a failed simulation escalates. Simulation can still diverge from execution, so this narrows the gap rather than closing it. The decision seam is documented at `classifyOpaqueProgram` in `src/adapter/parseTx.ts`.

## Use it from Solana Agent Kit

`ColdstarWallet` implements the same five methods as the kit's `KeypairWallet`, so it is a one-line swap:

```ts
import { Keypair } from "@solana/web3.js";
import { ColdstarWallet, ColdstarEscalation, ColdstarRejected } from "coldstar-agent-signer";
import policy from "./coldstar.policy.json";

// The SESSION key. Disposable; authorised by the cold root's policy envelope.
// The root key is never in this process.
const session = Keypair.fromSecretKey(bs58.decode(process.env.COLDSTAR_SESSION_KEY!));

const wallet = new ColdstarWallet({
  policy,
  session,
  rpcUrl: process.env.RPC_URL!,
  onEscalate: async (tx, reason) => {
    // Hand the unsigned tx to the air-gapped device (QR) and return the signed
    // tx if a human approves, or null to decline. Omit to make ESCALATE throw.
    return null;
  },
  onDecision: (d) => console.log(d.decision, d.reason),
});

const agent = new SolanaAgentKit(wallet, process.env.RPC_URL!, {});
```

Pass `ledger: new FileSpendLedger("/var/lib/coldstar/ledger.json")` so the daily cap survives a restart; the default in-memory ledger is for tests and throwaway sessions. Every `signTransaction` / `signAllTransactions` / `signAndSendTransaction` call is projected, parsed, and evaluated first. `AUTO_SIGN` signs with the session key. `ESCALATE` calls `onEscalate`, and throws `ColdstarEscalation` (carrying the unsigned tx as base64 for the QR hand-off) if it declines. `REJECT` throws `ColdstarRejected` and no signature ever exists. Batches are atomic on rejection: if any transaction in `signAllTransactions` is rejected, none are signed. `signMessage` is refused unless `allowMessageSigning: true`, because off-chain signatures can authorise things the transaction policy never sees.

## The adapter is fail-closed, on purpose

`evaluate()` enforces the recipient allowlist **only when `outSol > 0`**. So an adapter
that reports `0` for an instruction it could not decode would turn an unknown transfer
into an `AUTO_SIGN`. Under-reporting `outSol` is the one way `parseTx.ts` can lose keys.

`parseTx()` therefore returns a `ParseResult`, never a bare `TxIntent`. Anything it cannot
fully account for — an unknown System discriminant, a truncated lamports field, missing
accounts — yields `{ ok: false, reason }`, and **callers must treat that as ESCALATE.**
"Could not be accounted for" is not "safe".

The posture for non-System programs (trust the program allowlist, decided for the devnet
release) is documented at the `classifyOpaqueProgram` seam in `src/adapter/parseTx.ts` and in
the install section above.

## Run the tests

```bash
npm install
npm test        # vitest run
```

## The three demo scenarios (devnet only)

Per Solana convention, the demo runs on **devnet first** — never mainnet.

1. **AUTO_SIGN** — agent does an in-policy Jupiter swap / small transfer to an allowlisted recipient → signs on the session key, no human.
2. **ESCALATE** — agent proposes an over-limit transfer → hand-off to the air-gapped device for human approval (QR).
3. **REJECT** — a prompt-injected / hijacked agent proposes a transfer to a blocklisted address → **no signature is ever produced.** This is the money shot.

## Policy model

See `coldstar.policy.json`. Evaluation order (first match wins): blocklist → program allowlist → escalate-threshold → per-tx limit → recipient allowlist → daily cap → auto-sign. Blocklist is checked first and unconditionally, so it beats an otherwise-in-policy transaction.
