# Session status

Four-part run requested 2026-09-07. Updated as each part lands so a cutoff
resumes instead of restarting.

## 1. Upstream the two Coldstar changes — DONE

Target repo `devsyrem/coldstar` (push access, no admin). The tree at
`$VS/projects/coldstar-devsyrem` has **6 unpushed local commits** on
`claude/discussion-3iuhde` that are Matthew's, not mine. Do not push them.
Work happens in worktrees off the *pushed* state so that tree is untouched.

Two PRs opened on devsyrem/coldstar:
- **#14** -> `main`: `sign_payload` action. cargo test 13+1 passed.
- **#15** -> `claude/discussion-3iuhde`: mobile learns `policy_envelope`, and
  `encodeEnvelope` now matches `qr.py` byte for byte.

`rustSigner.ts` here prefers `sign_payload` and falls back to `sign`, tested
against a binary with and without the new action, so it works before #14 merges.

Original notes:

- `secure_signer` is on `main`. Add a `sign_payload` action that signs arbitrary
  bytes from a container and returns only signature + public key. The existing
  `sign` already signs raw bytes, but calls them `transaction` and fabricates a
  `signed_transaction` field, which is misleading for a policy grant.
- `mobile/` is ONLY on `claude/discussion-3iuhde`, not on main. Teach
  `src/lib/airgap.ts` the `policy_envelope` type so the app can carry an agent
  grant. Also make `encodeEnvelope` emit compact JSON: it currently pretty-prints
  while `src/qr.py` does not, which wastes QR capacity for no reason.

Next command: see the worktree paths in this file as they are created.

## 2. Draft the Squads approach — NOT STARTED

Deliverable is a document for Matthew to approve. Nothing goes out without
per-batch approval.

## 3. Parity story as a public page — IN PROGRESS

Site is `$VS/projects/coldstar-website`, branch `redesign`, deploy with
`wrangler pages deploy . --project-name coldstar --branch main`.

## 4. Audit prep — NOT STARTED

Scope what an auditor needs for `src/policy/evaluate.ts` and
`src/adapter/parseTx.ts`.

## Standing gap

npm is at 0.5.0; the repo is at 0.7.0. Publishing is Matthew's to trigger:
`git tag v0.7.0 && git push origin v0.7.0`.
