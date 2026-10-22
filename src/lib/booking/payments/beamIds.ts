// The shape of Beam's ids (payment links, refunds), in a module that imports nothing (round-2 triage).
//
// lock.ts checks a Beam payment KEY with isBeamLinkId, and lock.ts is in the bundle of every Stripe route
// (abandon, sweep, the Stripe webhook): importing the check from beam.ts would put the whole Beam client
// there too. beam.ts re-exports both, so its callers keep importing from it. importGraph.test.ts pins that
// those three routes never reach beam.ts.

/** Beam's ids as we accept them in URLs, tokens, Redis keys and API paths. */
export const BEAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A Beam payment link id as we accept it in URLs, tokens and keys. */
export function isBeamLinkId(id: unknown): id is string {
  return typeof id === "string" && BEAM_ID_PATTERN.test(id);
}
