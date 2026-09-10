// what the solver is asked to do: value this much of this token on the origin, and pay this
// recipient in that token on the destination, by this time. amounts are base units.
export type Intent = {
    id: string;
    origin: { chainId: number; token: string; amount: bigint };
    destination: { chainId: number; token: string; recipient: string };
    // where a refund goes on the origin chain, if not to whoever sent the deposit
    refundTo: string | null;
    minAmountOut: bigint;
    deadlineMs: number;
};

// a solver can quote a deposit on any chain it can read, but it can only pay out on a chain it can
// sign and hold inventory on. those are different capabilities, and a cross-chain fill needs the
// weaker one on the origin and the stronger one on the destination: the user deposits on the origin
// and the solver pays from destination inventory, signing nothing on the origin at fill time.
//
// without this check the engine reads only destination.chainId, and a cross-chain intent prices
// byte-identically to a same-chain one, which is a payout against a deposit nothing watches for.
export function servesIntent(intent: Intent, quotable: ReadonlySet<number>, fillable: ReadonlySet<number>): boolean {
    return quotable.has(intent.origin.chainId) && fillable.has(intent.destination.chainId);
}
