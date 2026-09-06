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
import { LAMPORTS_PER_SOL } from "../policy/schema.js";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
/** Squads Protocol v4 multisig, mainnet and devnet. */
export const SQUADS_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
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
function readU32LE(data, offset) {
    if (data.length < offset + 4)
        return undefined;
    return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}
function readU64LE(data, offset) {
    if (data.length < offset + 8)
        return undefined;
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
function decodeSystemIx(ix, feePayer) {
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
    const movesValue = disc === SYS_TRANSFER ||
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
/*
 * ── SPL TOKEN ───────────────────────────────────────────────────────────────
 * Token instructions use a ONE-byte discriminant (System uses four).
 *
 * The reason this decoder exists: allowlisting the Token program so an agent
 * can move USDC used to switch off every amount control, because the SOL
 * limits count lamports and a token transfer moves none. Worse, an `Approve`
 * hands a delegate open-ended authority to drain the account later without any
 * further signing — a total bypass that would have looked like an ordinary
 * allowlisted instruction.
 *
 * So: decode what can be bounded, and refuse the rest. Refusing means
 * `{ ok: false }`, which the caller turns into ESCALATE — a human looks at it.
 */
const TOK_TRANSFER = 3;
const TOK_TRANSFER_CHECKED = 12;
/** Token instructions that move nothing and grant nothing. */
const TOK_NON_VALUE = new Set([
    1, // InitializeAccount
    5, // Revoke — removes a delegate; strictly reduces authority
    16, // InitializeAccount2
    17, // SyncNative
    18, // InitializeAccount3
    22, // InitializeImmutableOwner
]);
/** Named so the escalation reason can say what the agent actually asked for. */
const TOK_DANGEROUS = {
    4: "Approve (delegates open-ended spending authority)",
    13: "ApproveChecked (delegates open-ended spending authority)",
    6: "SetAuthority (hands over control of the account)",
    7: "MintTo",
    14: "MintToChecked",
    8: "Burn",
    15: "BurnChecked",
    9: "CloseAccount (drains the account and its rent)",
    23: "AmountToUiAmount",
};
function readU64(data, offset) {
    if (data.length < offset + 8)
        return undefined;
    return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}
/**
 * Decode one SPL Token instruction.
 *
 * Account layouts:
 *   Transfer         [source, destination, authority]
 *   TransferChecked  [source, mint, destination, authority]
 *
 * Only movements the FEE PAYER authorises count: tokens leaving an account we
 * do not control are not our exposure.
 */
function decodeTokenIx(ix, feePayer) {
    const data = ix.data;
    if (!data || data.length < 1)
        return { ok: false, reason: "token instruction has no data" };
    const disc = data[0];
    const self = { programId: ix.programAddress };
    if (TOK_NON_VALUE.has(disc))
        return { ok: true, value: self };
    const danger = TOK_DANGEROUS[disc];
    if (danger) {
        return { ok: false, reason: `token instruction ${disc}: ${danger} — cannot be bounded by an amount limit` };
    }
    if (disc !== TOK_TRANSFER && disc !== TOK_TRANSFER_CHECKED) {
        return { ok: false, reason: `unknown token instruction discriminant ${disc}` };
    }
    const amount = readU64(data, 1);
    if (amount === undefined)
        return { ok: false, reason: `token instruction ${disc} has no amount field` };
    const accounts = ix.accounts ?? [];
    const checked = disc === TOK_TRANSFER_CHECKED;
    const source = accounts[0]?.address;
    const mint = checked ? accounts[1]?.address : undefined;
    const destination = checked ? accounts[2]?.address : accounts[1]?.address;
    const authority = checked ? accounts[3]?.address : accounts[2]?.address;
    if (source === undefined || destination === undefined || authority === undefined) {
        return { ok: false, reason: `token instruction ${disc} is missing accounts` };
    }
    // Someone else's tokens moving under their own authority is not our exposure.
    if (authority !== feePayer)
        return { ok: true, value: self };
    if (!checked) {
        // A bare Transfer does not carry the mint, so the asset cannot be identified
        // statically and `allowTokens` cannot be applied. Refuse rather than guess.
        return {
            ok: false,
            reason: "token Transfer does not name a mint; use TransferChecked so the policy can identify the asset",
        };
    }
    if (mint === undefined)
        return { ok: false, reason: "TransferChecked is missing its mint account" };
    const decimals = data.length >= 10 ? data[9] : undefined;
    return {
        ok: true,
        value: self,
        movement: { mint, amount, ...(decimals !== undefined ? { decimals } : {}), destination, source },
    };
}
/*
 * ── SQUADS v4 ───────────────────────────────────────────────────────────────
 * The pairing this decoder exists for.
 *
 * Coldstar bounds what the agent may sign; it cannot bound someone who has
 * stolen the session key, because that person signs with web3.js and never
 * touches this code. Squads closes exactly that gap: put the funds in a Squads
 * vault, make the session key a member with an on-chain spending limit, and the
 * program itself refuses to move more than the limit no matter who holds the key.
 *
 * For that to work, Coldstar must READ `spending_limit_use` rather than treat
 * the Squads program as opaque, and must refuse the instructions that would let
 * an agent raise its own ceiling — adding a spending limit, changing the
 * multisig config, or executing an arbitrary vault transaction. Those are the
 * privilege escalations, and they are separate instructions, so they can be
 * named and refused.
 *
 * Anchor discriminators are the first 8 bytes of sha256("global:<name>").
 */
const SQUADS_SPENDING_LIMIT_USE = [16, 57, 130, 127, 193, 20, 155, 134];
/** Squads instructions that change what the agent is allowed to do. */
const SQUADS_PRIVILEGED = [
    { disc: [11, 242, 159, 42, 86, 197, 89, 115], name: "multisig_add_spending_limit (raises the agent's own ceiling)" },
    { disc: [228, 198, 136, 111, 123, 4, 178, 113], name: "multisig_remove_spending_limit" },
    { disc: [114, 146, 244, 189, 252, 140, 36, 40], name: "config_transaction_execute (changes members or threshold)" },
    { disc: [194, 8, 161, 87, 153, 164, 25, 171], name: "vault_transaction_execute (arbitrary transfer from the vault)" },
    { disc: [220, 60, 73, 224, 30, 108, 79, 159], name: "proposal_create" },
    { disc: [154, 156, 238, 88, 131, 15, 198, 112], name: "proposal_vote" },
];
function discEquals(data, disc) {
    if (data.length < 8)
        return false;
    return disc.every((b, i) => data[i] === b);
}
/**
 * Decode `spending_limit_use`.
 *
 * Args after the 8-byte discriminator: amount u64 LE, decimals u8, memo Option<String>.
 * Accounts: [multisig, member(signer), spending_limit, vault, destination,
 *            system_program?, mint?, vault_token_account?, destination_token_account?, token_program?]
 *
 * Only a spend the SESSION KEY authorises is ours: the member at index 1 must
 * be the fee payer. The value leaves the vault rather than our wallet, which is
 * why this is counted here and not by the System or Token decoders.
 */
function decodeSquadsIx(ix, feePayer) {
    const data = ix.data;
    if (!data || data.length < 8)
        return { ok: false, reason: "squads instruction has no discriminator" };
    const privileged = SQUADS_PRIVILEGED.find((p) => discEquals(data, p.disc));
    if (privileged) {
        return { ok: false, reason: `squads ${privileged.name} — an agent must not change its own limits` };
    }
    if (!discEquals(data, SQUADS_SPENDING_LIMIT_USE)) {
        return { ok: false, reason: "unknown squads instruction" };
    }
    const amount = readU64(data, 8);
    if (amount === undefined)
        return { ok: false, reason: "squads spending_limit_use has no amount field" };
    const accounts = ix.accounts ?? [];
    const member = accounts[1]?.address;
    const destination = accounts[4]?.address;
    if (member === undefined || destination === undefined) {
        return { ok: false, reason: "squads spending_limit_use is missing accounts" };
    }
    // A spend authorised by another member is not ours to bound.
    if (member !== feePayer)
        return { ok: true, value: { programId: ix.programAddress } };
    // Anchor passes the program id in place of an absent optional account. The
    // MINT slot decides, and it must be checked FIRST: the SDK fills the
    // system_program slot even for an SPL spend, so testing that slot first reads
    // a USDC amount as lamports. A test caught exactly that.
    const isNone = (a) => a === undefined || a === ix.programAddress;
    const systemProgram = accounts[5]?.address;
    const mint = accounts[6]?.address;
    if (isNone(mint) && systemProgram === SYSTEM_PROGRAM_ID) {
        // SOL: amount is lamports leaving the vault.
        return { ok: true, value: { programId: ix.programAddress, recipient: destination, lamports: Number(amount) } };
    }
    if (!isNone(mint)) {
        const decimals = data.length >= 17 ? data[16] : undefined;
        const destinationTokenAccount = accounts[8]?.address;
        return {
            ok: true,
            value: { programId: ix.programAddress, recipient: destination },
            movement: {
                mint: mint,
                amount,
                ...(decimals !== undefined ? { decimals } : {}),
                ...(destinationTokenAccount !== undefined ? { destination: destinationTokenAccount } : {}),
            },
        };
    }
    // Neither branch identified the asset. Refusing beats guessing zero.
    return { ok: false, reason: "squads spending_limit_use: could not tell whether this moves SOL or an SPL token" };
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
function classifyOpaqueProgram(ix) {
    return { ok: true, value: { programId: ix.programAddress } };
}
/**
 * Parse a decompiled message into a TxIntent.
 *
 * Callers MUST treat `{ ok: false }` as ESCALATE. It means "this transaction
 * could not be fully accounted for", which is not the same as "it is safe".
 */
export function parseTx(message) {
    if (message.instructions.length === 0) {
        return { ok: false, reason: "transaction has no instructions" };
    }
    const instructions = [];
    const tokenMovements = [];
    let outLamports = 0n;
    for (const ix of message.instructions) {
        const decoded = ix.programAddress === SYSTEM_PROGRAM_ID
            ? decodeSystemIx(ix, message.feePayer)
            : TOKEN_PROGRAMS.has(ix.programAddress)
                ? decodeTokenIx(ix, message.feePayer)
                : ix.programAddress === SQUADS_PROGRAM_ID
                    ? decodeSquadsIx(ix, message.feePayer)
                    : classifyOpaqueProgram(ix);
        if (!decoded.ok)
            return { ok: false, reason: decoded.reason };
        instructions.push(decoded.value);
        if (decoded.value.lamports !== undefined) {
            outLamports += BigInt(decoded.value.lamports);
        }
        if (decoded.movement)
            tokenMovements.push(decoded.movement);
    }
    // Distinct destinations, in first-seen order, for the allowlist/blocklist checks.
    const recipients = [
        ...new Set(instructions
            .map((ix) => ix.recipient)
            .filter((r) => r !== undefined)),
    ];
    return {
        ok: true,
        intent: {
            instructions,
            outSol: Number(outLamports) / LAMPORTS_PER_SOL,
            recipients,
            tokenMovements,
        },
    };
}
/**
 * Seam for the real SDK. @solana/kit's `decompileTransactionMessage` yields
 * instructions shaped like `CompiledInstruction` above, so this is a shallow
 * projection rather than a second decoder — keeping the kit dependency out of
 * the security-critical path.
 */
export function fromKitTransaction(kitMessage) {
    const feePayer = typeof kitMessage.feePayer === "string" ? kitMessage.feePayer : kitMessage.feePayer.address;
    return parseTx({ feePayer, instructions: kitMessage.instructions });
}
//# sourceMappingURL=parseTx.js.map