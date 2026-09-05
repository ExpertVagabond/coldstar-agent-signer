// Coldstar Agent-Safe Signing — web3.js projection.
//
// Solana Agent Kit's `BaseWallet` hands us `@solana/web3.js` objects
// (`Transaction` | `VersionedTransaction`). The security-critical decoder
// (../adapter/parseTx.ts) is deliberately SDK-free, so this file is the one
// seam that knows web3.js shapes: it projects a transaction into the
// structural `DecompiledMessage` that `parseTx` understands.
//
// Fail-closed rule carried over from parseTx: anything we cannot resolve —
// an account index that points into an address-lookup table we have not
// loaded, a missing fee payer — is returned as `{ ok: false }` so the caller
// escalates instead of guessing "no value moved".
export function isVersionedTransaction(tx) {
    return "version" in tx;
}
function projectLegacy(tx) {
    const feePayer = tx.feePayer ?? tx.signatures[0]?.publicKey;
    if (!feePayer) {
        return { ok: false, reason: "legacy transaction has no fee payer" };
    }
    const instructions = tx.instructions.map((ix) => ({
        programAddress: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => ({ address: k.pubkey.toBase58() })),
        data: new Uint8Array(ix.data),
    }));
    return { ok: true, message: { feePayer: feePayer.toBase58(), instructions } };
}
function projectVersioned(tx) {
    const msg = tx.message;
    const staticKeys = msg.staticAccountKeys;
    const feePayer = staticKeys[0];
    if (!feePayer) {
        return { ok: false, reason: "versioned transaction has no static account keys" };
    }
    const instructions = [];
    for (const ix of msg.compiledInstructions) {
        const program = staticKeys[ix.programIdIndex];
        if (!program) {
            // Program addresses must be static per the v0 spec; a lookup-table
            // program index is malformed. Refuse rather than mis-attribute.
            return { ok: false, reason: `program index ${ix.programIdIndex} is not a static key` };
        }
        const accounts = [];
        for (const idx of ix.accountKeyIndexes) {
            const key = staticKeys[idx];
            if (!key) {
                // The account lives in an address lookup table. Resolving it needs an
                // RPC round-trip; without it we cannot know who receives value.
                return {
                    ok: false,
                    reason: `account index ${idx} resolves through an address lookup table (not loaded)`,
                };
            }
            accounts.push({ address: key.toBase58() });
        }
        instructions.push({
            programAddress: program.toBase58(),
            accounts,
            data: new Uint8Array(ix.data),
        });
    }
    return { ok: true, message: { feePayer: feePayer.toBase58(), instructions } };
}
/** Project a web3.js transaction into the SDK-free shape `parseTx` decodes. */
export function projectTransaction(tx) {
    return isVersionedTransaction(tx) ? projectVersioned(tx) : projectLegacy(tx);
}
//# sourceMappingURL=project.js.map