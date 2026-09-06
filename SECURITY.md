# Security

Coldstar is security software, and this package is the part of it an AI agent talks to. Please report vulnerabilities privately.

**Email:** security@coldstar.dev

Include a description, reproduction steps, and impact. We aim to acknowledge within 72 hours and will not pursue good-faith research that respects this policy and user data. Public disclosure after a reasonable fix window is welcome; we will credit you unless you prefer otherwise.

## What we most want to hear about

- Any path by which `evaluate()` returns `AUTO_SIGN` for a transaction the policy should have stopped, including `parseTx` under-reporting `outSol` for a decodable instruction.
- Any way a caller of `ColdstarWallet` or the MCP server can obtain a signature for a `REJECT`ed transaction, or obtain the session secret.
- Any way the `send_failed` / `escalated` outcomes could carry a signed transaction they should not.
- Mismatches between the committed `dist/` and `src/`.

## Threat model

[`THREAT-MODEL.md`](THREAT-MODEL.md) states what the design protects, what it does not (no secure element, a compromised offline machine defeats it, a stolen session key is beyond local control), and how to set up an air gap properly.

## Status

Beta. The signing core and policy engine are in scope for Coldstar's planned independent audit. Until it completes: devnet, small amounts, short `allowPrograms`. The non-System-program posture is documented in the README and at `classifyOpaqueProgram` in `src/adapter/parseTx.ts`.

## Scope

In scope: everything in this repository. Out of scope: findings that require a fully compromised host the operator already controls, social engineering of the operator, and issues in third-party dependencies (report upstream, and tell us so we can pin around them).
