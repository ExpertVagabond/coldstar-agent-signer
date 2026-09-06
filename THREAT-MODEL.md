# Threat model

Written because the fair criticisms of a software air gap are the ones a vendor is tempted not to write down. Each section says what the design does, and then what it does not.

Status: beta, pre-audit. Devnet. The signing core and policy engine are in scope for Coldstar's planned independent audit.

## What this actually protects

The root key is an AES-256-GCM ciphertext on a drive you hold. It is decrypted into memory-locked RAM on a machine with no network path, for as long as it takes to sign, and wiped. Online, an agent holds a disposable session key bounded by a policy the root signed. Every transaction it proposes is decoded and evaluated before a signature exists.

That removes one specific class of loss: the remote attacker. Malware on your everyday machine, a compromised dependency, a hijacked browser extension, a prompt-injected agent. None of them can reach a key that is not on a networked machine, and none of them can make the online session key exceed its policy.

## What it does not protect against

**No secure element.** There is no certified chip. A hardware wallet's secure element resists an attacker who physically has the device and the skill to attack the silicon; Coldstar has nothing equivalent. What protects the key at rest is the passphrase and AES-256-GCM, and what protects it in use is that the machine doing the decryption is not reachable. If your threat model centres on physical theft plus a well-resourced attacker, buy a certified device. We compare honestly against several at https://coldstar.dev/compare.

**A keylogger on the offline machine.** If the machine that decrypts the key is already compromised, this design fails completely. It will capture your passphrase, and the drive is right there. The air gap defends the online side; it assumes the offline side is clean. That assumption is doing real work, which is why the hardening guide below is not optional advice.

**A stolen session key.** Anyone holding the session secret does not need this package; they can sign with web3.js directly, and no local policy, revocation, or ledger can stop them. Policy bounds the agent, not a thief with the key file. If that is your threat, the funds have to sit behind something that enforces membership on-chain, which on Solana today means Squads spending limits.

**Unaudited code.** This decrypts private keys and has not been audited. You are trusting code review you have done or have not done. It is MIT and small on purpose: `src/policy/evaluate.ts` is a pure function, `src/adapter/parseTx.ts` is a decoder with no I/O, and those two files are where a bug becomes a loss. Read those first.

**An allowlisted program.** Allowlisting a program means accepting what it does internally. A swap through Jupiter cannot be statically bounded; `COLDSTAR_SIMULATE=1` measures the real debit and tightens this, and does not remove it. Keep the list short.

**Operator error.** The most likely failure is not cryptographic. See below.

## The air gap is the part people get wrong

Switching Wi-Fi off in software is not an air gap. Neither is a machine you also browse on, nor a VM on a networked host, nor "I disconnected it for this bit".

`coldstar-sign-policy` refuses to read the root key when the machine has a live network interface, and prints what it found. That check is a guard rail and not proof: it cannot see a VM's isolation, a tether attached a minute later, Thunderbolt networking, or a radio the OS does not enumerate. It is a reliable negative signal only.

A setup that earns the name:

1. **A dedicated machine.** An old laptop with the wireless card physically removed, or a Raspberry Pi that has never been on a network. Not the machine you read email on.
2. **A fresh install.** Ideally a live USB image booted read-only, so nothing persists between sessions and there is nowhere for a keylogger to live. `tools/coldstar_sign_policy.py` needs only `python3`, so the offline machine does not need Node or a package install.
3. **Nothing else on it.** Every package you add is code that runs next to your key.
4. **Data crosses as data, not as a device you re-plug.** QR is the good pattern: a camera reads pixels and cannot mount a filesystem. If you use a USB drive, treat it as one-directional and never carry it back to the offline machine after it has been in an online one.
5. **Type the passphrase on the offline machine only.** It should never exist on a networked device, including in a password manager that syncs.
6. **Short grants.** A policy envelope with `--expires 24h` limits the blast radius of anything you got wrong. `--revoker` gives you a kill switch that does not require opening the safe.
7. **Assume the drive will be lost.** It holds ciphertext; that is the point. Keep more than one copy, and keep the passphrase somewhere that is not with them.

## Supply chain

`dist/` is committed so the package installs from git, and CI fails if it does not match `src/`. Releases are published from GitHub Actions with npm provenance, so the tarball on the registry is attested to the workflow run and the commit that produced it. That does not make the code correct. It makes "the code you can read is the code you installed" checkable rather than trusted.

## Reporting

security@coldstar.dev. See `SECURITY.md`.
