# Policy envelope, wire format

A policy envelope is a root signature over a policy, bound to one session key and a validity window. It is the only thing the air-gapped root ever signs, and it is plain JSON so it can cross the gap as a file or a QR code.

This document is the format, so an implementation in any language can produce an envelope the signer accepts. There are two in this repository already: `src/policy/envelope.ts` (TypeScript) and `tools/coldstar_sign_policy.py` (Python, no dependencies). Their outputs are cross-verified in `src/policy/crossLanguage.test.ts`.

## Canonical JSON

Signatures cover a canonical encoding, so two implementations that agree on the data agree on the bytes:

- Object keys sorted by Unicode code point, recursively.
- No insignificant whitespace: `{"a":1,"b":[2,3]}`.
- Arrays keep their order. Order is meaningful in `allowPrograms`, `allowRecipients` and the rest.
- Strings use standard JSON escaping. Numbers are emitted as JSON numbers.
- Absent optional fields are absent, not `null`. `null` is a value and changes the bytes.

## The signed payload

Version 1:

```json
{"expiresAt":<string|null>,"issuedAt":<string>,"policy":<policy>,"sessionPubkey":<string>}
```

Version 2 adds one field, and only version 2:

```json
{"expiresAt":<string|null>,"issuedAt":<string>,"policy":<policy>,"revoker":<string|null>,"sessionPubkey":<string>}
```

Shown here in sorted order for clarity; an implementation must sort rather than copy this layout. Timestamps are ISO-8601 in UTC. `policy` is the whole policy object, canonically encoded in place.

Version 1 payloads deliberately exclude `revoker`. Adding a field to them would invalidate every envelope already issued, so a version 1 envelope carrying a `revoker` is rejected: its signature would not cover the field.

## The signature

Ed25519 over the UTF-8 bytes of the canonical payload, using the root's secret key. The same curve Solana uses, so a Solana keypair is a valid root. Encode the signature and both public keys as base58 (Bitcoin alphabet, no checksum).

## The envelope

```json
{
  "version": 1 | 2,
  "policy": { ... },
  "sessionPubkey": "<base58>",
  "issuedAt": "2026-09-06T12:00:00.000Z",
  "expiresAt": "2026-09-13T12:00:00.000Z" | null,
  "revoker": "<base58>" | null,       // version 2 only
  "rootPubkey": "<base58>",
  "signature": "<base58, 64 bytes>"
}
```

## What a verifier must check

In this order, refusing on the first failure:

1. The document parses and matches the schema. Unknown keys are refused, not ignored.
2. `rootPubkey` equals the root the operator pinned. Without a pinned root, any key could have signed the policy, and the envelope proves nothing.
3. `sessionPubkey` equals the public key of the session secret this process holds.
4. `expiresAt` is absent, null, or in the future.
5. `issuedAt` is not implausibly far in the future. The reference implementations allow five minutes of clock skew.
6. Version 1 does not carry a `revoker`.
7. The Ed25519 signature verifies over the canonical payload for that version.

Only then is the policy inside trusted.

## Notes for implementers

Emit `expiresAt` rather than omitting it. A grant with no expiry is valid and both reference tools warn about it, because expiry is the only bound that survives losing the session key.

Base58 has no checksum here. A corrupted key or signature fails verification, which is the correct outcome, so the extra layer would only change the error message.

Encode timestamps with millisecond precision and a trailing `Z`. Both implementations produce that form; a verifier compares instants rather than strings, so other valid ISO-8601 forms verify, but matching keeps diffs readable.
