"use client";

// OWNER: foundation. Orchestrates the booking preview: state machine
// (search -> results -> addons -> guest -> payment), sessionStorage
// persistence, browser Back between steps, focus + announcements on step
// changes, API calls, analytics and the page layout. Visual components are
// owned by the UI builders (see the OWNER line in each file) and receive
// everything through props.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { fetchAvailability, isAllowedPaymentRedirect, postAbandon, postCheckout, recallLinkToken, rememberLinkToken } from "@/lib/booking/apiClient";
import { getCatalogueRoom } from "@/lib/booking/catalogue";
import { createBookingAnalytics } from "@/lib/booking/clientAnalytics";
import { formatThbWithCode } from "@/lib/booking/format";
import { isGuestValid, normalizePostcode, validateGuest } from "@/lib/booking/guest";
import { providerCopy } from "@/lib/booking/paymentCopy";
import { computeQuote } from "@/lib/booking/quote";
import type { AbandonResponse, AddonId, AvailabilityResponse, CartItem, IsoDate, PublicBookingConfig, ThemeName } from "@/lib/booking/types";
import { allowListedSearch, returnPagePath } from "@/lib/booking/urls";
import type { ResumeReason } from "@/lib/booking/urls";
import BookingHelp from "./BookingHelp";
import BookingThemeRoot from "./BookingThemeRoot";
import { attemptMayStillBePaid, clearAttempt, readAttempt, rememberAttempt } from "./attempt";
import NoticeBar from "./NoticeBar";
import PreviewBanner from "./PreviewBanner";
import StepHeader from "./StepHeader";
import AddonsStep from "./checkout/AddonsStep";
import GuestDetailsStep from "./checkout/GuestDetailsStep";
import PaymentStep, { isPaymentPaused } from "./checkout/PaymentStep";
import SecurePaymentModal from "./checkout/SecurePaymentModal";
import ResultsList, { AvailabilityErrorCard } from "./results/ResultsList";
import SearchBar from "./search/SearchBar";
import SearchStep from "./search/SearchStep";
import {
  BookingContext,
  GUEST_FORM_ID,
  STEP_CTA,
  STEP_ORDER,
  STEP_TITLES,
  bookingReducer,
  canEnter,
  cartInputs,
  initialBookingState,
  isStep,
  newCartItemId,
  readPersistedBooking,
  searchKey,
  selectBlockedReason,
  selectMaxAdults,
  selectQuote,
  toCheckoutErrorView,
  writePersistedBooking,
} from "./state";
import type { AddRoomInput, BookingAction, BookingActions, BookingContextValue, BookingState, SearchDraft, Step } from "./state";
import MobileSummaryBar from "./summary/MobileSummaryBar";
import ReservationSummary from "./summary/ReservationSummary";
import type { SummaryCta } from "./summary/ReservationSummary";

export interface BookingAppProps {
  /** Valid prefill from ?checkin ?checkout ?adults ?promo (null when none). Applied once. */
  initialSearch: Partial<SearchDraft> | null;
  theme: ThemeName;
  /** "payment" when returning from Beam's Cancel button or the return page's "Try again". */
  resume: "payment" | null;
  /** Why the guest is back on the payment step (picks the notice copy). */
  resumeReason?: ResumeReason | null;
  /** Fingerprint of this load's one-shot URL params, so a replayed URL is never applied twice (see state.ts). */
  landingKey?: string | null;
  config: PublicBookingConfig;
  /** Today in Asia/Bangkok, computed on the server (avoids hydration drift). */
  today: IsoDate;
  /** Last selectable date (today + booking window). */
  maxDate: IsoDate;
  themeHref: Record<ThemeName, string>;
  /**
   * The Cloudbeds engine's fallback page (/booking/classic) when this page IS
   * the live /booking (BOOKING_ENGINE=own); null on the preview.
   */
  classicHref?: string | null;
  /**
   * Stripe's back link (cancel_url) landed here with this attempt's ref and
   * signed token (?resume=payment&reason=cancelled&ref&t): its Checkout
   * Session is expired and its room hold released at once (POST
   * /api/booking/abandon), and Pay waits for that. Read on the server, so an
   * App Router replay of a cleaned-up URL still has it. null otherwise.
   */
  cancelledAttempt?: { ref: string; t: string } | null;
}


const STEP_HEADING_ID = "booking-step-heading";
const SEARCH_HEADING_ID = "booking-search-title";

/** Scroll behaviour that respects the visitor's reduced-motion setting (CSS can't reach JS scrolling). */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** Total of a cart for an announcement ("Total THB 13,182.75"), or "" when it can't be priced yet. */
function totalText(state: Pick<BookingState, "results" | "cart">): string {
  const q = selectQuote(state);
  return q ? ` Total ${formatThbWithCode(q.totalSatang)}.` : "";
}

