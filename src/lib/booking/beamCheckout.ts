// Hold-first Beam checkout (design S4.3): the hold-first core (holdFirstCheckout.ts) with a Beam payment link as
// the payment page (payments/beamCheckoutAdapter.ts). Not wired into the checkout route yet: S4.6 calls it from
// runCheckout once the request is validated, re-quoted with the fee of the guest's method group (feePctFor) and
// refused when that group is not offered (payMethodOffered).

import { NOTHING_CHARGED, fail } from "./checkoutShared.ts";
import type { StripeCheckoutInput, StripeCheckoutResult } from "./checkoutShared.ts";
import { startHoldFirstCheckout } from "./holdFirstCheckout.ts";
import type { HoldFirstCheckoutContext } from "./holdFirstCheckout.ts";
import { beamCheckoutAdapter } from "./payments/beamCheckoutAdapter.ts";
import type { BeamGatewayDeps } from "./payments/beamGateway.ts";
import type { PayMethod } from "./types.ts";

export { beamCheckoutAdapter };

/** The core's context with the Beam gateway's deps (Beam's fetch, the 429 counter, the deadline and test seams). */
export type BeamCheckoutContext = Omit<HoldFirstCheckoutContext, "deps"> & { deps: BeamGatewayDeps };

/** The hold-first checkout with a Beam payment link of `payMethod`'s group as the payment page. */
export async function startBeamCheckout(input: StripeCheckoutInput, ctx: BeamCheckoutContext, payMethod: PayMethod): Promise<StripeCheckoutResult> {
  const beam = ctx.deps.config.beam;
  if (!beam || ctx.deps.config.provider !== "beam") {
    return fail(503, { error: "payment_unavailable", message: `Online payment is not available right now. ${NOTHING_CHARGED}` });
  }
  return startHoldFirstCheckout(input, ctx, beamCheckoutAdapter(ctx.deps, beam, { origin: ctx.origin, nowMs: ctx.nowMs, theme: input.theme, payMethod }));
}
