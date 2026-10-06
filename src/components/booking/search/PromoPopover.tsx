"use client";

// OWNER: ui-search-results
// Promo code picker: "Promo Code" input with Clear / Cancel / Apply. Apply
// hands the normalised code to the search bar, which stores it and re-runs
// the search; the server's verdict comes back as `result` and is shown here
// (valid -> discount label, invalid -> friendly message). Keep
// PromoPopoverProps stable.

import { useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import type { PromoResult } from "@/lib/booking/types";
import PickerOverlay, { PickerActions } from "../ui/PickerOverlay";
import { BTN_LINK, BTN_OUTLINE, BTN_PRIMARY } from "../ui/styles";

export interface PromoPopoverProps {
  open: boolean;
  onClose: () => void;
  /** Current code in the draft ("" = none). */
  value: string;
  /** Server validation of the applied code, if any. */
  result: PromoResult | null;
  /** Apply a code ("" clears it). */
  onApply: (code: string) => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** False when no code can be valid right now (Beam modes): no DIRECT hint. */
  promoEnabled?: boolean;
  /** The code to suggest ("Use code DIRECT..."); null = none (the code can't change the price here). Default: DIRECT while promoEnabled. */
  hintCode?: string | null;
}

const CODE_RE = /^[A-Z0-9_-]{1,32}$/;

export default function PromoPopover(props: PromoPopoverProps) {
  if (!props.open) return null;
  return <PromoPicker {...props} />;
}

function PromoPicker({ onClose, value, result, onApply, anchorRef, promoEnabled = true, hintCode }: PromoPopoverProps) {
  const hint = hintCode !== undefined ? hintCode : promoEnabled ? "DIRECT" : null;
  const [code, setCode] = useState(value);
  const [formatError, setFormatError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const inputId = useId();
  const messageId = useId();

  const normalized = code.trim().toUpperCase();
  const verdict = result && normalized !== "" && result.code.toUpperCase() === normalized ? result : null;

  const apply = () => {
    if (normalized !== "" && !CODE_RE.test(normalized)) {
      setFormatError("Codes use letters and numbers only.");
      inputRef.current?.focus();
      return;
    }
    onApply(normalized);
    onClose();
  };

  const message = formatError ?? (verdict ? (verdict.valid ? verdict.label : verdict.message) : null);
  // A note (the code is real but can't be used on this page) is not an error: shown calmly, with its link.
  const note = formatError === null && verdict !== null && !verdict.valid && verdict.note === true ? verdict : null;
  const isError = formatError !== null || (verdict !== null && !verdict.valid && note === null);

  return (
    <PickerOverlay
      onClose={onClose}
      anchorRef={anchorRef}
      title="Promo Code"
      align="center"
      popoverClassName="w-[22rem]"
      initialFocusRef={inputRef}
      actions={
        <PickerActions
          start={
            <button
              type="button"
              onClick={() => {
                setCode("");
                setFormatError(null);
                inputRef.current?.focus();
              }}
              className={`${BTN_LINK} px-1 text-sm no-underline hover:underline`}
            >
              Clear
            </button>
          }
        >
          <button type="button" onClick={onClose} className={`${BTN_OUTLINE} h-11 text-sm`}>
            Cancel
          </button>
          <button type="submit" form={formId} className={`${BTN_PRIMARY} h-11 text-sm`}>
            Apply
          </button>
        </PickerActions>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          // React events bubble through portals: keep this submit away from
          // the search bar's own <form>, which would start a search.
          e.stopPropagation();
          apply();
        }}
      >
        <div className="relative">
          <input
            ref={inputRef}
            id={inputId}
            name="promo"
            type="text"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setFormatError(null);
            }}
            maxLength={32}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="done"
            aria-invalid={isError || undefined}
            aria-describedby={message ? messageId : undefined}
            className={`peer h-14 w-full rounded-(--bk-radius-control) border bg-(--bk-surface) px-3 pb-1.5 pt-5 text-base uppercase tracking-wide text-(--bk-text) outline-none transition-colors focus:border-(--bk-focus) ${
              isError ? "border-(--bk-danger)" : "border-(--bk-field-border)"
            }`}
          />
          <label htmlFor={inputId} className="pointer-events-none absolute left-3 top-2 text-xs font-medium text-(--bk-text-muted)">
            Promo Code
          </label>
        </div>
        {note ? (
          <p id={messageId} role="status" className="mt-2 flex items-start gap-1.5 text-sm text-(--bk-text-muted)">
            <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {note.message}
              {note.link && (
                <>
                  {" "}
                  <a href={note.link.href} rel="nofollow" className="font-medium text-(--bk-text) underline underline-offset-2">
                    {note.link.text}
                  </a>
                </>
              )}
            </span>
          </p>
        ) : message ? (
          <p
            id={messageId}
            role={isError ? "alert" : "status"}
            className={`mt-2 flex items-start gap-1.5 text-sm ${isError ? "text-(--bk-danger)" : "text-(--bk-success)"}`}
          >
            {isError ? (
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            )}
            <span>{message}</span>
          </p>
        ) : (
          <p className="mt-2 text-xs text-(--bk-text-subtle)">
            {hint ? `Booking direct? Use code ${hint} for our best direct rate.` : "Have a code? Enter it here."}
          </p>
        )}
      </form>
    </PickerOverlay>
  );
}
