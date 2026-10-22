// Hold-first Beam checkout (design S4.3): the hold-first core (holdFirstCheckout.ts) with a Beam payment link as
// the payment page (payments/beamCheckoutAdapter.ts). runCheckout (checkout.ts) calls it since S4.6, once the request
// is validated, refused when the guest's method group is not offered (payMethodOffered) and re-quoted with that
// group's fee (feePctFor). The booking summary (and so the booking token) carries the group.

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
  return startHoldFirstCheckout(
    { ...input, payMethod },
    ctx,
    beamCheckoutAdapter(ctx.deps, beam, { origin: ctx.origin, nowMs: ctx.nowMs, theme: input.theme, payMethod }),
  );
}
