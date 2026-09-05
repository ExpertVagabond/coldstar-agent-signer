// Coldstar Agent-Safe Signing — transaction adapter.
//
// Turns a decompiled Solana message into the normalized `TxIntent` that the
// pure policy engine (../policy/evaluate.ts) decides on.
//
// ── Why this is fail-closed ──────────────────────────────────────────────────
// `evaluate()` enforces the recipient allowlist ONLY when `outSol > 0`. So an
// adapter that silently reports 0 for an instruction it could not decode turns
// an unknown value transfer into an AUTO_SIGN. Under-reporting `outSol` is the
// single way this file can cause key loss.
//
// Therefore `parseTx` returns a Result, never a bare TxIntent: anything it
// cannot account for produces `{ ok: false }`, and the caller MUST treat that
// as ESCALATE (hand to the air-gapped device), never as "no value moved".
//
// This file is pure — no I/O, no network, no @solana/* imports — for the same
// reason `evaluate` is: the parts that must be correct are unit-testable
// without a validator. `fromKitTransaction()` at the bottom is the only seam
// that touches a real SDK shape.

import { TxIntent, TxInstruction, LAMPORTS_PER_SOL } from "../policy/schema.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/**
 * The subset of a decompiled message this decoder needs. Deliberately
 * structural: it matches @solana/kit's decompiled instruction shape
 * (`{ programAddress, accounts: [{ address }], data: Uint8Array }`) without
 * importing it, so the security-critical decode has no dependency surface.
 */
export interface CompiledInstruction {
  programAddress: string;
  accounts?: readonly { readonly address: string }[];
  data?: Uint8Array;
}

export interface DecompiledMessage {
  /** The wallet whose SOL is at risk — value leaving THIS account is what counts. */
  feePayer: string;
  instructions: readonly CompiledInstruction[];
}

export type ParseResult =
  | { ok: true; intent: TxIntent }
  | { ok: false; reason: string };

/** System Program instruction discriminants that move lamports out of `from`. */
const SYS_CREATE_ACCOUNT = 0;
const SYS_TRANSFER = 2;
const SYS_CREATE_ACCOUNT_WITH_SEED = 3;
const SYS_TRANSFER_WITH_SEED = 11;

/** System Program discriminants that are known NOT to move lamports. */
const SYS_NON_VALUE = new Set([
  1, // Assign
  4, // AdvanceNonceAccount
  6, // InitializeNonceAccount
  7, // AuthorizeNonceAccount
  8, // Allocate
  9, // AllocateWithSeed
  10, // AssignWithSeed
]);

