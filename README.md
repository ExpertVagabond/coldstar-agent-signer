# coldstar-agent-signer

Agent-safe signing for Coldstar. Lets an AI agent transact on Solana **without ever holding the root key**: routine, in-policy transactions auto-sign on a cold-rooted session key; out-of-policy transactions escalate to **air-gapped human approval**; disallowed/injected transactions are **rejected**.

Three layers, all here and tested: a pure policy engine, a fail-closed transaction decoder, and two ways to hold the wallet — `ColdstarWallet` (a drop-in for Solana Agent Kit's `BaseWallet`) and `coldstar-signer-mcp` (an MCP server for Claude, Cursor, or any MCP client). Beta, devnet.

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

In code: `ColdstarWallet.fromEnvelope({ envelope, expectedRoot, session, rpcUrl })`. A bare, unsigned `coldstar.policy.json` still works for tests and devnet; set `COLDSTAR_REQUIRE_ENVELOPE=1` anywhere it matters.

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

**Status: beta, devnet.** The signing core and policy engine are in scope for Coldstar's planned independent audit. Run it against devnet, read the policy file before you trust it with anything, and see the posture note below.

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
