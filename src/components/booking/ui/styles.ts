// OWNER: ui-search-results
// Shared class strings for booking controls so both themes stay consistent.
// Every colour comes from the theme variables in booking.css.

/** Filled accent pill (Search, Apply, Confirm, Book Now). */
export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-(--bk-radius-pill) bg-(--bk-accent) px-5 font-medium text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover) disabled:cursor-not-allowed disabled:opacity-(--bk-disabled-opacity) disabled:hover:bg-(--bk-accent) aria-disabled:cursor-not-allowed aria-disabled:opacity-(--bk-disabled-opacity)";

/** Outline pill (Cancel). */
export const BTN_OUTLINE =
  "inline-flex items-center justify-center gap-2 rounded-(--bk-radius-pill) border border-(--bk-border-strong) bg-(--bk-surface) px-5 font-medium text-(--bk-text) transition-colors hover:border-(--bk-text) disabled:cursor-not-allowed disabled:opacity-(--bk-disabled-opacity)";

/**
 * Invisible 44px-tall (and at least 44px-wide) hit area centred on a small
 * control, so text links and small icons meet the touch-target size without
 * changing how they look. The control gets `relative`; the area is a ::before.
 */
export const TOUCH_TARGET =
  "relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-[max(100%,2.75rem)] before:-translate-x-1/2 before:-translate-y-1/2";

/** Text-only action (Clear, View details). */
export const BTN_LINK = `${TOUCH_TARGET} rounded-sm font-medium text-(--bk-text) underline decoration-1 underline-offset-4 transition-colors hover:text-(--bk-accent)`;

/** Round icon button (close, carousel arrows). */
export const BTN_ICON =
  "inline-flex shrink-0 items-center justify-center rounded-full text-(--bk-text) transition-colors hover:bg-(--bk-surface-sunken)";

/** Small grey chip (occupancy, nights, guests). */
export const CHIP =
  "inline-flex items-center gap-1.5 rounded-(--bk-radius-control) bg-(--bk-surface-sunken) px-2 py-1 text-xs font-medium text-(--bk-text)";
