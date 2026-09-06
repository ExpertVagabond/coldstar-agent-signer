// Coldstar Agent-Safe Signing — the signed policy envelope.
//
// "The root signs the policy, not the transaction." This is that signature.
//
// On the air-gapped machine, the ROOT key signs a canonical encoding of
//   { policy, sessionPubkey, issuedAt, expiresAt }
// producing an envelope. The online signer loads the envelope, verifies the
// root's signature, checks that the session key it holds is the one named,
// checks expiry, and only then enforces the policy inside. A policy file that
// was edited on the online host, a session key the root never authorised, or
// an expired grant all fail closed at startup.
//
// Canonical JSON: keys sorted recursively, no whitespace, arrays in order.
// Ed25519 via tweetnacl (the same primitive Solana uses), so a Solana keypair
// is a valid root.
import nacl from "tweetnacl";
import { z } from "zod";
const bs58 = {
    ALPHABET: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
    encode(bytes) {
        let n = 0n;
        for (const b of bytes)
            n = (n << 8n) | BigInt(b);
        let out = "";
        while (n > 0n) {
            out = this.ALPHABET[Number(n % 58n)] + out;
            n /= 58n;
        }
        for (const b of bytes) {
            if (b !== 0)
                break;
            out = "1" + out;
        }
        return out || "1";
    },
    decode(s) {
        let n = 0n;
        for (const c of s) {
            const i = this.ALPHABET.indexOf(c);
            if (i < 0)
                throw new Error(`invalid base58 character '${c}'`);
            n = n * 58n + BigInt(i);
        }
        const bytes = [];
        while (n > 0n) {
            bytes.unshift(Number(n & 0xffn));
            n >>= 8n;
        }
        for (const c of s) {
            if (c !== "1")
                break;
            bytes.unshift(0);
        }
        return Uint8Array.from(bytes);
    },
};
export const PolicySchema = z.object({
    version: z.literal(1),
    limits: z.object({ perTxSol: z.number().nonnegative(), dailySol: z.number().nonnegative() }),
    allowPrograms: z.array(z.string().min(32).max(44)),
    allowRecipients: z.array(z.string().min(32).max(44)),
    allowTokens: z.array(z.string()),
    tokenLimits: z.record(z.string(), z.object({ perTx: z.string().optional(), daily: z.string().optional() }).strict()).optional(),
    allowTokenAccounts: z.array(z.string().min(32).max(44)).optional(),
    blockRecipients: z.array(z.string().min(32).max(44)),
    escalateAboveSol: z.number().nonnegative(),
}).strict();
/** Parse and validate a bare policy. Throws with the first problem; never returns a partial policy. */
export function parsePolicy(raw) {
    const r = PolicySchema.safeParse(raw);
    if (!r.success) {
        const first = r.error.issues[0];
        throw new Error(`policy invalid at ${first?.path.join(".") || "<root>"}: ${first?.message}`);
    }
    // Rebuild rather than cast: under exactOptionalPropertyTypes an absent optional
    // and one set to undefined are different types, and zod produces the latter.
    const { tokenLimits, allowTokenAccounts, ...rest } = r.data;
    return {
        ...rest,
        ...(tokenLimits ? { tokenLimits } : {}),
        ...(allowTokenAccounts ? { allowTokenAccounts } : {}),
    };
}
const EnvelopeSchema = z.object({
    version: z.union([z.literal(1), z.literal(2)]),
    policy: PolicySchema,
    sessionPubkey: z.string().min(32).max(44),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    revoker: z.string().min(32).max(44).nullable().optional(),
    rootPubkey: z.string().min(32).max(44),
    signature: z.string().min(80).max(96),
}).strict();
function canonical(v) {
    if (Array.isArray(v))
        return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") {
        const o = v;
        return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
    }
    return JSON.stringify(v);
}
export function envelopePayload(e) {
    const base = { policy: e.policy, sessionPubkey: e.sessionPubkey, issuedAt: e.issuedAt, expiresAt: e.expiresAt };
    // Version 1 envelopes were signed over these four fields only; adding a field
    // to their payload would invalidate every grant already issued.
    const payload = (e.version ?? 1) === 2 ? { ...base, revoker: e.revoker ?? null } : base;
    return new TextEncoder().encode(canonical(payload));
}
/**
 * Sign a policy for one session key. Meant to run on the AIR-GAPPED machine
 * holding the root secret key; the output is plain JSON that crosses the gap.
 */
