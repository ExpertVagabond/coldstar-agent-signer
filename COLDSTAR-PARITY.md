# Parity with Coldstar

The goal for `coldstar-agent-signer` is not to be a second product. It should be
Coldstar, with an interface an agent can use. This file records where the two
actually agree today, where they do not, and which differences are deliberate.

Compared against `devsyrem/coldstar` at `5b75d94` (2026-09-06), branch
`claude/discussion-3iuhde`, which is the live public repository. Resolved by
remote, not by directory name.

## The one difference that is the point

Coldstar's root key signs **transactions**. A human sits at an air-gapped
machine and approves each one, and the transaction crosses the gap as a QR code
or a file.

The agent signer's root key signs **one policy**, once. That policy names a
session key and bounds what it may do. The session key then signs transactions
online, and the agent never holds the root.

This is the whole reason the package exists, and it should stay. Everything
below is a place where the two differ for no good reason.

## Where they already agree

The steady-state key file is the same artifact. Coldstar's Rust signer
(`secure_signer/src/crypto.rs`) and `src/policy/keyfile.ts` both write:

| Field | Value |
| --- | --- |
| `version` | 1 |
| KDF | Argon2id v1.3, m = 65536 KiB, t = 3, p = 4 |
| Cipher | AES-256-GCM, 12-byte nonce, tag appended to the ciphertext |
| Payload | the 32-byte Ed25519 seed, not the 64-byte keypair |
| Encoding | base64 for salt, nonce and ciphertext; base58 for `public_key` |

Cross-checked in `src/policy/crossLanguage.test.ts`: the Python tool opens a
container TypeScript wrote and signs an envelope the TypeScript verifier
accepts. Argon2id is separately checked against the RFC 9106 vector, so a
silently different KDF cannot pass by agreeing with itself.

Both also refuse to read a root key on a machine with a live network interface,
and both treat that check as a negative signal rather than proof.

## Where they diverged, and what is now closed

All five are closed. Each is verified against Coldstar's own code or its own
output, never against a reimplementation of it.

### 1. Memory protection — CLOSED by delegation

`secure_signer/src/secure_buffer.rs` locks pages with `mlock` and zeroizes on
drop, including on panic. `crypto.rs` routes every plaintext-key path through
it, and `LockingMode` can require the lock rather than warn.

The agent signer decrypts into an ordinary JavaScript or Python heap. It fills
the buffer with zeros afterwards, which does not reach copies the runtime has
already made, and nothing prevents those pages reaching swap.

`coldstar-sign-policy` now hands the work to that binary when it is installed:
`src/policy/rustSigner.ts` finds `solana-signer`, and the plaintext key then
never exists in this process at all. The container and the passphrase go over
stdin as one JSON line, never as arguments, because `solana-signer sign
--passphrase …` would put the passphrase in `ps` output and shell history.

Verified: the delegated signature is byte-identical to the in-process one over
the same payload, and the binary reports `mlock_supported: true`. Point it at a
build with `COLDSTAR_SIGNER_BIN`, or put it on `PATH`. `--no-rust-signer` forces
the pure path, which remains the default when the binary is absent, because it
is the reason the air-gapped machine needs neither Node nor a package
installer.

### 2. Legacy Coldstar wallets — CLOSED

Coldstar has an older container written by PyNaCl, and `wallet.py`
(`load_encrypted_container`) still reads it, converts it to the Rust format and
rewrites the file, keeping a `.pynacl.backup`. So a wallet that has been opened
by a recent Coldstar build is already in the format above.

A wallet that has **not** been opened since is still in the old shape. This
package used to reject it outright; `src/policy/legacyKeyfile.ts` now reads it,
and `coldstar-encrypt-key` converts it to the current format the way Coldstar's
own wallet does. The formats:

| | Legacy PyNaCl | Rust / current |
| --- | --- | --- |
| `version` | 2 | 1 |
| `algo` | `argon2id_xsalsa20poly1305` | absent |
| KDF | libsodium Argon2id, `opslimit` 3, `memlimit` 64 MB, lanes fixed at 1 | Argon2id, t=3, m=65536 KiB, p=4 |
| Cipher | XSalsa20-Poly1305, 24-byte nonce | AES-256-GCM, 12-byte nonce |
| Payload | full 64-byte keypair | 32-byte seed |
| Encoding | hex | base64 |

Note the parallelism: libsodium fixes Argon2id at one lane, so the two KDFs do
not produce the same key even with matching cost parameters. Reading the legacy
format needs its own path, not a parameter tweak.

The fixtures in `src/policy/fixtures/legacy-containers.json` were produced by
Coldstar's own `SecureWalletHandler`, not by anything here. A reader tested only
against its own writer passes just as happily when both have drifted away from
the format a real wallet is in.

One bug this caught, worth recording. A legacy container also has `salt`, `nonce`
and `ciphertext` as strings, so `isEncryptedKeyContainer` claimed it and the
legacy branch was unreachable. The unit tests missed it and an end-to-end run
found it. The type guard now discriminates on `algo` and on the field sizes,
which differ (16 and 24 bytes against 32 and 12).

There is also an older plaintext byte-array format. Coldstar refuses it and
tells the user to make a new encrypted wallet. This package accepts it with a
warning, which is more permissive than Coldstar is.

### 3. Array-form container fields — CLOSED

`_normalize_container_format` in `wallet.py` exists because containers are found
in the wild with `salt`, `nonce`, `ciphertext` and `public_key` as JSON arrays
of integers rather than encoded strings. `normalizeKeyContainer` now performs the same coercion before the
format checks, so those files load.

### 4. The policy envelope's wire format — CLOSED

Coldstar's air-gap envelope (`src/qr.py`, `build_envelope`) is:

```json
{"type":"signed_transaction","version":<n>,"data":"<base64>"}
```

with `unsigned_transaction` as the other type, and the `mobile/` app in the same
repository matches it exactly. The policy envelope this package emits is a
different JSON object that crosses the gap as a file.

`coldstar-sign-policy --wire` now emits the grant inside that wrapper, as a
third type, `policy_envelope`, alongside the two transaction types. The output
is checked byte for byte against Coldstar's own `build_envelope`.

One step remains and it is upstream, not here: the `mobile/` app has to learn
the new type before it will carry a grant. The wire format no longer stands in
the way.

### 5. Passphrase rules — CLOSED

`security_validation.py` has `validate_password_strength`. This package required
eight characters. It now applies Coldstar's rules exactly: twelve characters,
upper, lower, a digit, and not one of the common passwords Coldstar lists.

Matched rather than improved on. Composition rules are not what modern guidance
recommends, but two tools guarding one key must not disagree about what protects
it, and the key file moves between them. The rules apply when a passphrase is
SET, never when an existing file is opened, so tightening them cannot lock
anyone out of a key they already have.

## Deliberately not shared

USB detection and mounting (`src/usb.py`, 893 lines), the ISO builder, the TUI,
and the token metadata fetchers belong to a wallet application, not to a signing
library that an agent imports. Coldstar should keep them and this package should
not grow them.

## What is left

Two things, both upstream in `devsyrem/coldstar` rather than here:

1. The `mobile/` app does not know the `policy_envelope` type, so it cannot yet
   carry a grant across the gap even though the wire format now allows it.
2. `solana-signer` cannot read a legacy libsodium container, so the delegated
   signing path only applies to current ones. A legacy wallet is read in
   process, or converted first with `coldstar-encrypt-key`.

The principle to keep: the format is the product boundary, the implementation
language is not. The pure TypeScript and Python path stays, because it is the
reason the air-gapped machine needs neither Node nor a package installer.
