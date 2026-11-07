import { z } from "zod";
import type { Policy } from "./schema.js";
export declare const PolicySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    limits: z.ZodObject<{
        perTxSol: z.ZodNumber;
        dailySol: z.ZodNumber;
    }, z.core.$strip>;
    allowPrograms: z.ZodArray<z.ZodString>;
    allowRecipients: z.ZodArray<z.ZodString>;
    allowTokens: z.ZodArray<z.ZodString>;
    tokenLimits: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        perTx: z.ZodOptional<z.ZodString>;
        daily: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    allowTokenAccounts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    blockRecipients: z.ZodArray<z.ZodString>;
    escalateAboveSol: z.ZodNumber;
}, z.core.$strict>;
/** Parse and validate a bare policy. Throws with the first problem; never returns a partial policy. */
export declare function parsePolicy(raw: unknown): Policy;
export interface PolicyEnvelope {
    /** 1: no revoker. 2: adds `revoker`, which is covered by the signature. */
    version: 1 | 2;
    /** The policy the session key is bound by. */
    policy: Policy;
    /** The one session key this grant authorises (base58). */
    sessionPubkey: string;
    /** ISO-8601. */
    issuedAt: string;
    /** ISO-8601, or null for no expiry. Short grants are the point; prefer hours or days. */
    expiresAt: string | null;
    /**
     * A hot key permitted to publish an on-chain revocation for this grant, but
     * with no spending power. Lets an operator kill a grant without opening the
     * safe. Version 2 only; covered by the signature.
     */
    revoker?: string | null;
    /** The cold root that signed this (base58 Ed25519 public key). */
    rootPubkey: string;
    /** Ed25519 signature over canonical({policy, sessionPubkey, issuedAt, expiresAt}), base58. */
    signature: string;
}
export declare function envelopePayload(e: Pick<PolicyEnvelope, "policy" | "sessionPubkey" | "issuedAt" | "expiresAt"> & {
    version?: 1 | 2;
    revoker?: string | null;
}): Uint8Array;
/**
 * Sign a policy for one session key. Meant to run on the AIR-GAPPED machine
 * holding the root secret key; the output is plain JSON that crosses the gap.
 */
export declare function signPolicyEnvelope(args: {
    rootSecretKey: Uint8Array;
    policy: Policy;
    sessionPubkey: string;
    issuedAt?: Date;
    expiresAt?: Date | null;
    /** Hot key allowed to revoke this grant on chain. Emits a version 2 envelope. */
    revoker?: string | null;
}): PolicyEnvelope;
/**
 * Build an envelope without holding the root secret key here.
 *
 * The caller supplies a function that signs the canonical payload and says which
 * public key it used. That lets the signing happen somewhere better than this
 * process: Coldstar's Rust signer holds the key in `mlock`ed memory that is
 * zeroized on drop, so with that path the plaintext key never exists in the
 * JavaScript heap at all. `signPolicyEnvelope` above is the same thing with an
 * in-process signer.
 */
export declare function buildPolicyEnvelope(args: {
    signPayload: (payload: Uint8Array) => {
        signature: string;
        rootPubkey: string;
    };
    policy: Policy;
    sessionPubkey: string;
    issuedAt?: Date;
    expiresAt?: Date | null;
    revoker?: string | null;
}): PolicyEnvelope;
export type EnvelopeCheck = {
    ok: true;
    envelope: PolicyEnvelope;
} | {
    ok: false;
    reason: string;
};
/**
 * Verify an envelope before trusting the policy inside it.
 *   expectedRoot   pin the root public key (base58). Strongly recommended: without it,
 *                  any key could have "signed" the policy.
 *   sessionPubkey  the session key this process actually holds.
 *   now            clock, for expiry.
 */
export declare function verifyPolicyEnvelope(raw: unknown, opts: {
    expectedRoot?: string;
    sessionPubkey: string;
    now?: Date;
}): EnvelopeCheck;
/** Either a bare policy (unsigned; only for tests and devnet) or a signed envelope. */
export declare function isEnvelope(raw: unknown): boolean;
//# sourceMappingURL=envelope.d.ts.map