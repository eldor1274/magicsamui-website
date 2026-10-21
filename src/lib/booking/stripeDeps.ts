// Dependencies of the Stripe hold-first flow (checkout, fulfil, release,
// sweep, status). Built for the app by runtime.ts; tests build them from the
// in-repo fakes (mock/fakeStripe.ts, mock/fakeCloudbeds.ts) and createMemoryKv.

import type { BookingConfig } from "./config.ts";
import type { CloudbedsWriter } from "./cloudbedsWrite.ts";
import type { PromoRestrictionInput, RestrictionResult } from "./cloudbedsProvider.ts";
import type { KvStore } from "./kv.ts";
import type { PaymentGateway } from "./payments/gateway.ts";
import type { StripeClient } from "./payments/stripe.ts";
import type { IsoDate } from "./types.ts";

export type AlertSeverity = "critical" | "warning" | "info";

/**
 * Sends an operational email to the owner (never to guests, never with guest
 * personal data). `key` de-duplicates repeats within a few hours.
 */
export type AlertFn = (subject: string, lines: string[], options?: { key?: string; severity?: AlertSeverity }) => Promise<void>;

export type LogFn = (message: string, data?: Record<string, unknown>) => void;

/** `promo`: the discounted rate (a promo code's or automatic) this checkout selected for the room (checked with its base row; see evaluateRestrictions). */
export type RestrictionsFn = (
  roomTypeId: string,
  rateId: string | null,
  checkIn: IsoDate,
  checkOut: IsoDate,
  adults: number,
  promo?: PromoRestrictionInput | null,
) => Promise<RestrictionResult>;

/**
 * What the hold-first flow needs whatever takes the money: holds, releases,
 * the checks before a hold and alert re-sends never touch the payment
 * provider, so they take only these.
 */
export interface CoreDeps {
  config: BookingConfig;
  writer: CloudbedsWriter;
  kv: KvStore;
  alert: AlertFn;
  log: LogFn;
  /** Live restriction check (getRatePlans); absent when availability is simulated. */
  restrictions?: RestrictionsFn;
  now?: () => number;
}

/** CoreDeps plus the Stripe client (checkout sessions, fulfil, sweep, status). */
export type StripeDeps = CoreDeps & { stripe: StripeClient };

/** CoreDeps plus the gateway of the provider that takes the money (status and abandon). */
export interface ProviderDeps {
  deps: CoreDeps;
  gw: PaymentGateway;
}

/**
 * The deps that finish a provider's payments: the active config's when it is
 * that provider, else that provider's drain; null when it has neither.
 */
export type ProviderDepsFn = (provider: PaymentGateway["provider"]) => ProviderDeps | null;

export function nowOf(deps: Pick<CoreDeps, "now">): number {
  return deps.now ? deps.now() : Date.now();
}
