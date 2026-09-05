// Coldstar Agent-Safe Signing — the wallet an agent framework actually holds.
//
// `ColdstarWallet` is structurally compatible with Solana Agent Kit's
// `BaseWallet` (publicKey, signTransaction, signAllTransactions,
// signAndSendTransaction, sendTransaction, signMessage), so it drops in where
// `KeypairWallet` would. The difference is what happens inside `sign*`:
//
//   tx ──project──▶ DecompiledMessage ──parseTx──▶ TxIntent ──evaluate──▶
//        AUTO_SIGN  → sign with the SESSION key (never the root)
//        ESCALATE   → hand the unsigned tx to the escalation handler (air-gap/QR);
//                     default handler throws ColdstarEscalation — no signature
//        REJECT     → throw ColdstarRejected — no signature, ever
//
// A parse or projection failure is treated as ESCALATE, per parseTx's contract:
// "could not be accounted for" is not "safe".
//
// Nothing here imports Solana Agent Kit. The interface is copied structurally
// so this package has no dependency on the framework and works with any
// caller that speaks web3.js transactions.
import { Connection, VersionedTransaction, } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "../policy/schema.js";
import nacl from "tweetnacl";
import { evaluate } from "../policy/evaluate.js";
import { parseTx } from "../adapter/parseTx.js";
import { isVersionedTransaction, projectTransaction } from "./project.js";
import { SYSTEM_PROGRAM_ID } from "../adapter/parseTx.js";
import { verifyPolicyEnvelope } from "../policy/envelope.js";
export class InMemorySpendLedger {
    now;
    day = utcDay();
    spent = 0;
    constructor(now = () => new Date()) {
        this.now = now;
    }
    get() {
        this.roll();
        return { dailySpentSol: this.spent };
    }
    add(sol) {
        this.roll();
        this.spent += sol;
    }
    roll() {
        const d = utcDay(this.now());
        if (d !== this.day) {
            this.day = d;
            this.spent = 0;
        }
    }
}
function utcDay(d = new Date()) {
    return d.toISOString().slice(0, 10);
}
export class ColdstarRejected extends Error {
    reason;
    intent;
    name = "ColdstarRejected";
    decision = "REJECT";
    constructor(reason, intent) {
        super(`Coldstar policy REJECT: ${reason}`);
        this.reason = reason;
        this.intent = intent;
    }
}
export class ColdstarEscalation extends Error {
    reason;
    intent;
    unsignedTxBase64;
    name = "ColdstarEscalation";
    decision = "ESCALATE";
    constructor(reason, intent, 
    /** base64 of the UNSIGNED transaction, for the air-gapped hand-off (QR). */
    unsignedTxBase64) {
        super(`Coldstar policy ESCALATE: ${reason}`);
        this.reason = reason;
        this.intent = intent;
        this.unsignedTxBase64 = unsignedTxBase64;
    }
}
export class ColdstarWallet {
    publicKey;
    /** Set when the wallet was built from a root-signed envelope. */
    envelope;
    policy;
    session;
    rpcUrl;
    ledger;
    onEscalate;
    allowMessageSigning;
    onDecision;
    preflight;
    /**
     * Build a wallet from a ROOT-SIGNED policy envelope. Verifies the root's
     * signature, that the envelope names this session key, and expiry, and
     * throws otherwise: an edited policy or an unauthorised session key never
     * gets a running signer. Pin `expectedRoot` in anything beyond a demo.
     */
    static fromEnvelope(opts) {
        const check = verifyPolicyEnvelope(opts.envelope, {
            sessionPubkey: opts.session.publicKey.toBase58(),
            ...(opts.expectedRoot ? { expectedRoot: opts.expectedRoot } : {}),
            ...(opts.now ? { now: opts.now } : {}),
        });
        if (!check.ok)
            throw new Error(`Coldstar: refusing to start — ${check.reason}`);
        const { envelope: _e, expectedRoot: _r, now: _n, ...rest } = opts;
        return new ColdstarWallet({ ...rest, policy: check.envelope.policy }, check.envelope);
    }
    constructor(opts, envelope) {
        this.envelope = envelope;
        this.policy = opts.policy;
        this.session = opts.session;
        this.publicKey = opts.session.publicKey;
        this.rpcUrl = opts.rpcUrl;
        this.ledger = opts.ledger ?? new InMemorySpendLedger();
        this.onEscalate = opts.onEscalate ?? defaultEscalate;
        this.allowMessageSigning = opts.allowMessageSigning ?? false;
        this.onDecision = opts.onDecision;
        this.preflight = opts.preflight;
    }
    /**
     * Evaluate without signing. Pure with respect to the ledger (reads only).
     * Exposed so an agent can pre-flight a plan and so tests can assert on it.
     */
    verdict(tx, extraSpendSol = 0) {
        const projected = projectTransaction(tx);
        if (!projected.ok)
            return { decision: "ESCALATE", reason: projected.reason, intent: undefined };
        const parsed = parseTx(projected.message);
        if (!parsed.ok)
            return { decision: "ESCALATE", reason: parsed.reason, intent: undefined };
        const state = this.ledger.get();
        const r = evaluate(parsed.intent, this.policy, {
            dailySpentSol: state.dailySpentSol + extraSpendSol,
        });
        return { decision: r.decision, reason: r.reason, intent: parsed.intent };
    }
    /** SOL signed so far in the current UTC day, per the ledger. */
    dailySpentSol() {
        return this.ledger.get().dailySpentSol;
    }
    /**
     * The full evaluation `sign*` uses: the static verdict, plus simulation-based
     * accounting when `preflight` is configured. The returned intent carries the
     * EFFECTIVE outSol (max of static and simulated), which is what the ledger
     * records on AUTO_SIGN.
     */
    async evaluateTx(tx, extraSpendSol = 0) {
        const v = this.verdict(tx, extraSpendSol);
        if (!this.preflight || v.decision === "REJECT" || !v.intent)
            return v;
        const opaque = v.intent.instructions.some((ix) => ix.programId !== SYSTEM_PROGRAM_ID);
        if ((this.preflight.when ?? "opaque") === "opaque" && !opaque)
            return v;
        const vtx = isVersionedTransaction(tx) ? tx : new VersionedTransaction(tx.compileMessage());
        const sim = await this.preflight.simulate(vtx, this.publicKey).catch((e) => ({
            ok: false,
            reason: `simulator threw: ${e.message ?? String(e)}`,
        }));
        if (!sim.ok) {
            return { decision: "ESCALATE", reason: `simulation failed: ${sim.reason}`, intent: v.intent };
        }
        const simulatedSol = Number(sim.debitLamports) / LAMPORTS_PER_SOL;
        if (simulatedSol <= v.intent.outSol)
            return v; // static accounting already covers it
        const intent = { ...v.intent, outSol: simulatedSol };
        const state = this.ledger.get();
        const r = evaluate(intent, this.policy, { dailySpentSol: state.dailySpentSol + extraSpendSol });
        return { decision: r.decision, reason: `${r.reason} (simulated debit ${simulatedSol} SOL)`, intent };
    }
    async signTransaction(transaction) {
        const [signed] = await this.signAllTransactions([transaction]);
        return signed;
    }
    /**
     * Batch semantics: every transaction is evaluated first, with the daily cap
     * accumulating across the batch, and NOTHING is signed if any one of them is
     * REJECTED. Escalations are handled per transaction after the batch clears.
     */
    async signAllTransactions(transactions) {
        // Idempotence: a transaction that already carries a valid session signature over
        // its current message bytes is returned as-is — not re-evaluated, not re-counted.
        // Re-signing identical bytes creates no new spending power, so a retry loop that
        // calls signTransaction twice must not drain the daily cap twice.
        const fresh = transactions.filter((tx) => !this.alreadySignedBySession(tx));
        const verdicts = [];
        let pending = 0;
        for (const tx of fresh) {
            const v = await this.evaluateTx(tx, pending);
            verdicts.push(v);
            if (v.decision === "AUTO_SIGN")
                pending += v.intent?.outSol ?? 0;
        }
        const rejected = verdicts.find((v) => v.decision === "REJECT");
        if (rejected) {
            this.onDecision?.(rejected);
            throw new ColdstarRejected(rejected.reason, rejected.intent);
        }
        const out = [];
        let vi = 0;
        for (let i = 0; i < transactions.length; i++) {
            const tx = transactions[i];
            if (!fresh.includes(tx)) {
                out.push(tx); // already signed by us; pass through
                continue;
            }
            const v = verdicts[vi++];
            this.onDecision?.(v);
            if (v.decision === "AUTO_SIGN") {
                this.signWithSession(tx);
                this.ledger.add(v.intent?.outSol ?? 0);
                out.push(tx);
                continue;
            }
            // ESCALATE
            const approved = await this.onEscalate(tx, v.reason, v.intent);
            if (approved === null) {
                throw new ColdstarEscalation(v.reason, v.intent, serializeUnsigned(tx));
            }
            // A human approved it on the cold side; count the spend, pass it through.
            this.ledger.add(v.intent?.outSol ?? 0);
            out.push(approved);
        }
        return out;
    }
    async sendTransaction(transaction) {
        const { signature } = await this.signAndSendTransaction(transaction);
        return signature;
    }
    async signAndSendTransaction(transaction, options) {
        const signed = await this.signTransaction(transaction);
        const connection = new Connection(this.rpcUrl);
        const signature = await connection.sendRawTransaction(signed.serialize(), options);
        return { signature };
    }
    async signMessage(message) {
        if (!this.allowMessageSigning) {
            const reason = "off-chain message signing is disabled by policy (allowMessageSigning=false)";
            this.onDecision?.({ decision: "REJECT", reason, intent: undefined });
            throw new ColdstarRejected(reason, undefined);
        }
        return nacl.sign.detached(message, this.session.secretKey);
    }
    /** True if `tx` already carries a valid signature by the session key over its current message. */
    alreadySignedBySession(tx) {
        const pub = this.session.publicKey;
        if (isVersionedTransaction(tx)) {
            const keys = tx.message.staticAccountKeys;
            const n = tx.message.header.numRequiredSignatures;
            for (let i = 0; i < n; i++) {
                if (keys[i]?.equals(pub)) {
                    const sig = tx.signatures[i];
                    return !!sig && sig.some((b) => b !== 0) && nacl.sign.detached.verify(tx.message.serialize(), sig, pub.toBytes());
                }
            }
            return false;
        }
        const entry = tx.signatures.find((s) => s.publicKey.equals(pub));
        if (!entry || !entry.signature)
            return false;
        return nacl.sign.detached.verify(tx.serializeMessage(), entry.signature, pub.toBytes());
    }
    signWithSession(tx) {
        if (isVersionedTransaction(tx))
            tx.sign([this.session]);
        else
            tx.partialSign(this.session);
    }
}
const defaultEscalate = async () => null;
function serializeUnsigned(tx) {
    const bytes = isVersionedTransaction(tx)
        ? tx.serialize()
        : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return base64(bytes);
}
// Dependency-free base64 so this file needs neither Node's Buffer nor the DOM lib.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
        const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
        out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
        out += b === undefined ? "=" : B64.charAt((n >> 6) & 63);
        out += c === undefined ? "=" : B64.charAt(n & 63);
    }
    return out;
}
//# sourceMappingURL=coldstarWallet.js.map