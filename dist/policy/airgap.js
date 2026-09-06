// Coldstar Agent-Safe Signing — is this machine actually air-gapped?
//
// The most honest criticism of a software air gap is not the cryptography, it
// is the operator: people run the "offline" step on a laptop with Wi-Fi merely
// switched off in software, or on the same machine they browse from. The design
// then provides none of what it promises, and nothing tells them.
//
// So the cold-side tool checks, and refuses by default. This is a guard rail,
// not proof:
//
//   * A configured, up interface with an address means the machine has a live
//     network path. That is a reliable NEGATIVE signal, and the one worth acting on.
//   * No interfaces does NOT prove isolation. A virtual machine on a networked
//     host, a USB tether that appears later, Thunderbolt networking, or a
//     radio the OS does not enumerate all defeat it.
//
// Claiming more than that would repeat the mistake this check exists to catch.
import { networkInterfaces } from "node:os";
/**
 * Interfaces with a non-internal address. Loopback is ignored; link-local
 * addresses are reported, because a link-local address means a real adapter is
 * up and something could be on the other end of the cable.
 */
export function activeInterfaces() {
    const out = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
        for (const a of addrs ?? []) {
            if (a.internal)
                continue;
            out.push({ name, address: a.address, family: String(a.family) });
        }
    }
    return out;
}
const CAVEAT = "No active interface is not proof of isolation: a VM on a networked host, a tether attached later, " +
    "Thunderbolt networking, or a radio the OS does not enumerate would not appear here.";
export function checkAirGap() {
    const interfaces = activeInterfaces();
    return { airGapped: interfaces.length === 0, interfaces, caveat: CAVEAT };
}
/**
 * A human-readable summary for a CLI to print. A modern laptop enumerates
 * dozens of interfaces, so name the routable ones and count the rest: a wall of
 * link-local addresses hides the sentence that matters.
 */
export function describeAirGap(check) {
    if (check.airGapped)
        return `no active network interfaces. ${check.caveat}`;
    const routable = check.interfaces.filter((i) => !i.address.startsWith("fe80:") && !i.address.startsWith("169.254."));
    const shown = (routable.length > 0 ? routable : check.interfaces).slice(0, 4);
    const rest = check.interfaces.length - shown.length;
    const list = shown.map((i) => `${i.name} ${i.address}`).join(", ");
    return `THIS MACHINE HAS A LIVE NETWORK PATH: ${list}${rest > 0 ? ` and ${rest} more` : ""}`;
}
//# sourceMappingURL=airgap.js.map