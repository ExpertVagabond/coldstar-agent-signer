# @coldstar/agent-signer

Agent-safe signing for Coldstar. Lets an AI agent transact on Solana **without ever holding the root key**: routine, in-policy transactions auto-sign on a cold-rooted session key; out-of-policy transactions escalate to **air-gapped human approval**; disallowed/injected transactions are **rejected**.

This repo is the **starter scaffold for the MVP demo** (`build-context.md`). The security-critical piece — the policy engine — is here, tested. The Solana adapter + MCP wiring are stubs to fill in.

## Why this shape

The decision logic (`src/policy/evaluate.ts`) is a **pure function** over a normalized `TxIntent` — no I/O, no `@solana/*` imports. That's deliberate: the part that must be correct is exhaustively unit-testable without a validator, a network, or a wallet. Parsing a raw transaction into `{ outSol, recipients, instructions }` is the adapter's job, where a bug is a reliability issue, not a security hole.

```
raw tx ──(adapter: @solana/kit parse)──▶ TxIntent ──(evaluate)──▶ AUTO_SIGN | ESCALATE | REJECT
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
| `src/signer/escalate.ts` | ⬜ TODO — QR / air-gap hand-off; today `onEscalate` is an injected handler |
| `src/mcp/` | ⬜ TODO — MCP tool surface |

## Use it from Solana Agent Kit

`ColdstarWallet` implements the same five methods as the kit's `KeypairWallet`, so it is a one-line swap:

```ts
import { Keypair } from "@solana/web3.js";
import { ColdstarWallet, ColdstarEscalation, ColdstarRejected } from "@coldstar/agent-signer";
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

Every `signTransaction` / `signAllTransactions` / `signAndSendTransaction` call is projected, parsed, and evaluated first. `AUTO_SIGN` signs with the session key. `ESCALATE` calls `onEscalate`, and throws `ColdstarEscalation` (carrying the unsigned tx as base64 for the QR hand-off) if it declines. `REJECT` throws `ColdstarRejected` and no signature ever exists. Batches are atomic on rejection: if any transaction in `signAllTransactions` is rejected, none are signed. `signMessage` is refused unless `allowMessageSigning: true`, because off-chain signatures can authorise things the transaction policy never sees.

## The adapter is fail-closed, on purpose

`evaluate()` enforces the recipient allowlist **only when `outSol > 0`**. So an adapter
that reports `0` for an instruction it could not decode would turn an unknown transfer
into an `AUTO_SIGN`. Under-reporting `outSol` is the one way `parseTx.ts` can lose keys.

`parseTx()` therefore returns a `ParseResult`, never a bare `TxIntent`. Anything it cannot
fully account for — an unknown System discriminant, a truncated lamports field, missing
accounts — yields `{ ok: false, reason }`, and **callers must treat that as ESCALATE.**
"Could not be accounted for" is not "safe".

Open posture decision for non-System programs is documented at the `classifyOpaqueProgram`
seam in `src/adapter/parseTx.ts`. Current behaviour: trust the program allowlist.

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
