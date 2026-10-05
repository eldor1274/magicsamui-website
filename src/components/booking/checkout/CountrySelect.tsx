"use client";

// OWNER: ui-checkout
// Searchable country combobox (WAI-ARIA 1.2 combobox + listbox pattern) over
// the full ISO 3166-1 list in ./countries. value is the alpha-2 code ("TH").
// Type to filter (names, common aliases such as "UK", accents ignored),
// Arrow keys to move, Enter to pick, Escape to close. Browser autofill of
// "country-name" is matched to a country automatically.
// Render it inside a FieldShell (it fills the box and positions its list
// under it). Keep CountrySelectProps stable.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { FIELD_CONTROL_CLASS } from "./FormField";
import { findCountryByName, getCountry, searchCountries } from "./countries";
import type { Country } from "./countries";

export interface CountrySelectProps {
  id: string;
  name?: string;
  /** ISO alpha-2 code, "" when unset. */
  value: string;
  onChange: (code: string) => void;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

function optionId(listId: string, code: string): string {
  return `${listId}-${code}`;
}

export default function CountrySelect({ id, name, value, onChange, required, invalid, describedBy }: CountrySelectProps) {
  const selected = getCountry(value);
  /** Text being typed; null when showing the selected country's name. */
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = `${id}-listbox`;

  const results = useMemo(() => searchCountries(query ?? ""), [query]);
  const active: Country | undefined = open ? results[Math.min(activeIndex, results.length - 1)] : undefined;

  // Keep the highlighted option visible while arrowing through the list.
  useEffect(() => {
    if (!open || !active) return;
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-code="${active.code}"]`);
    if (!list || !el) return;
    // Scroll only the list (scrollIntoView would also scroll the page).
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }, [open, active]);

  /**
   * Once the list is shown, scroll the page just enough that its bottom clears
   * the fixed bottom bars (--bk-fab-lift: mobile cart bar + help strip), so no
   * option - or the keyboard-highlighted one - hides underneath them.
   */
  function revealList() {
    window.requestAnimationFrame(() => {
      const box = listRef.current?.parentElement;
      if (!box || box.hidden || box.offsetParent === null) return;
      const lift = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bk-fab-lift")) || 0;
      const limit = window.innerHeight - lift - 16;
      const bottom = box.getBoundingClientRect().bottom;
      if (bottom > limit) window.scrollBy({ top: bottom - limit, behavior: "auto" });
    });
  }

  function openList() {
    const idx = selected && query === null ? results.findIndex((c) => c.code === selected.code) : 0;
    setActiveIndex(Math.max(0, idx));
    setOpen(true);
    revealList();
  }

  function commit(country: Country | undefined) {
    if (country) onChange(country.code);
    setQuery(null);
    setOpen(false);
  }

  /** Leaving the field: accept an exact or single match, otherwise restore the last valid choice. */
  function settle() {
    if (query !== null) {
      const typed = query.trim();
      if (typed === "") {
        onChange("");
      } else {
        const exact = findCountryByName(typed) ?? getCountry(typed.length === 2 ? typed : null);
        if (exact) onChange(exact.code);
        else if (results.length === 1) onChange(results[0].code);
      }
    }
    setQuery(null);
    setOpen(false);
  }

  function onInput(e: ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    // Autofill and paste-from-suggestion arrive without a typing InputEvent.
    const native = e.nativeEvent;
    const typed = typeof InputEvent !== "undefined" && native instanceof InputEvent && native.inputType !== "insertReplacementText";
    if (!typed) {
      const match = findCountryByName(text);
      if (match) {
        commit(match);
        return;
      }
    }
    setQuery(text);
    setActiveIndex(0);
    if (!open) revealList();
    setOpen(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openList();
        else setActiveIndex((i) => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openList();
        else setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "PageDown":
        if (open) {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 8, results.length - 1));
        }
        break;
      case "PageUp":
        if (open) {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 8, 0));
        }
        break;
      case "Enter":
        // Never let Enter in the combobox submit the guest form.
        if (open) {
          e.preventDefault();
          commit(active);
        } else if (query !== null) {
          e.preventDefault();
          settle();
        }
        break;
      case "Escape":
        if (open || query !== null) {
          e.preventDefault();
          e.stopPropagation();
          setQuery(null);
          setOpen(false);
        }
        break;
      case "Tab":
        if (open && query !== null && active) commit(active);
        break;
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active ? optionId(listId, active.code) : undefined}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="country-name"
        autoCapitalize="words"
        spellCheck={false}
        placeholder="Start typing your country"
        value={query ?? selected?.name ?? ""}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onClick={() => {
          if (!open) openList();
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={settle}
        className={`${FIELD_CONTROL_CLASS} pr-10`}
      />
      {name && <input type="hidden" name={name} value={value} />}
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Hide countries" : "Show countries"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else openList();
          inputRef.current?.focus();
        }}
        className="absolute bottom-1 right-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-(--bk-text-muted) hover:bg-(--bk-surface-sunken)"
      >
        <ChevronDown size={18} aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <div
        className={`absolute -left-px -right-px top-[calc(100%+0.5rem)] z-30 overflow-hidden rounded-(--bk-radius-control) border border-(--bk-border) bg-(--bk-surface) shadow-(--bk-shadow-pop) ${
          open ? "" : "hidden"
        }`}
      >
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Countries"
          // At most 16rem, and never taller than the room between the sticky header and the bottom bars.
          className="relative max-h-[max(7rem,min(16rem,calc(100dvh_-_var(--bk-fab-lift,0px)_-_12rem)))] overflow-y-auto overscroll-contain py-1"
        >
          {open &&
            results.map((c) => {
              const isActive = active?.code === c.code;
              const isSelected = c.code === value;
              return (
                <li
                  key={c.code}
                  id={optionId(listId, c.code)}
                  data-code={c.code}
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(c)}
                  onMouseMove={() => {
                    const idx = results.indexOf(c);
                    if (idx !== activeIndex) setActiveIndex(idx);
                  }}
                  className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-3 text-sm ${
                    isActive ? "bg-(--bk-accent-soft) text-(--bk-accent-soft-text)" : "text-(--bk-text)"
                  }`}
                >
                  <span className={isSelected ? "font-semibold" : undefined}>{c.name}</span>
                  <span className="shrink-0 text-xs text-(--bk-text-subtle)">{c.code}</span>
                </li>
              );
            })}
        </ul>
        {open && results.length === 0 && (
          <p role="status" className="px-3 py-3 text-sm text-(--bk-text-muted)">
            No country matches &ldquo;{query}&rdquo;.
          </p>
        )}
      </div>
    </div>
  );
}
