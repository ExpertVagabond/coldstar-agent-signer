// Coldstar Agent-Safe Signing — persistent spend ledger.
//
// The daily cap is only a cap if it survives a process restart. An agent that
// can crash and relaunch itself (or be relaunched by a supervisor) would
// otherwise get a fresh 0 every time. FileSpendLedger keeps {day, spent} in a
// small JSON file, written atomically (temp file + rename) so a crash mid-write
// leaves the previous state intact.
//
// Fail-closed: an unreadable or malformed ledger file throws instead of
// silently starting from 0. Delete the file deliberately if you mean to reset.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
function utcDay(d) {
    return d.toISOString().slice(0, 10);
}
export class FileSpendLedger {
    path;
    now;
    state;
    constructor(path, now = () => new Date()) {
        this.path = path;
        this.now = now;
        this.state = this.load();
    }
    get() {
        this.roll();
        return { dailySpentSol: this.state.spentSol, dailySpentByMint: { ...(this.state.spentByMint ?? {}) } };
    }
    add(sol) {
        if (!(sol >= 0) || !Number.isFinite(sol))
            throw new Error(`ledger: refusing to record ${sol}`);
        this.roll();
        this.state.spentSol += sol;
        this.persist();
    }
    addToken(mint, baseUnits) {
        if (baseUnits < 0n)
            throw new Error(`ledger: refusing to record ${baseUnits} of ${mint}`);
        this.roll();
        const by = (this.state.spentByMint ??= {});
        by[mint] = (BigInt(by[mint] ?? "0") + baseUnits).toString();
        this.persist();
    }
    roll() {
        const day = utcDay(this.now());
        if (day !== this.state.day) {
            this.state = { version: 1, day, spentSol: 0, spentByMint: {}, updatedAt: this.now().toISOString() };
            this.persist();
        }
    }
    load() {
        if (!existsSync(this.path)) {
            const fresh = { version: 1, day: utcDay(this.now()), spentSol: 0, updatedAt: this.now().toISOString() };
            return fresh;
        }
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(this.path, "utf8"));
        }
        catch (e) {
            throw new Error(`ledger: ${this.path} is not valid JSON (${e.message}). Refusing to start from 0; delete it deliberately to reset.`);
        }
        const p = parsed;
        if (!p || p.version !== 1 || typeof p.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.day) ||
            typeof p.spentSol !== "number" || !Number.isFinite(p.spentSol) || p.spentSol < 0) {
            throw new Error(`ledger: ${this.path} has an unexpected shape. Refusing to start from 0; delete it deliberately to reset.`);
        }
        const byMint = {};
        for (const [k, v] of Object.entries(p.spentByMint ?? {})) {
            if (typeof v !== "string" || !/^\d+$/.test(v)) {
                throw new Error(`ledger: ${this.path} has a non-integer amount for mint ${k}. Refusing to start; delete it deliberately to reset.`);
            }
            byMint[k] = v;
        }
        return { version: 1, day: p.day, spentSol: p.spentSol, spentByMint: byMint, updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "" };
    }
    persist() {
        this.state.updatedAt = this.now().toISOString();
        const tmp = join(dirname(this.path), `.${Date.now()}.${process.pid}.ledger.tmp`);
        const fd = openSync(tmp, "w", 0o600);
        try {
            writeSync(fd, JSON.stringify(this.state, null, 2) + "\n");
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, this.path);
    }
}
//# sourceMappingURL=ledger.js.map