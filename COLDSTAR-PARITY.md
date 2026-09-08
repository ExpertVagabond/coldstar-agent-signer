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

## Where they diverge

### 1. Memory protection is real in Coldstar and absent here

`secure_signer/src/secure_buffer.rs` locks pages with `mlock` and zeroizes on
drop, including on panic. `crypto.rs` routes every plaintext-key path through
it, and `LockingMode` can require the lock rather than warn.

The agent signer decrypts into an ordinary JavaScript or Python heap. It fills
the buffer with zeros afterwards, which does not reach copies the runtime has
already made, and nothing prevents those pages reaching swap.

This is the largest honest gap. The website's threat model describes Coldstar,
where the claim is true; it is not true of this package's own signing tools.

### 2. A legacy Coldstar wallet cannot be opened here

Coldstar has an older container written by PyNaCl, and `wallet.py`
(`load_encrypted_container`) still reads it, converts it to the Rust format and
rewrites the file, keeping a `.pynacl.backup`. So a wallet that has been opened
by a recent Coldstar build is already in the format above.

A wallet that has **not** been opened since is still in the old shape, and this
package rejects it outright:

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

There is also an older plaintext byte-array format. Coldstar refuses it and
tells the user to make a new encrypted wallet. This package accepts it with a
warning, which is more permissive than Coldstar is.

### 3. Array-form container fields are rejected

`_normalize_container_format` in `wallet.py` exists because containers are found
in the wild with `salt`, `nonce`, `ciphertext` and `public_key` as JSON arrays
of integers rather than encoded strings. `isEncryptedKeyContainer` requires
strings, so such a file is reported as neither a container nor a key file.

### 4. The policy envelope does not ride Coldstar's wire format

Coldstar's air-gap envelope (`src/qr.py`, `build_envelope`) is:

```json
{"type":"signed_transaction","version":<n>,"data":"<base64>"}
```

with `unsigned_transaction` as the other type, and the `mobile/` app in the same
repository matches it exactly. The policy envelope this package emits is a
different JSON object that crosses the gap as a file.

The consequence is concrete: the Coldstar mobile app cannot carry an agent
grant across the gap, even though carrying things across the gap is exactly what
it is for.

### 5. Passphrase rules differ on the same key

`security_validation.py` has `validate_password_strength`. This package requires
eight characters. Two tools guarding one key should not disagree about what
protects it.

## Deliberately not shared

USB detection and mounting (`src/usb.py`, 893 lines), the ISO builder, the TUI,
and the token metadata fetchers belong to a wallet application, not to a signing
library that an agent imports. Coldstar should keep them and this package should
not grow them.

## The call

Adopt Coldstar's formats completely, and use its Rust signer when it is present.

The format is the product boundary; the implementation language is not. A pure
TypeScript and Python implementation has to stay, because it is the reason the
air-gapped path works on a machine with neither Node nor a package installer.
But it should read every container Coldstar can produce, put the policy envelope
inside Coldstar's own wire envelope so the existing mobile app can carry it,
share the passphrase rules, and hand key material to the Rust `SecureBuffer`
whenever the library is available rather than reimplementing around it.