/** "4 of 11 rooms available for your dates." (+ the promo verdict) for the live region. */
function resultsAnnouncement(data: AvailabilityResponse): string {
  const bookable = data.offers.filter((o) => o.unavailableReason !== "not-bookable");
  const available = bookable.filter((o) => o.available).length;
  const promo = data.promo ? (data.promo.valid ? ` Code ${data.promo.code} applied.` : ` ${data.promo.message}`) : "";
  return `${available} of ${bookable.length} rooms available for your dates.${promo}`;
}

/** Moves keyboard focus to the current step's heading without scrolling. */
function focusStepHeading(step: Step): void {
  const el = document.getElementById(step === "search" ? SEARCH_HEADING_ID : STEP_HEADING_ID);
  el?.focus({ preventScroll: true });
}

/** This page's custom keys on a history entry (merged into the App Router's own state). */
interface StepHistoryState {
  bkStep?: unknown;
  bkIndex?: unknown;
  __NA?: unknown;
}

/**
 * Absolute index of the current session-history entry, where the Navigation
 * API exists (Chromium, recent Safari/Firefox); null elsewhere. Used only to
 * re-find our place when the App Router has rewritten an entry's state.
 */
function navigationIndex(): number | null {
  const nav = (window as Window & { navigation?: { currentEntry?: { index?: unknown } | null } }).navigation;
  const i = nav?.currentEntry?.index;
  return typeof i === "number" && Number.isInteger(i) && i >= 0 ? i : null;
}

/** Placeholder for the payment step while prices reload (reserves the space, keeps Pay disabled). */
function PaymentStepSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="space-y-3 rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card) sm:p-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 border-b border-(--bk-border) pb-3 last:border-b-0">
            <div className="h-3 w-24 animate-pulse rounded bg-(--bk-surface-sunken)" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-(--bk-surface-sunken)" />
          </div>
        ))}
        <div className="h-20 animate-pulse rounded-(--bk-radius-control) bg-(--bk-surface-sunken)" />
      </div>
      <div className="rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card) sm:p-6">
        <button
          type="button"
          disabled
          className="inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 py-3 text-base font-semibold text-(--bk-accent-contrast) opacity-(--bk-disabled-opacity)"
        >
          <LoaderCircle size={20} aria-hidden="true" className="animate-spin" />
          Updating prices…
        </button>
      </div>
    </div>
  );
}

