import { z } from "zod";
import type { Policy } from "./schema.js";
export declare const PolicySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    limits: z.ZodObject<{
        perTxSol: z.ZodNumber;
        dailySol: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        perTxSol: number;
        dailySol: number;
    }, {
        perTxSol: number;
        dailySol: number;
    }>;
    allowPrograms: z.ZodArray<z.ZodString, "many">;
    allowRecipients: z.ZodArray<z.ZodString, "many">;
    allowTokens: z.ZodArray<z.ZodString, "many">;
    blockRecipients: z.ZodArray<z.ZodString, "many">;
    escalateAboveSol: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    version: 1;
    limits: {
        perTxSol: number;
        dailySol: number;
    };
    allowPrograms: string[];
    allowRecipients: string[];
    allowTokens: string[];
    blockRecipients: string[];
    escalateAboveSol: number;
}, {
    version: 1;
    limits: {
        perTxSol: number;
        dailySol: number;
    };
    allowPrograms: string[];
    allowRecipients: string[];
    allowTokens: string[];
    blockRecipients: string[];
    escalateAboveSol: number;
}>;
/** Parse and validate a bare policy. Throws with the first problem; never returns a partial policy. */
export declare function parsePolicy(raw: unknown): Policy;
export interface PolicyEnvelope {
    version: 1;
    /** The policy the session key is bound by. */
    policy: Policy;
    /** The one session key this grant authorises (base58). */
    sessionPubkey: string;
    /** ISO-8601. */
    issuedAt: string;
    /** ISO-8601, or null for no expiry. Short grants are the point; prefer hours or days. */
    expiresAt: string | null;
    /** The cold root that signed this (base58 Ed25519 public key). */
    rootPubkey: string;
    /** Ed25519 signature over canonical({policy, sessionPubkey, issuedAt, expiresAt}), base58. */
    signature: string;
}
export declare function envelopePayload(e: Pick<PolicyEnvelope, "policy" | "sessionPubkey" | "issuedAt" | "expiresAt">): Uint8Array;
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