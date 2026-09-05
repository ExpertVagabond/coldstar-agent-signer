// Coldstar Agent-Safe Signing — escalation handlers.
//
// An EscalationHandler receives the still-unsigned transaction when policy says
// a human must approve. The production hand-off is a QR round-trip with the
// air-gapped Coldstar device; these helpers cover the two ends of that.

import { Transaction, VersionedTransaction } from "@solana/web3.js";
import type { EscalationHandler, SolanaTx } from "../wallet/coldstarWallet.js";

/** Always decline. The wallet then throws ColdstarEscalation with the payload. */
export const declineEscalation: EscalationHandler = async () => null;

export function serializeUnsigned(tx: SolanaTx): Uint8Array {
  return "version" in tx ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/**
 * Parse whatever the air-gapped side handed back and make sure it is the same
 * transaction (same message bytes) now carrying at least one signature.
 * Returns null if it is not.
 */
export function acceptSignedResponse<T extends SolanaTx>(original: T, signedBase64: string): T | null {
  const bytes = Uint8Array.from(Buffer.from(signedBase64.trim(), "base64"));
  try {
    if ("version" in original) {
      const back = VersionedTransaction.deserialize(bytes);
      const same = Buffer.compare(Buffer.from(back.message.serialize()), Buffer.from(original.message.serialize())) === 0;
      const signed = back.signatures.some((s) => s.some((x) => x !== 0));
      return same && signed ? (back as unknown as T) : null;
    }
    const back = Transaction.from(bytes);
    const same = Buffer.compare(back.serializeMessage(), original.serializeMessage()) === 0;
    const signed = back.signatures.some((s) => s.signature !== null);
    return same && signed ? (back as unknown as T) : null;
  } catch {
    return null;
  }
}

/**
 * Interactive terminal hand-off: print the unsigned transaction, wait for the
 * operator to paste the signed transaction (as returned by the cold device),
 * verify it is the same message, and return it. Empty input declines.
 */
export function terminalEscalation(io: {
  write: (s: string) => void;
  readLine: () => Promise<string>;
  render?: (base64: string) => void; // e.g. a QR renderer
}): EscalationHandler {
  return async (tx, reason) => {
    const unsigned = Buffer.from(serializeUnsigned(tx)).toString("base64");
    io.write(`\nESCALATE: ${reason}\nUnsigned transaction (base64) for the air-gapped device:\n${unsigned}\n`);
    io.render?.(unsigned);
    io.write("Paste the signed transaction (base64) from the device, or press Enter to decline: ");
    const line = await io.readLine();
    if (!line.trim()) return null;
    const accepted = acceptSignedResponse(tx, line);
    if (!accepted) io.write("Rejected: the pasted transaction did not match the original message or carried no signature.\n");
    return accepted;
  };
}
