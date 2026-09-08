// Coldstar's air-gap wire format.
//
// Everything that crosses Coldstar's gap is wrapped the same way, by
// `build_envelope` in `src/qr.py`:
//
//   {"type":"signed_transaction","version":"1.0","data":"<base64>"}
//
// Compact separators, base64 payload, and the `mobile/` app in the same
// repository decodes exactly that. Until now a policy envelope from this package
// crossed as a bare JSON file instead, which meant the Coldstar phone app could
// not carry an agent grant even though carrying things across the gap is the one
// thing it exists to do.
//
// So a grant is now offered in the same wrapper, as a third type alongside the
// two transaction types. The payload inside is the policy envelope as canonical
// JSON, unchanged, so nothing about the signature or its verification moves.

/** Matches ENVELOPE_VERSION in Coldstar's `src/qr.py`. A string, not a number. */
export const WIRE_ENVELOPE_VERSION = "1.0";

export const WIRE_TYPE_UNSIGNED_TX = "unsigned_transaction";
export const WIRE_TYPE_SIGNED_TX = "signed_transaction";
/** New. A root-signed policy grant, which Coldstar itself has no concept of yet. */
export const WIRE_TYPE_POLICY_ENVELOPE = "policy_envelope";

export interface WireEnvelope {
  type: string;
  version: string;
  data: string;
}

export function isWireEnvelope(v: unknown): v is WireEnvelope {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return typeof e.type === "string" && typeof e.version === "string" && typeof e.data === "string";
}

/**
 * Wrap bytes for the gap. Key order and separators match Coldstar's output so a
 * decoder written against either implementation reads both.
 */
export function wrapForAirGap(payload: Uint8Array | string, type: string): string {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  return JSON.stringify({ type, version: WIRE_ENVELOPE_VERSION, data: bytes.toString("base64") });
}

/** Wrap a policy envelope object as the JSON text that crosses the gap. */
export function wrapPolicyEnvelope(envelope: unknown): string {
  return wrapForAirGap(JSON.stringify(envelope), WIRE_TYPE_POLICY_ENVELOPE);
}

/**
 * Unwrap, returning the payload bytes. The version is checked because a future
 * format change should stop here rather than surface as a confusing parse error
 * deeper in.
 */
export function unwrapFromAirGap(text: string): { type: string; data: Uint8Array } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("air-gap envelope is not JSON");
  }
  if (!isWireEnvelope(parsed)) throw new Error("not an air-gap envelope (need type, version and data)");
  if (parsed.version !== WIRE_ENVELOPE_VERSION) {
    throw new Error(`unsupported air-gap envelope version ${parsed.version}`);
  }
  return { type: parsed.type, data: Uint8Array.from(Buffer.from(parsed.data, "base64")) };
}

/** Unwrap a policy grant, refusing a wrapper that carries something else. */
export function unwrapPolicyEnvelope(text: string): unknown {
  const { type, data } = unwrapFromAirGap(text);
  if (type !== WIRE_TYPE_POLICY_ENVELOPE) {
    throw new Error(`expected a ${WIRE_TYPE_POLICY_ENVELOPE}, got ${type}`);
  }
  return JSON.parse(Buffer.from(data).toString("utf8"));
}
