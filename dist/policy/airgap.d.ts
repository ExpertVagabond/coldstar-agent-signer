export interface ActiveInterface {
    name: string;
    address: string;
    family: string;
}
/**
 * Interfaces with a non-internal address. Loopback is ignored; link-local
 * addresses are reported, because a link-local address means a real adapter is
 * up and something could be on the other end of the cable.
 */
export declare function activeInterfaces(): ActiveInterface[];
export interface AirGapCheck {
    airGapped: boolean;
    interfaces: ActiveInterface[];
    /** Always present: what this check does not and cannot tell you. */
    caveat: string;
}
export declare function checkAirGap(): AirGapCheck;
/**
 * A human-readable summary for a CLI to print. A modern laptop enumerates
 * dozens of interfaces, so name the routable ones and count the rest: a wall of
 * link-local addresses hides the sentence that matters.
 */
export declare function describeAirGap(check: AirGapCheck): string;
//# sourceMappingURL=airgap.d.ts.map