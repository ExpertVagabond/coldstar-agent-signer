# Audit scope

What an auditor needs to review this package, what to look at first, and the
weaknesses we already know about so nobody spends billable hours rediscovering
them.

Status: beta, pre-audit. Written 2026-09-07 against `main`.

## The short version

Two files decide whether a transaction gets signed. If there is a bug that costs
someone money, it is overwhelmingly likely to be in one of them:

| File | Lines | What it does | Tests |
| --- | --- | --- | --- |
| `src/adapter/parseTx.ts` | 635 | Turns a raw Solana transaction into a normalised intent. No I/O. | 17 + 19 + 11 + 21 |
| `src/policy/evaluate.ts` | 160 | Pure function. Given an intent and a policy, returns AUTO_SIGN, ESCALATE or REJECT. | 7 |

Everything else exists to get inputs to those two and to act on the answer.

An auditor who reads only `evaluate.ts` and `parseTx.ts` and their tests has
covered the part where a bug becomes a loss. The rest of this document says what
to look at after that, and in what order.

## The property that has to hold

**A transaction the decoder cannot fully account for must never reach
AUTO_SIGN.** Not "is probably fine", not "moves zero lamports as far as we can
tell". Unaccountable means ESCALATE.

This is the invariant to attack. Every real bug we have found in this package so
far was a violation of it:

- `allowTokens` was declared in the schema and never read, so allowlisting the
  Token program disabled every amount control for USDC. Found by internal audit,
  fixed in 0.3.0.
- The Squads decoder checked the system-program slot before the mint slot, and
  the Squads SDK populates the system-program slot even for an SPL transfer, so
  10 USDC was read as 0.01 SOL. Fixed by checking the mint slot first.
- ComputeBudget was allowlisted and its priority fees were not counted, so an
  agent could drain via fees while every limit reported compliance.

Each of those passed the test suite at the time. That is the pattern worth
assuming continues.

## Read in this order

1. **`src/policy/schema.ts`** — the types. Small, and it tells you what a policy
   can express. Note which fields are optional; an optional control that nobody
   sets is a control that does not exist.
2. **`src/policy/evaluate.ts`** — ordered rules, first match wins:
   blocklist → program allowlist → escalate threshold → per-transaction limit →
   recipient allowlist → daily cap → token rules → AUTO_SIGN. Check the order
   itself. A rule that runs after AUTO_SIGN is unreachable, and a rule that runs
   before the blocklist could approve a blocked recipient.
3. **`src/adapter/parseTx.ts`** — the decoders. Per program: System, SPL Token
   and Token-2022, Associated Token Account, ComputeBudget, Stake, Memo, Squads
   v4. For each, ask what an instruction of that program can do that the decoder
   does not represent.
4. **`src/policy/envelope.ts`** — canonical encoding and signature verification.
   The canonicaliser is the attack surface: if two different policies can
   produce the same bytes, one signature covers both.
5. **`src/wallet/coldstarWallet.ts`** — where the decision is enforced, plus
   revocation checks, ledger sync and idempotence.

## Specific things to attack

**Instruction-level.** Introspection, CPI, and anything where the outer
instruction understates what executes.

Address lookup tables are handled fail-closed already, and that is worth
verifying rather than re-deriving. `src/wallet/project.ts` refuses a versioned
message whose program index is not a static key, and refuses an account index
that resolves through a table it has not loaded, both with a reason that
escalates. The question for an auditor is whether there is any path that reaches
`parseTx` with an unresolved index still in it.

**Amount arithmetic.** SOL is handled as a JavaScript number in places and token
amounts as `bigint`. Look for a path where a token amount becomes a float. USDC
has six decimals and float arithmetic on money is how rounding becomes loss.

**The daily ledger.** `src/wallet/chainLedger.ts` takes `max(local, chain)` and
deliberately never sums, so a desynced local file cannot lower the count. Check
that the chain-derived figure cannot be made to under-report, and what happens
at a UTC day boundary.

**Envelope canonicalisation.** Key ordering, unicode normalisation, duplicate
keys, numbers that survive a round trip differently. Two policies, one signature.

**Revocation.** `src/policy/revocation.ts` reads an on-chain memo marker. A chain
the signer cannot reach must ESCALATE, never AUTO_SIGN. Confirm that a slow or
lying RPC cannot produce a stale "not revoked".

**Squads.** We refuse `multisig_add_spending_limit`,
`multisig_remove_spending_limit`, `config_transaction_execute`,
`vault_transaction_execute`, `proposal_create` and `proposal_vote`. The question
we cannot answer ourselves is whether that list is complete for v4. If there is
another path to a higher limit, the refusal list has a hole.

## Known weaknesses, so nobody bills for finding them

These are real, documented, and not defects to report back to us:

- **No secure element.** There is no certified chip and we do not claim one.
- **A compromised offline machine defeats the whole design.** It captures the
  passphrase and the drive is present. The air gap defends the online side and
  assumes the offline side is clean.
- **A stolen session key is beyond any local control.** The holder signs with
  web3.js and never touches this code. The answer is an on-chain limit, which is
  why Squads layering exists.
- **The air-gap check is a guard rail, not proof.** It cannot see a VM's
  isolation, a tether attached a minute later, or a radio the OS does not
  enumerate. Reliable as a negative signal only.
- **Memory handling in the TypeScript and Python paths.** No page locking, and
  zeroing a buffer does not reach copies the runtime already made. When
  Coldstar's Rust signer is installed we delegate to it and the key never enters
  this process; the pure path is the fallback, and it is weaker.
- **An allowlisted program is trusted for everything it can do internally.** A
  swap through Jupiter cannot be statically bounded. `COLDSTAR_SIMULATE=1`
  measures the real debit and tightens this without removing it.

## What is already checked, and how

206 tests, on Node 20 and 22, on every commit. Worth knowing which of these are
real cross-checks rather than self-agreement:

- The Python signer opens containers the TypeScript signer wrote, and produces an
  envelope the TypeScript verifier accepts. Neither is checked against itself.
- Legacy key-container fixtures were generated by Coldstar's own encryption code
  in `devsyrem/coldstar`, not by a reimplementation of it.
- Argon2id is checked against the published RFC 9106 test vector, so a subtly
  different KDF cannot pass by agreeing with itself.
- The air-gap wire format is compared byte for byte against Coldstar's own
  `build_envelope`.

Coverage is uneven and we would rather say so: `evaluate.ts` has 7 direct tests
for the file that makes every decision, while the key-handling code has 28. The
decision logic deserves more, and property-based testing over generated intents
is the obvious gap.

## Practicalities

MIT licensed, public, no build step beyond `npm ci && npm test`. The package has
four dependencies that touch key material: `@noble/hashes`, `@noble/ciphers`,
`tweetnacl` and `@solana/web3.js`. Supply chain is in scope as far as we are
concerned; releases are published with npm provenance and SLSA attestation via
GitHub Actions OIDC.

Questions to `security@coldstar.dev`. If something in this document is wrong or
out of date, that is itself worth reporting.