export function signPolicyEnvelope(args) {
    const policy = parsePolicy(args.policy);
    const issuedAt = (args.issuedAt ?? new Date()).toISOString();
    const expiresAt = args.expiresAt === undefined ? null : args.expiresAt === null ? null : args.expiresAt.toISOString();
    const kp = nacl.sign.keyPair.fromSecretKey(args.rootSecretKey);
    const version = args.revoker === undefined ? 1 : 2;
    const revoker = args.revoker ?? null;
    const payload = envelopePayload({ version, policy, sessionPubkey: args.sessionPubkey, issuedAt, expiresAt, revoker });
    const sig = nacl.sign.detached(payload, kp.secretKey);
    return {
        version,
        policy,
        sessionPubkey: args.sessionPubkey,
        issuedAt,
        expiresAt,
        ...(version === 2 ? { revoker } : {}),
        rootPubkey: bs58.encode(kp.publicKey),
        signature: bs58.encode(sig),
    };
}
/**
 * Verify an envelope before trusting the policy inside it.
 *   expectedRoot   pin the root public key (base58). Strongly recommended: without it,
 *                  any key could have "signed" the policy.
 *   sessionPubkey  the session key this process actually holds.
 *   now            clock, for expiry.
 */
export function verifyPolicyEnvelope(raw, opts) {
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return { ok: false, reason: `envelope invalid at ${first?.path.join(".") || "<root>"}: ${first?.message}` };
    }
    const e = parsed.data;
    if (opts.expectedRoot && e.rootPubkey !== opts.expectedRoot) {
        return { ok: false, reason: `envelope signed by ${e.rootPubkey}, expected root ${opts.expectedRoot}` };
    }
    if (e.sessionPubkey !== opts.sessionPubkey) {
        return { ok: false, reason: `envelope authorises session ${e.sessionPubkey}, but this signer holds ${opts.sessionPubkey}` };
    }
    const now = opts.now ?? new Date();
    if (e.expiresAt && new Date(e.expiresAt).getTime() <= now.getTime()) {
        return { ok: false, reason: `envelope expired at ${e.expiresAt}` };
    }
    if (new Date(e.issuedAt).getTime() > now.getTime() + 5 * 60_000) {
        return { ok: false, reason: `envelope issuedAt ${e.issuedAt} is in the future` };
    }
    let root, sig;
    try {
        root = bs58.decode(e.rootPubkey);
        sig = bs58.decode(e.signature);
    }
    catch (err) {
        return { ok: false, reason: `envelope encoding: ${err.message}` };
    }
    if (root.length !== 32 || sig.length !== 64) {
        return { ok: false, reason: "envelope key or signature has the wrong length" };
    }
    if (e.version === 1 && e.revoker != null) {
        return { ok: false, reason: "version 1 envelope carries a revoker, which its signature does not cover; re-sign as version 2" };
    }
    if (!nacl.sign.detached.verify(envelopePayload(e), sig, root)) {
        return { ok: false, reason: "envelope signature does not verify: the policy was altered or signed by a different key" };
    }
    return { ok: true, envelope: e };
}
/** Either a bare policy (unsigned; only for tests and devnet) or a signed envelope. */
export function isEnvelope(raw) {
    return !!raw && typeof raw === "object" && "signature" in raw && "rootPubkey" in raw;
}
//# sourceMappingURL=envelope.js.map