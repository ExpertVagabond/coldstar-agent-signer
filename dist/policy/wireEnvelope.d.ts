/** Matches ENVELOPE_VERSION in Coldstar's `src/qr.py`. A string, not a number. */
export declare const WIRE_ENVELOPE_VERSION = "1.0";
export declare const WIRE_TYPE_UNSIGNED_TX = "unsigned_transaction";
export declare const WIRE_TYPE_SIGNED_TX = "signed_transaction";
/** New. A root-signed policy grant, which Coldstar itself has no concept of yet. */
export declare const WIRE_TYPE_POLICY_ENVELOPE = "policy_envelope";
export interface WireEnvelope {
    type: string;
    version: string;
    data: string;
}
export declare function isWireEnvelope(v: unknown): v is WireEnvelope;
/**
 * Wrap bytes for the gap. Key order and separators match Coldstar's output so a
 * decoder written against either implementation reads both.
 */
export declare function wrapForAirGap(payload: Uint8Array | string, type: string): string;
/** Wrap a policy envelope object as the JSON text that crosses the gap. */
export declare function wrapPolicyEnvelope(envelope: unknown): string;
/**
 * Unwrap, returning the payload bytes. The version is checked because a future
 * format change should stop here rather than surface as a confusing parse error
 * deeper in.
 */
export declare function unwrapFromAirGap(text: string): {
    type: string;
    data: Uint8Array;
};
/** Unwrap a policy grant, refusing a wrapper that carries something else. */
export declare function unwrapPolicyEnvelope(text: string): unknown;
//# sourceMappingURL=wireEnvelope.d.ts.map