function readU32LE(data: Uint8Array, offset: number): number | undefined {
  if (data.length < offset + 4) return undefined;
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function readU64LE(data: Uint8Array, offset: number): bigint | undefined {
  if (data.length < offset + 8) return undefined;
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

/**
 * Decode one System Program instruction into a TxInstruction.
 *
 * `from` and `to` positions per the System Program account layout:
 *   Transfer                 [from, to]
 *   CreateAccount            [from, newAccount]
 *   CreateAccountWithSeed    [from, created, base?]
 *   TransferWithSeed         [from, base, to]
 *
 * Returns a reason string on anything it cannot fully account for.
 */
function decodeSystemIx(
  ix: CompiledInstruction,
  feePayer: string,
): { ok: true; value: TxInstruction } | { ok: false; reason: string } {
  const data = ix.data;
  if (!data || data.length < 4) {
    return { ok: false, reason: "system instruction has no/short data" };
  }
  const disc = readU32LE(data, 0);
  if (disc === undefined) {
    return { ok: false, reason: "system instruction discriminant unreadable" };
  }

  if (SYS_NON_VALUE.has(disc)) {
    return { ok: true, value: { programId: SYSTEM_PROGRAM_ID } };
  }

  const movesValue =
    disc === SYS_TRANSFER ||
    disc === SYS_CREATE_ACCOUNT ||
    disc === SYS_CREATE_ACCOUNT_WITH_SEED ||
    disc === SYS_TRANSFER_WITH_SEED;

  if (!movesValue) {
    // Unknown System discriminant. It may or may not move lamports; we refuse
    // to guess, because guessing "0" is the unsafe direction.
    return { ok: false, reason: `unknown system instruction discriminant ${disc}` };
  }

  const lamports = readU64LE(data, 4);
  if (lamports === undefined) {
    return { ok: false, reason: `system instruction ${disc} has no lamports field` };
  }

  const accounts = ix.accounts ?? [];
  const from = accounts[0]?.address;
  // TransferWithSeed is [from, base, to]; every other value-moving variant is [from, to, ...].
  const to = disc === SYS_TRANSFER_WITH_SEED ? accounts[2]?.address : accounts[1]?.address;

  if (from === undefined || to === undefined) {
    return { ok: false, reason: `system instruction ${disc} missing from/to accounts` };
  }

  // Value leaving a wallet we do not control is not our exposure. Only count
  // lamports debited from the fee payer (the policy-gated wallet).
  if (from !== feePayer) {
    return { ok: true, value: { programId: SYSTEM_PROGRAM_ID } };
  }

  return {
    ok: true,
    value: { programId: SYSTEM_PROGRAM_ID, recipient: to, lamports: Number(lamports) },
  };
}

/**
 * ── DECISION SEAM ────────────────────────────────────────────────────────────
 * How to treat an instruction for a program that is NOT the System Program.
 *
 * The problem: you cannot statically decode how much SOL a Jupiter swap moves.
 * The amount depends on routing and on-chain state, so the only exact answers
 * come from simulation. That leaves three defensible postures, and the choice
 * decides whether the AUTO_SIGN demo (an in-policy Jupiter swap) works at all:
 *
 *   (a) TRUST THE ALLOWLIST — report outSol 0 and let `evaluate` rule 2 catch
 *       non-allowlisted programs. Allowlisting Jupiter means "I accept that
 *       Jupiter can move funds within its own logic." Demo works; the blast
 *       radius of an allowlisted-but-exploited program is uncapped.
 *
 *   (b) SIMULATE — run simulateTransaction and read the fee payer's balance
 *       delta, then feed the real number in. Exact and caps blast radius, but
 *       makes parseTx impure and network-bound, and simulation can diverge
 *       from execution.
 *
 *   (c) ESCALATE EVERYTHING NON-SYSTEM — only bare SOL transfers ever
 *       auto-sign. Safest, and kills the autonomy story the wedge sells.
 *
 * Currently implemented: (a), because it matches the policy file already on
 * disk (`allowPrograms` includes Jupiter) and keeps this function pure.
 *
 * DECISION (2026-09-05, shipped for the devnet release): posture (a). The
 * program allowlist is the control. Allowlisting a program means "I accept
 * that this program can move funds within its own logic", and the README says
 * so in those words. Revisit before recommending mainnet use: (b) simulation
 * is the likely upgrade, wired as an optional pre-check in ColdstarWallet
 * rather than inside this pure function. To switch to (c), return
 * `{ ok: false, reason: ... }` for any non-System program.
 */
function classifyOpaqueProgram(
  ix: CompiledInstruction,
): { ok: true; value: TxInstruction } | { ok: false; reason: string } {
  return { ok: true, value: { programId: ix.programAddress } };
}

/**
 * Parse a decompiled message into a TxIntent.
 *
 * Callers MUST treat `{ ok: false }` as ESCALATE. It means "this transaction
 * could not be fully accounted for", which is not the same as "it is safe".
 */
export function parseTx(message: DecompiledMessage): ParseResult {
  if (message.instructions.length === 0) {
    return { ok: false, reason: "transaction has no instructions" };
  }

  const instructions: TxInstruction[] = [];
  let outLamports = 0n;

  for (const ix of message.instructions) {
    const decoded =
      ix.programAddress === SYSTEM_PROGRAM_ID
        ? decodeSystemIx(ix, message.feePayer)
        : classifyOpaqueProgram(ix);

    if (!decoded.ok) return { ok: false, reason: decoded.reason };

    instructions.push(decoded.value);
    if (decoded.value.lamports !== undefined) {
      outLamports += BigInt(decoded.value.lamports);
    }
  }

  // Distinct destinations, in first-seen order, for the allowlist/blocklist checks.
  const recipients = [
    ...new Set(
      instructions
        .map((ix) => ix.recipient)
        .filter((r): r is string => r !== undefined),
    ),
  ];

  return {
    ok: true,
    intent: {
      instructions,
      outSol: Number(outLamports) / LAMPORTS_PER_SOL,
      recipients,
    },
  };
}

/**
 * Seam for the real SDK. @solana/kit's `decompileTransactionMessage` yields
 * instructions shaped like `CompiledInstruction` above, so this is a shallow
 * projection rather than a second decoder — keeping the kit dependency out of
 * the security-critical path.
 */
export function fromKitTransaction(kitMessage: {
  feePayer: string | { address: string };
  instructions: readonly CompiledInstruction[];
}): ParseResult {
  const feePayer =
    typeof kitMessage.feePayer === "string" ? kitMessage.feePayer : kitMessage.feePayer.address;
  return parseTx({ feePayer, instructions: kitMessage.instructions });
}
