"use client";

// OWNER: foundation. Orchestrates the booking preview: state machine
// (search -> results -> addons -> guest -> payment), sessionStorage
// persistence, browser Back between steps, API calls, analytics and the page
// layout. Visual components are owned by the UI builders (see the OWNER line
// in each file) and receive everything through props.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import BookingHelpStrip from "@/components/BookingHelpStrip";
import { fetchAvailability, postCheckout, rememberLinkToken } from "@/lib/booking/apiClient";
import { createBookingAnalytics } from "@/lib/booking/clientAnalytics";
import { formatThbWithCode } from "@/lib/booking/format";
import { isGuestValid, validateGuest } from "@/lib/booking/guest";
import { computeQuote } from "@/lib/booking/quote";
import type { AddonId, IsoDate, PublicBookingConfig, ThemeName } from "@/lib/booking/types";
import BookingThemeRoot from "./BookingThemeRoot";
import NoticeBar from "./NoticeBar";
import PreviewBanner from "./PreviewBanner";
import StepHeader from "./StepHeader";
import AddonsStep from "./checkout/AddonsStep";
import GuestDetailsStep from "./checkout/GuestDetailsStep";
import PaymentStep from "./checkout/PaymentStep";
import SecurePaymentModal from "./checkout/SecurePaymentModal";
import ResultsList from "./results/ResultsList";
import SearchBar from "./search/SearchBar";
import SearchStep from "./search/SearchStep";
import {
  BookingContext,
  GUEST_FORM_ID,
  STEP_CTA,
  STEP_ORDER,
  STEP_TITLES,
  bookingReducer,
  cartInputs,
  initialBookingState,
  newCartItemId,
  readPersistedBooking,
  searchKey,
  selectBlockedReason,
  selectQuote,
  toCheckoutErrorView,
  writePersistedBooking,
} from "./state";
import type { AddRoomInput, BookingActions, BookingContextValue, SearchDraft, Step } from "./state";
import MobileSummaryBar from "./summary/MobileSummaryBar";
import ReservationSummary from "./summary/ReservationSummary";
import type { SummaryCta } from "./summary/ReservationSummary";

export interface BookingAppProps {
  /** Valid prefill from ?checkin ?checkout ?adults ?promo (null when none). */
  initialSearch: Partial<SearchDraft> | null;
  theme: ThemeName;
  /** "payment" when returning from Beam's Cancel button. */
  resume: "payment" | null;
  config: PublicBookingConfig;
  /** Today in Asia/Bangkok, computed on the server (avoids hydration drift). */
  today: IsoDate;
  /** Last selectable date (today + booking window). */
  maxDate: IsoDate;
  themeHref: Record<ThemeName, string>;
}

function isStep(v: unknown): v is Step {
  return typeof v === "string" && (STEP_ORDER as string[]).includes(v);
}

/** Only follow redirects to our own origin or Beam's hosted pages. */
function isSafeRedirect(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    if (u.origin === window.location.origin) return true;
    return u.protocol === "https:" && (u.host === "pay.beamcheckout.com" || u.host === "playground-pay.beamcheckout.com");
  } catch {
    return false;
  }
}

