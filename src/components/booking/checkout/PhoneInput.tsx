"use client";

// OWNER: ui-checkout
// Compound phone field: a dial-code picker (a real <select> laid over a
// compact "TH +66" label, so it is keyboard and screen-reader native and
// opens the OS picker on phones) and the national number. Pasting a full
// international number ("+66 81 234 5678") splits it into code + number.
// Render it inside a FieldShell whose label points at `id` (the number).
// Keep PhoneInputProps stable; `countryHint` is an optional addition.

import { useMemo } from "react";
import type { ChangeEvent } from "react";
import { ChevronDown } from "lucide-react";
import { FIELD_CONTROL_CLASS } from "./FormField";
import { COUNTRIES, countryForDial, getCountry } from "./countries";

export interface PhoneInputProps {
  id: string;
  /** "+66" style, "" when unset. */
  dialCode: string;
  number: string;
  onChange: (next: { dialCode: string; number: string }) => void;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Optional: the guest's country, so a shared code such as +1 shows the right country. */
  countryHint?: string;
  /** Optional: marks only the dial-code picker invalid. */
  dialInvalid?: boolean;
}

const DIAL_CODES = new Set(COUNTRIES.map((c) => c.dial));

/** "+66 81 234 5678" -> { dialCode: "+66", number: "81 234 5678" }; null if it does not start with a known code. */
export function splitInternational(value: string): { dialCode: string; number: string } | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("+") && !trimmed.startsWith("00")) return null;
  const digits = trimmed.replace(/\D/g, "").replace(/^00/, "");
  for (let len = 4; len >= 1; len--) {
    const code = `+${digits.slice(0, len)}`;
    if (DIAL_CODES.has(code)) return { dialCode: code, number: digits.slice(len) };
  }
  return null;
}

export default function PhoneInput({
  id,
  dialCode,
  number,
  onChange,
  required,
  invalid,
  describedBy,
  countryHint,
  dialInvalid,
}: PhoneInputProps) {
  const shown = countryForDial(dialCode, countryHint);
  const dialId = `${id}-dial`;
  const options = useMemo(() => COUNTRIES.map((c) => ({ value: c.code, label: `${c.name} (${c.dial})` })), []);

  function onDial(e: ChangeEvent<HTMLSelectElement>) {
    const c = getCountry(e.target.value);
    onChange({ dialCode: c?.dial ?? "", number });
  }

  function onNumber(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const split = splitInternational(raw);
    if (split) {
      onChange(split);
      return;
    }
    // Keep what people type (spaces, dashes, brackets) but drop anything else.
    onChange({ dialCode, number: raw.replace(/[^\d\s()-]/g, "").slice(0, 24) });
  }

  return (
    <div className="flex items-stretch">
      <div
        className={`relative flex shrink-0 items-center gap-1 border-r pb-2 pl-3 pr-2 pt-0.5 text-base ${
          dialInvalid ? "border-(--bk-danger) text-(--bk-danger)" : "border-(--bk-border) text-(--bk-text)"
        }`}
      >
        <span aria-hidden="true" className="flex items-baseline gap-1.5 whitespace-nowrap">
          {shown ? (
            <>
              <span className="text-xs font-semibold text-(--bk-text-subtle)">{shown.code}</span>
              <span>{shown.dial}</span>
            </>
          ) : (
            <span className="text-(--bk-text-subtle)">Code</span>
          )}
        </span>
        <ChevronDown size={16} aria-hidden="true" className="text-(--bk-text-muted)" />
        <select
          id={dialId}
          aria-label="Country calling code"
          aria-invalid={dialInvalid || undefined}
          aria-required={required || undefined}
          autoComplete="tel-country-code"
          value={shown?.code ?? ""}
          onChange={onDial}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          <option value="" disabled>
            Select country code
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        value={number}
        onChange={onNumber}
        required={required}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="tel-national"
        placeholder="81 234 5678"
        maxLength={24}
        className={`${FIELD_CONTROL_CLASS} flex-1`}
      />
    </div>
  );
}
