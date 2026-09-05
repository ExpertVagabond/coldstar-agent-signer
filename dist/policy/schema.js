// Coldstar Agent-Safe Signing — policy types.
// The MCP layer parses a raw Solana tx into a normalized TxIntent; the pure
// policy engine (evaluate.ts) decides on the TxIntent. Keeping evaluate() off
// the raw tx makes it trivially unit-testable — which is the point, since this
// is the security-critical part.
export const LAMPORTS_PER_SOL = 1_000_000_000;
//# sourceMappingURL=schema.js.map