export default function BookingApp({ initialSearch, theme, resume, config: initialConfig, today, maxDate, themeHref }: BookingAppProps) {
  const [state, dispatch] = useReducer(bookingReducer, undefined, initialBookingState);
  const [secureInfoOpen, setSecureInfoOpen] = useState(false);
  const stateRef = useRef(state);
  const abortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  const availability = state.results.data;
  const config = availability?.config ?? initialConfig;
  const analytics = useMemo(() => createBookingAnalytics(config.paymentMode), [config.paymentMode]);
  const quote = useMemo(() => selectQuote(state), [state]);

  useEffect(() => {
    stateRef.current = state;
  });

  /* ------------------------- hydrate + persist ------------------------- */

  useEffect(() => {
    dispatch({ type: "hydrate", persisted: readPersistedBooking(), initialSearch, resume, today });
    // Strip one-off params (cancel URL ref/token, resume) from the address bar.
    const url = new URL(window.location.href);
    if (url.searchParams.has("resume") || url.searchParams.has("t") || url.searchParams.has("ref")) {
      url.searchParams.delete("resume");
      url.searchParams.delete("t");
      url.searchParams.delete("ref");
      window.history.replaceState(window.history.state, "", url.pathname + (url.search || "") + url.hash);
    }
    // Runs once on mount: props are the server's first render values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.hydrated) writePersistedBooking(state);
  }, [state]);

  /* ------------------------------ search ------------------------------- */

  const runSearch = useCallback((draft: SearchDraft) => {
    if (!draft.checkIn || !draft.checkOut) return;
    const key = searchKey(draft);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "searchStarted", key });
    const promo = draft.promo.trim();
    fetchAvailability(
      { checkIn: draft.checkIn, checkOut: draft.checkOut, adults: draft.adults, promo: promo || undefined },
      controller.signal,
    )
      .then((res) => {
        if (res.ok) dispatch({ type: "searchSucceeded", key, data: res });
        else dispatch({ type: "searchFailed", key, message: res.message });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        dispatch({ type: "searchFailed", key, message: "Something went wrong. Please try again." });
      });
  }, []);

  // After hydration (reload, URL prefill, return from Beam) fetch fresh prices.
  const needsInitialSearch =
    state.hydrated && state.results.status === "idle" && state.step !== "search" && Boolean(state.search.checkIn && state.search.checkOut);
  useEffect(() => {
    if (needsInitialSearch) runSearch(stateRef.current.search);
  }, [needsInitialSearch, runSearch]);

  /* ----------------------- browser Back / Forward ---------------------- */

  const lastStepRef = useRef<Step | null>(null);
  const poppedStepRef = useRef<Step | null>(null);

  useEffect(() => {
    if (!state.hydrated) return;
    const prev = lastStepRef.current;
    lastStepRef.current = state.step;
    if (prev === null) {
      window.history.replaceState({ ...window.history.state, bkStep: state.step }, "");
      return;
    }
    if (prev === state.step) return;
    if (poppedStepRef.current === state.step) {
      poppedStepRef.current = null;
    } else {
      window.history.pushState({ ...window.history.state, bkStep: state.step }, "");
    }
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    asideRef.current?.scrollTo({ top: 0 });
  }, [state.step, state.hydrated]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const target = (e.state as { bkStep?: unknown } | null)?.bkStep;
      if (!isStep(target)) return;
      poppedStepRef.current = target;
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
    analytics.addPaymentInfo(q);
    dispatch({ type: "checkoutStarted" });
    const res = await postCheckout({
      checkIn: data.search.checkIn,
      checkOut: data.search.checkOut,
      promo: data.promo?.valid ? data.promo.code : undefined,
      items: cartInputs(s.cart),
      expectedTotalSatang: q.totalSatang,
    });
    if (res.ok) {
      if (!isSafeRedirect(res.redirectUrl)) {
        dispatch({ type: "checkoutFailed", error: { code: "server_error", message: "Unexpected payment page address. Nothing was charged." } });
        return;
      }
      rememberLinkToken(res.ref, res.linkToken);
      dispatch({ type: "checkoutRedirecting" });
      window.location.assign(res.redirectUrl);
      return;
    }
    dispatch({ type: "checkoutFailed", error: toCheckoutErrorView(res) });
    if (res.error === "unavailable" || res.error === "price_changed") runSearch(s.search);
  }, [analytics, runSearch]);

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
        if (selectBlockedReason(s, input.slug)) return;
        const item = { id: newCartItemId(), slug: input.slug, ratePlanId: input.ratePlanId, adults: input.adults, addonIds: [] };
        dispatch({ type: "addToCart", item });
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
      },
      toggleAddon: (itemId: string, addonId: AddonId) => dispatch({ type: "toggleAddon", itemId, addonId }),
      updateGuest: (patch) => dispatch({ type: "updateGuest", patch }),
      goToStep,
      back: () => {
        const i = STEP_ORDER.indexOf(stateRef.current.step);
        if (i > 0) goToStep(STEP_ORDER[i - 1]);
      },
      continue: () => {
        const s = stateRef.current;
        if (s.step === "results") goToStep("addons");
        else if (s.step === "addons") {
          const q = selectQuote(s);
          if (q) analytics.beginCheckout(q);
          goToStep("guest");
        } else if (s.step === "guest") submitGuest();
        else if (s.step === "payment") void pay();
      },
      submitGuest,
      pay,
      dismissNotice: () => dispatch({ type: "setNotice", notice: null }),
      openSecurePaymentInfo: () => setSecureInfoOpen(true),
    };
  }, [analytics, pay, runSearch]);

  const contextValue: BookingContextValue = useMemo(
    () => ({ state, dispatch, actions, config, theme, quote, availability, analytics, today }),
    [state, actions, config, theme, quote, availability, analytics, today],
  );

  /* ------------------------------- view -------------------------------- */

  const { step, search, cart, checkout } = state;
  const submitting = checkout.status === "submitting" || checkout.status === "redirecting";
  const stayIn = availability?.search.checkIn ?? search.checkIn;
  const stayOut = availability?.search.checkOut ?? search.checkOut;

  let cta: SummaryCta | null = null;
  if (step === "results" || step === "addons") {
    cta = { label: STEP_CTA[step], onClick: actions.continue, disabled: cart.length === 0 || !quote };
  } else if (step === "guest") {
    cta = { label: STEP_CTA.guest, submitForm: GUEST_FORM_ID };
  } else if (step === "payment" && quote) {
    cta = { label: `Pay ${formatThbWithCode(quote.dueNowSatang)}`, onClick: () => void actions.pay(), busy: submitting };
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

  const prevStep = STEP_ORDER[STEP_ORDER.indexOf(step) - 1];

  return (
    <BookingContext.Provider value={contextValue}>
      <BookingThemeRoot theme={theme} className={`rounded-(--bk-radius-card) ${cart.length > 0 ? "pb-28 lg:pb-0" : ""}`}>
        <div ref={rootRef} className="scroll-mt-24 space-y-6 p-3 sm:p-6">
          <PreviewBanner
            paymentMode={config.paymentMode}
            paymentStatus={config.paymentStatus}
            dataSource={availability?.dataSource ?? null}
            theme={theme}
            themeHref={themeHref}
          />

          <header>
            <p className="text-sm uppercase tracking-[0.3em] text-(--bk-eyebrow)">
              Book direct
            </p>
            <h1 className="bk-heading mt-3 text-4xl text-(--bk-frame-text)">Book Your Stay</h1>
            <p className="mt-4 max-w-2xl text-(--bk-frame-text-muted)">
              Live availability and secure payment, right here on our site.
            </p>
          </header>

          {state.notice && <NoticeBar notice={state.notice} onDismiss={actions.dismissNotice} />}

          {!state.hydrated ? (
            <div className="min-h-[420px]" aria-busy="true" />
          ) : step === "search" ? (
            <SearchStep {...searchBarProps} />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
              <section aria-labelledby="booking-step-title" className="min-w-0 space-y-4">
                <div id="booking-step-title" className="rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card)">
                  <StepHeader
                    title={STEP_TITLES[step]}
                    onBack={prevStep ? actions.back : undefined}
                    backLabel={prevStep ? `Go back to ${STEP_TITLES[prevStep]}` : undefined}
                  />
                </div>

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

                {step === "payment" && quote && stayIn && stayOut && (
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
                  />
                )}
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
          <MobileSummaryBar quote={quote} checkIn={stayIn} checkOut={stayOut} cta={cta} summary={summary("sheet")} />
        )}
        <SecurePaymentModal open={secureInfoOpen} onClose={() => setSecureInfoOpen(false)} />
        <BookingHelpStrip />
      </BookingThemeRoot>
    </BookingContext.Provider>
  );
}