export default function BookingApp({
  initialSearch,
  theme,
  resume,
  resumeReason = null,
  landingKey = null,
  config: initialConfig,
  today,
  maxDate,
  themeHref,
  classicHref = null,
  cancelledAttempt = null,
}: BookingAppProps) {
  const [state, dispatch] = useReducer(bookingReducer, undefined, initialBookingState);
  const [secureInfoOpen, setSecureInfoOpen] = useState(false);
  /** Stripe: an earlier checkout attempt is being expired (its room hold released) before Pay is allowed again. */
  const [releasing, setReleasing] = useState(cancelledAttempt !== null);
  const stateRef = useRef(state);
  const abortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stepCardRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);
  // Browser history of the steps (see "step changes" below).
  const lastStepRef = useRef<Step | null>(null);
  /** Step of each history entry this page created, by bkIndex (sparse after a reload). */
  const stackRef = useRef<Step[]>([]);
  const indexRef = useRef(0);
  /** The next change to `step` comes from history (popstate) or a re-hydrate: don't push for it. */
  const navRef = useRef<{ mode: "pop" | "replace"; step: Step } | null>(null);
  /** navigationIndex() - bkIndex for this page's entries (they are contiguous), when the Navigation API exists. */
  const navOffsetRef = useRef<number | null>(null);

  const availability = state.results.data;
  const config = availability?.config ?? initialConfig;
  const configRef = useRef(config);
  const analytics = useMemo(() => createBookingAnalytics(config.paymentMode), [config.paymentMode]);
  const quote = useMemo(() => selectQuote(state), [state]);
  // Stripe sells the Standard Rate only (Cloudbeds prices the reservation itself): no add-ons step.
  const addonsEnabled = config.addonsEnabled;
  const steps = useMemo(() => (addonsEnabled ? STEP_ORDER : STEP_ORDER.filter((s) => s !== "addons")), [addonsEnabled]);

  useEffect(() => {
    stateRef.current = state;
    configRef.current = config;
  });

  /** Polite screen-reader message for cart and price changes. Cleared first so a repeat is read again. */
  const announce = useCallback((message: string) => {
    const el = liveRef.current;
    if (!el) return;
    el.textContent = "";
    window.setTimeout(() => {
      el.textContent = message;
    }, 50);
  }, []);

  /**
   * Stripe: expire an earlier checkout attempt's session and release its room
   * hold (POST /api/booking/abandon). A paid or still-processing attempt is
   * never cancelled: the guest goes to its return page instead ("left").
   * "error": the earlier session could not be checked - it is kept, so the
   * next Pay asks again (Stripe's 30-minute expiry and the sweeper still
   * release that hold). The caller sets `releasing` first (Pay waits).
   */
  const finishRelease = useCallback(
    (attempt: { ref: string; t: string }, res: AbandonResponse): "continue" | "left" | "error" => {
      if (res.ok && (res.state === "paid" || res.state === "pending")) {
        window.location.assign(returnPagePath(configRef.current.bookingPath, attempt.ref, attempt.t, theme));
        return "left";
      }
      setReleasing(false);
      if (!res.ok) return "error";
      // Released, already closed or not a Stripe booking: forget it.
      clearAttempt(attempt.ref);
      return "continue";
    },
    [theme],
  );
  const releaseAttempt = useCallback(
    async (attempt: { ref: string; t: string; l: string | null }): Promise<"continue" | "left" | "error"> =>
      finishRelease(attempt, await postAbandon({ t: attempt.t, l: attempt.l })),
    [finishRelease],
  );

  /* ------------------------- hydrate + persist ------------------------- */

  useEffect(() => {
    // Stripe's back link (cancel_url) landed here: expire that session and release its hold right away
    // (`releasing` started true for it, so Pay waits for the answer).
    if (cancelledAttempt) {
      void postAbandon({ t: cancelledAttempt.t, l: recallLinkToken(cancelledAttempt.ref) }).then((res) => finishRelease(cancelledAttempt, res));
    }
    dispatch({
      type: "hydrate",
      persisted: readPersistedBooking(),
      initialSearch,
      resume,
      resumeReason,
      // Stripe: a cancelled attempt's hold is released (by this landing, or by the abandon the return page ran),
      // so the notice must never say the room is still held - with or without a token in the link.
      holdReleased: cancelledAttempt !== null || configRef.current.provider === "stripe",
      landingKey,
      today,
    });
    // The prefill (?checkin ?checkout ?adults ?promo) and the Beam cancel
    // params are one-shot: once applied they leave the address bar, so a
    // reload or a theme switch restores the guest's own (saved) choices
    // instead of replaying a stale prefill over them. (The App Router can
    // still replay the original URL from its cache on Back/Forward; the
    // persisted landingKey makes the reducer ignore it then.) The cleanup is
    // an allow-list, so the booking token and anything Beam appends to the
    // cancel URL never reach the analytics tags' page_location.
    const url = new URL(window.location.href);
    const clean = allowListedSearch(url.search);
    if (url.search !== clean) {
      window.history.replaceState(window.history.state, "", url.pathname + clean + url.hash);
    }
    // Runs once on mount: props are the server's first render values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.hydrated) writePersistedBooking(state);
  }, [state]);

  // Coming back with the browser's Back button can restore this page from the
  // back/forward cache with stale React state: "Taking you to Beam..." still
  // showing, or a cart the return page has since cleared after a successful
  // payment. Re-read the saved booking (the source of truth) instead, so a
  // paid cart can't be paid again and a fresh search runs.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      const action: BookingAction = { type: "hydrate", persisted: readPersistedBooking(), initialSearch: null, resume: null, today };
      navRef.current = { mode: "replace", step: bookingReducer(stateRef.current, action).step };
      abortRef.current?.abort();
      dispatch(action);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [today]);

  /* ------------------------------ search ------------------------------- */

  const runSearch = useCallback((draft: SearchDraft, options: { fresh?: boolean } = {}) => {
    if (!draft.checkIn || !draft.checkOut) return;
    const key = searchKey(draft);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "searchStarted", key });
    // Promos off (Beam/Stripe): never send a code left over in the saved search; the code pill is hidden.
    const promo = config.promoEnabled ? draft.promo.trim() : "";
    fetchAvailability(
      { checkIn: draft.checkIn, checkOut: draft.checkOut, adults: draft.adults, promo: promo || undefined },
      controller.signal,
      options,
    )
      .then((res) => {
        if (res.ok) {
          dispatch({ type: "searchSucceeded", key, data: res });
          announce(resultsAnnouncement(res));
        } else dispatch({ type: "searchFailed", key, message: res.message });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        dispatch({ type: "searchFailed", key, message: "Something went wrong. Please try again." });
      });
  }, [announce, config.promoEnabled]);

  // After hydration (reload, URL prefill, return from Beam) fetch fresh prices.
  const needsInitialSearch =
    state.hydrated && state.results.status === "idle" && state.step !== "search" && Boolean(state.search.checkIn && state.search.checkOut);
  useEffect(() => {
    if (needsInitialSearch) runSearch(stateRef.current.search);
  }, [needsInitialSearch, runSearch]);

  /* ------------- step changes: history, scroll, focus -------------- */
  //
  // Each step the guest moves FORWARD to gets its own history entry
  // ({ bkStep, bkIndex }), so the browser / Android Back button walks back
  // through the flow. Moving BACKWARD in the app (back arrow, Edit links, a
  // cart that emptied) never pushes: it returns to the existing entry for
  // that step (history.go) or rewrites the current one, so Back keeps going
  // back instead of bouncing forward to the step just left.

  useEffect(() => {
    if (!state.hydrated) return;
    const prev = lastStepRef.current;
    lastStepRef.current = state.step;
    const history = window.history;
    const entry = (index: number) => ({ ...history.state, bkStep: state.step, bkIndex: index });
    const syncOffset = (index: number) => {
      const ni = navigationIndex();
      navOffsetRef.current = ni === null ? null : ni - index;
    };
    if (prev === null) {
      // First render after hydrate: record the step (a reload keeps the entry's index), but don't move focus or scroll.
      const saved = (history.state as StepHistoryState | null)?.bkIndex;
      const index = typeof saved === "number" && Number.isInteger(saved) && saved >= 0 ? saved : 0;
      indexRef.current = index;
      stackRef.current = [];
      stackRef.current[index] = state.step;
      history.replaceState(entry(index), "");
      syncOffset(index);
      return;
    }
    if (prev === state.step) return;

    const nav = navRef.current;
    navRef.current = null;
    const index = indexRef.current;
    if (nav?.step === state.step && nav.mode === "pop") {
      // The browser already moved to this entry.
    } else if (nav?.step === state.step && nav.mode === "replace") {
      stackRef.current[index] = state.step;
      history.replaceState(entry(index), "");
    } else if (STEP_ORDER.indexOf(state.step) < STEP_ORDER.indexOf(prev)) {
      const earlier = index > 0 ? stackRef.current.lastIndexOf(state.step, index - 1) : -1;
      if (earlier >= 0) {
        // popstate follows; it finds the step already shown and only syncs the index.
        history.go(earlier - index);
      } else {
        stackRef.current[index] = state.step;
        history.replaceState(entry(index), "");
      }
    } else {
      const next = index + 1;
      stackRef.current.length = next;
      stackRef.current[next] = state.step;
      indexRef.current = next;
      history.pushState(entry(next), "");
      syncOffset(next);
    }
    // Bring the new step's title (not the page intro) to the top, then put
    // keyboard focus on it so keyboard and screen-reader users keep their place.
    const target = state.step === "search" ? rootRef.current : stepCardRef.current;
    target?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    asideRef.current?.scrollTo({ top: 0 });
    focusStepHeading(state.step);
  }, [state.step, state.hydrated]);

  // The App Router rewrites a history entry's state when a Back/Forward to it
  // needs a server round trip (e.g. an entry from before a reload whose URL
  // had ?checkin/?resume params): its HistoryUpdater writes only its own keys
  // ({ __NA, tree }), dropping bkStep/bkIndex. The new page props arrive in
  // that same commit, after Next's insertion effect, so this effect (no
  // dependency list: it runs after every render) puts our keys back on the
  // entry the browser is on. Without it a later visit to that entry would be
  // a dead Back and the step stack would drift from the browser's.
  useEffect(() => {
    if (!state.hydrated || lastStepRef.current === null) return;
    const st = window.history.state as StepHistoryState | null;
    if (!st || !st.__NA || st.bkStep !== undefined) return;
    const step = stateRef.current.step;
    stackRef.current[indexRef.current] = step;
    window.history.replaceState({ ...st, bkStep: step, bkIndex: indexRef.current }, "");
  });

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = e.state as StepHistoryState | null;
      if (!st) return;
      let target: unknown = st.bkStep;
      let index = typeof st.bkIndex === "number" && Number.isInteger(st.bkIndex) && st.bkIndex >= 0 ? st.bkIndex : 0;
      if (!isStep(target)) {
        // Not one of ours, or an entry the App Router rewrote (it has __NA but
        // lost bkStep/bkIndex). Re-find our place from the session-history
        // index when the browser has the Navigation API; otherwise keep the
        // current step. Either way stamp the entry so the next visit works.
        if (!st.__NA) return;
        const ni = navigationIndex();
        const offset = navOffsetRef.current;
        const guess = ni !== null && offset !== null ? ni - offset : null;
        if (guess !== null && guess >= 0) {
          index = guess;
          target = stackRef.current[guess];
        }
        if (!isStep(target)) {
          const current = stateRef.current.step;
          if (guess !== null && guess >= 0) indexRef.current = guess;
          stackRef.current[indexRef.current] = current;
          window.history.replaceState({ ...st, bkStep: current, bkIndex: indexRef.current }, "");
          return;
        }
        window.history.replaceState({ ...st, bkStep: target, bkIndex: index }, "");
      }
      const s = stateRef.current;
      indexRef.current = index;
      navRef.current = null;
      if (target === s.step) {
        stackRef.current[index] = target;
        return;
      }
      if (!canEnter(target, s)) {
        // e.g. Forward to "payment" after a guest field became invalid: stay, and make this entry say so.
        stackRef.current[index] = s.step;
        window.history.replaceState({ ...window.history.state, bkStep: s.step, bkIndex: index }, "");
        return;
      }
      stackRef.current[index] = target;
      navRef.current = { mode: "pop", step: target };
      dispatch({ type: "goToStep", step: target });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /* ------------------------------ actions ------------------------------ */

  const pay = useCallback(async () => {
    const s = stateRef.current;
    const q = selectQuote(s);
    const data = s.results.data;
    if (!q || !data || s.checkout.status === "submitting" || s.checkout.status === "redirecting") return;
    // Belt and braces: Pay is only reachable with valid guest details, consent and unlocked payments.
    if (!isGuestValid(s.guest)) {
      dispatch({ type: "goToStep", step: "guest" });
      return;
    }
    const cfg = configRef.current;
    if (cfg.paymentStatus !== "ok" || releasing) return;
    analytics.addPaymentInfo(q);
    dispatch({ type: "checkoutStarted" });
    announce(providerCopy(cfg).payAnnouncement);
    if (cfg.provider === "stripe") {
      // An earlier attempt from this tab (e.g. the guest used the browser's Back button on Stripe's page)
      // still holds the room: release it first - or, if it was paid meanwhile, show its confirmation.
      const prior = readAttempt();
      if (prior) {
        setReleasing(true);
        const released = await releaseAttempt({ ref: prior.ref, t: prior.token, l: prior.token });
        if (released === "left") return;
        if (released === "error") {
          // Never open a second payable Stripe session while the earlier one might still be paid
          // (a guest paying both would be charged twice). Once it has certainly expired, carry on.
          if (attemptMayStillBePaid(prior, Date.now())) {
            announce("Payment could not be started. Nothing was charged.");
            dispatch({
              type: "checkoutFailed",
              error: {
                code: "upstream_error",
                message:
                  "We couldn't check your earlier payment attempt just now, so we haven't started a new one - this makes sure nobody pays twice. Please try again in a minute, or message us on WhatsApp.",
              },
            });
            return;
          }
          clearAttempt(prior.ref);
        }
      }
    }
    const res = await postCheckout({
      checkIn: data.search.checkIn,
      checkOut: data.search.checkOut,
      promo: data.promo?.valid ? data.promo.code : undefined,
      items: cartInputs(s.cart),
      // What the guest was shown (the server's own quote after a price change); compared, never charged.
      expectedTotalSatang: q.totalSatang,
      expectedDueNowSatang: q.dueNowSatang,
      theme,
      // Stripe: the reservation is created in Cloudbeds before payment, so the server needs the lead guest.
      // Sent only in the request body (never in a URL); demo/Beam modes keep the details in the browser.
      ...(cfg.requiresGuestDetails ? { guest: { ...s.guest, postcode: normalizePostcode(s.guest.postcode ?? "") } } : {}),
    });
    if (res.ok) {
      if (!isAllowedPaymentRedirect(res.redirectUrl, window.location.href)) {
        announce("Payment could not be started. Nothing was charged.");
        dispatch({ type: "checkoutFailed", error: { code: "server_error", message: "Unexpected payment page address. Nothing was charged." } });
        return;
      }
      rememberLinkToken(res.ref, res.linkToken);
      if (res.provider === "stripe" && res.linkToken) rememberAttempt({ ref: res.ref, token: res.linkToken, startedAt: Date.now() });
      dispatch({ type: "checkoutRedirecting" });
      window.location.assign(res.redirectUrl);
      return;
    }
    // price_changed: the server's quote becomes the one shown and paid (state.serverQuote).
    // unavailable: the reducer drops those rooms. Either way refresh the offers, past the search cache.
    dispatch({ type: "checkoutFailed", error: toCheckoutErrorView(res), quote: res.quote });
    // Replace "Reserving your room and taking you to ..." so screen-reader users never read a stale promise.
    announce(
      res.error === "price_changed" && res.quote
        ? `The price has changed. New total ${formatThbWithCode(res.quote.totalSatang)}.`
        : res.error === "live_payments_locked"
          ? "Online payment is paused. Nothing was charged."
          : "Payment could not be started. Nothing was charged.",
    );
    // price_changed WITHOUT a quote (Stripe: Cloudbeds priced the hold differently and it was cancelled):
    // refresh once past the cache; the guest decides whether to pay again (never an automatic retry).
    if (res.error === "unavailable" || res.error === "price_changed") runSearch(s.search, { fresh: true });
  }, [analytics, announce, releaseAttempt, releasing, runSearch, theme]);

  const actions: BookingActions = useMemo(() => {
    const goToStep = (step: Step) => dispatch({ type: "goToStep", step });
    const submitGuest = () => {
      dispatch({ type: "guestSubmitted" });
      if (isGuestValid(stateRef.current.guest)) goToStep("payment");
    };
    return {
      setSearch: (patch) => dispatch({ type: "setSearch", patch }),
      search: (patch) => {
        const next = { ...stateRef.current.search, ...patch };
        if (patch) dispatch({ type: "setSearch", patch });
        runSearch(next);
      },
      addRoom: (input: AddRoomInput) => {
        const s = stateRef.current;
        if (selectBlockedReason(s, input.slug, input.adults)) return;
        const item: CartItem = { id: newCartItemId(), slug: input.slug, ratePlanId: input.ratePlanId, adults: input.adults, addonIds: [] };
        dispatch({ type: "addToCart", item });
        announce(`${getCatalogueRoom(input.slug)?.name ?? "Room"} added.${totalText({ results: s.results, cart: [...s.cart, item] })}`);
        const data = s.results.data;
        if (data) {
          try {
            const q = computeQuote(
              { checkIn: data.search.checkIn, checkOut: data.search.checkOut, items: cartInputs([item]), promo: null, pricing: data.config },
              data.offers,
            );
            analytics.addToCart(q.lines[0], q);
          } catch {
            // analytics never blocks the flow
          }
        }
      },
      removeRoom: (itemId: string) => {
        const s = stateRef.current;
        const q = selectQuote(s);
        const idx = s.cart.findIndex((c) => c.id === itemId);
        if (q && idx >= 0 && q.lines[idx]) analytics.removeFromCart(q.lines[idx], q);
        dispatch({ type: "removeFromCart", id: itemId });
        const rest = s.cart.filter((c) => c.id !== itemId);
        const name = idx >= 0 ? (getCatalogueRoom(s.cart[idx].slug)?.name ?? "Room") : "Room";
        announce(rest.length > 0 ? `${name} removed.${totalText({ results: s.results, cart: rest })}` : `${name} removed. Your reservation is empty.`);
        // Removing the last room unmounts the summary (and the sheet) that held focus.
        if (s.cart.length === 1 && idx === 0) window.requestAnimationFrame(() => focusStepHeading("results"));
      },
      toggleAddon: (itemId: string, addonId: AddonId) => {
        const s = stateRef.current;
        const item = s.cart.find((c) => c.id === itemId);
        dispatch({ type: "toggleAddon", itemId, addonId });
        if (!item) return;
        const adding = !item.addonIds.includes(addonId);
        const cart = s.cart.map((c) =>
          c.id !== itemId ? c : { ...c, addonIds: adding ? [...c.addonIds, addonId] : c.addonIds.filter((a) => a !== addonId) },
        );
        const label = addonId === "breakfast-pp" ? "Breakfast per person" : "Add-on";
        announce(`${label} ${adding ? "added" : "removed"}.${totalText({ results: s.results, cart })}`);
      },
      updateGuest: (patch) => dispatch({ type: "updateGuest", patch }),
      goToStep,
      back: () => {
        const i = steps.indexOf(stateRef.current.step);
        if (i > 0) goToStep(steps[i - 1]);
      },
      continue: () => {
        const s = stateRef.current;
        if (s.step === "results" && !configRef.current.addonsEnabled) {
          // No add-ons offered (Stripe): straight on to the guest details.
          const q = selectQuote(s);
          if (q) analytics.beginCheckout(q);
          goToStep("guest");
        } else if (s.step === "results") goToStep("addons");
        else if (s.step === "addons") {
          const q = selectQuote(s);
          if (q) analytics.beginCheckout(q);
          goToStep("guest");
        } else if (s.step === "guest") submitGuest();
        else if (s.step === "payment") void pay();
      },
      submitGuest,
      pay,
      dismissNotice: () => {
        dispatch({ type: "setNotice", notice: null });
        // The dismiss button unmounts with the notice: keep keyboard focus in the flow.
        window.setTimeout(() => focusStepHeading(stateRef.current.step), 0);
      },
      openSecurePaymentInfo: () => setSecureInfoOpen(true),
    };
  }, [analytics, announce, pay, runSearch, steps]);

  // Add-ons switched off (Stripe): a cart saved under another mode may still carry them, or the guest
  // may be on the add-ons step (reload, browser Forward). Drop them, so the summary never shows a price
  // the server would refuse, and move on to the guest details.
  useEffect(() => {
    if (!state.hydrated || addonsEnabled) return;
    for (const item of state.cart) {
      for (const addonId of item.addonIds) dispatch({ type: "toggleAddon", itemId: item.id, addonId });
    }
    if (state.step === "addons") dispatch({ type: "goToStep", step: state.cart.length > 0 ? "guest" : "results" });
  }, [state.hydrated, state.cart, state.step, addonsEnabled]);

  // Lets page-level CSS react to the step (booking.css hides the site's
  // WhatsApp button over the phone search step's Search button).
  useEffect(() => {
    if (!state.hydrated) return;
    const html = document.documentElement;
    html.dataset.bkStep = state.step;
    return () => {
      delete html.dataset.bkStep;
    };
  }, [state.step, state.hydrated]);

  const contextValue: BookingContextValue = useMemo(
    () => ({ state, dispatch, actions, config, theme, quote, availability, analytics, today }),
    [state, actions, config, theme, quote, availability, analytics, today],
  );

  /* ------------------------------- view -------------------------------- */

  const { step, search, cart, checkout } = state;
  const submitting = checkout.status === "submitting" || checkout.status === "redirecting" || releasing;
  const stayIn = availability?.search.checkIn ?? search.checkIn;
  const stayOut = availability?.search.checkOut ?? search.checkOut;
  const pricesLoading = state.results.status === "loading" || state.results.status === "idle";
  const locked = config.paymentStatus === "locked";
  // The server refused the Pay as locked after this page loaded (e.g. an emergency stop).
  const paymentPaused = isPaymentPaused(checkout.error);

  let cta: SummaryCta | null = null;
  if (step === "results" || step === "addons") {
    cta = { label: STEP_CTA[step], onClick: actions.continue, disabled: cart.length === 0 || !quote };
  } else if (step === "guest") {
    cta = { label: STEP_CTA.guest, submitForm: GUEST_FORM_ID };
  } else if (step === "payment" && quote) {
    cta = {
      label: `Pay ${formatThbWithCode(quote.dueNowSatang)}`,
      // The mobile bar shows the amount due now next to this shorter label (and in its accessible name).
      barLabel: "Pay now",
      onClick: () => void actions.pay(),
      busy: submitting,
      disabled: locked || paymentPaused,
      ...(paymentPaused ? { label: "Online payment paused", barLabel: "Payment paused" } : {}),
    };
  }

  const searchBarProps = {
    value: search,
    onChange: actions.setSearch,
    onSearch: () => actions.search(),
    busy: state.results.status === "loading",
    promoResult: availability?.promo ?? null,
    minDate: today,
    maxDate,
    maxNights: config.maxNights,
    maxAdults: config.maxSearchAdults,
    promoEnabled: config.promoEnabled,
  };

  const summary = (variant: "sidebar" | "sheet") => (
    <ReservationSummary
      variant={variant}
      quote={quote}
      cart={cart}
      checkIn={stayIn}
      checkOut={stayOut}
      cta={cta}
      onRemove={step === "payment" ? undefined : actions.removeRoom}
      onLearnMore={actions.openSecurePaymentInfo}
      loading={state.results.status === "loading"}
    />
  );

  // Position among the steps this mode shows (no add-ons step on Stripe); the add-ons step itself is
  // only ever shown when add-ons are on.
  const stepIndex = Math.max(0, steps.indexOf(step));
  const prevStep = steps[stepIndex - 1];
  // After the cart step the main column needs prices; if they can't load, say so with a way out.
  const needsPrices = step === "addons" || step === "guest" || step === "payment";
  const pricesError = needsPrices && !quote && state.results.status === "error";

  return (
    <BookingContext.Provider value={contextValue}>
      <BookingThemeRoot
        theme={theme}
        className={`rounded-(--bk-radius-card) ${cart.length > 0 ? "pb-[max(7rem,calc(var(--bk-fab-lift,0px)+1rem))] lg:pb-0" : ""}`}
      >
        {/* No scroll-margin here or on the step card: html's scroll-padding-top (booking.css) already clears the sticky header. */}
        <div ref={rootRef} className="space-y-6 p-3 sm:p-6">
          <PreviewBanner
            paymentMode={config.paymentMode}
            paymentStatus={config.paymentStatus}
            dataSource={availability?.dataSource ?? config.dataSource}
            theme={theme}
            themeHref={themeHref}
            provider={config.provider}
            cloudbedsWrites={config.cloudbedsWrites}
            whatsappUrl={config.whatsappUrl}
          />

          <header>
            <p className="text-sm uppercase tracking-[0.3em] text-(--bk-eyebrow)">
              Book direct
            </p>
            <h1 className="bk-heading mt-3 text-4xl text-(--bk-frame-text)">Book Your Stay</h1>
            <p className="mt-4 max-w-2xl text-(--bk-frame-text-muted)">
              Live availability and secure payment, booked direct with us.
            </p>
            {classicHref && (
              <p className="mt-2 text-sm text-(--bk-frame-text-muted)">
                Prefer the booking page you know?{" "}
                <a href={classicHref} rel="nofollow" className="font-medium underline underline-offset-2 hover:text-(--bk-frame-text)">
                  Use our classic booking page
                </a>
                .
              </p>
            )}
          </header>

          {/* One polite announcement per step change ("Step 3 of 5: Add-ons and Extras"). */}
          <p role="status" className="bk-sr-only">
            {state.hydrated ? `Step ${stepIndex + 1} of ${steps.length}: ${STEP_TITLES[step]}` : ""}
          </p>
          {/* Cart, add-on, price and results changes ("Sunrise Suite added. Total THB 13,182.75."), written by announce(). */}
          <p ref={liveRef} role="status" className="bk-sr-only" />
          {/* Flow notices ("Payment cancelled - nothing was charged..."): their own persistent region (present and
              empty from the server render), so the notice is read even though NoticeBar mounts already filled and
              the results announcement follows right after. */}
          <p role="status" className="bk-sr-only">
            {state.hydrated ? (state.notice?.message ?? "") : ""}
          </p>

          {state.notice && <NoticeBar notice={state.notice} onDismiss={actions.dismissNotice} />}

          {!state.hydrated ? (
            <div className="min-h-[420px]" aria-busy="true" />
          ) : step === "search" ? (
            <SearchStep {...searchBarProps} />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
              <section aria-labelledby={STEP_HEADING_ID} className="min-w-0 space-y-4">
                <div ref={stepCardRef} className="rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card)">
                  <StepHeader
                    headingId={STEP_HEADING_ID}
                    title={STEP_TITLES[step]}
                    onBack={prevStep ? actions.back : undefined}
                    backLabel={prevStep ? `Go back to ${STEP_TITLES[prevStep]}` : undefined}
                  />
                </div>

                {pricesError && (
                  <AvailabilityErrorCard
                    message={state.results.error}
                    onRetry={() => actions.search()}
                    onChangeDates={() => actions.goToStep("search")}
                  />
                )}

                {step === "results" && (
                  <>
                    <SearchBar {...searchBarProps} variant="compact" />
                    <ResultsList
                      availability={availability}
                      status={state.results.status}
                      error={state.results.error}
                      cart={cart}
                      searchAdults={search.adults}
                      blockedReason={(slug) => selectBlockedReason(state, slug)}
                      maxAdultsFor={(slug, offerMax) => selectMaxAdults(state, slug, offerMax)}
                      onAdd={actions.addRoom}
                      onRetry={() => actions.search()}
                      onChangeDates={() => actions.goToStep("search")}
                    />
                  </>
                )}

                {step === "addons" && stayIn && stayOut && (
                  <AddonsStep cart={cart} checkIn={stayIn} checkOut={stayOut} onToggleAddon={actions.toggleAddon} />
                )}

                {step === "guest" && (
                  <GuestDetailsStep
                    formId={GUEST_FORM_ID}
                    guest={state.guest}
                    errors={validateGuest(state.guest)}
                    showErrors={state.guestSubmitted}
                    onChange={actions.updateGuest}
                    onSubmit={actions.submitGuest}
                  />
                )}

                {step === "payment" &&
                  (quote && stayIn && stayOut ? (
                    <PaymentStep
                      quote={quote}
                      cart={cart}
                      guest={state.guest}
                      checkIn={stayIn}
                      checkOut={stayOut}
                      paymentMode={config.paymentMode}
                      paymentStatus={config.paymentStatus}
                      submitting={submitting}
                      error={checkout.error}
                      onPay={() => void actions.pay()}
                      onEditGuest={() => actions.goToStep("guest")}
                      onEditRooms={() => actions.goToStep("results")}
                      onEditAddons={addonsEnabled ? () => actions.goToStep("addons") : undefined}
                      onChangeDates={() => actions.goToStep("search")}
                      config={config}
                      busyLabel={releasing ? "Checking your earlier payment..." : undefined}
                    />
                  ) : (
                    !pricesError && <PaymentStepSkeleton />
                  ))}
              </section>

              {/* Capped to the viewport so a long summary (several rooms) can still scroll to its CTA while
                  sticky; the bottom 5rem stay clear of the help strip that pins itself to the bottom edge. */}
              <aside
                ref={asideRef}
                className="hidden lg:sticky lg:top-24 lg:block lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto lg:overscroll-contain lg:-m-2 lg:p-2 lg:[scrollbar-width:thin]"
                aria-label="Reservation summary"
              >
                {summary("sidebar")}
              </aside>
            </div>
          )}
        </div>

        {state.hydrated && step !== "search" && (
          <MobileSummaryBar
            // A fresh bar once the cart empties: its "View details" sheet must not reopen by itself with the next room.
            key={cart.length > 0 ? "filled" : "empty"}
            quote={quote}
            checkIn={stayIn}
            checkOut={stayOut}
            cta={cta}
            summary={summary("sheet")}
            loading={cart.length > 0 && pricesLoading}
          />
        )}
        <SecurePaymentModal open={secureInfoOpen} onClose={() => setSecureInfoOpen(false)} />
        <BookingHelp analytics={analytics} />
      </BookingThemeRoot>
    </BookingContext.Provider>
  );
}
