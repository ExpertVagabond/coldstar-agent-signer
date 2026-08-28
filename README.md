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
| `src/signer/session.ts` | ⬜ TODO — cold-rooted session signer (AUTO_SIGN) |
| `src/signer/escalate.ts` | ⬜ TODO — QR / air-gap hand-off (ESCALATE) |
| `src/mcp/` | ⬜ TODO — expose as a ColdstarWallet / MCP tool for Solana Agent Kit |

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
