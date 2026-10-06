// Guest details. Isomorphic (no browser or Node APIs): the booking page
// validates them while the guest types, and in stripe modes the server
// re-validates them (validate.ts parseGuestInput) before they go to Cloudbeds
// (the reservation) and Stripe (the receipt email).
//
// This is personal data. It is never put in a URL, a token, a log line or an
// analytics payload, and the server never stores it. In demo/beam modes it
// never leaves the browser at all.

export interface GuestDetails {
  firstName: string;
  lastName: string;
  /** ISO 3166-1 alpha-2, e.g. "TH". */
  country: string;
  email: string;
  /** International dial code incl. "+", e.g. "+66". */
  dialCode: string;
  /** National number as typed (digits, spaces, dashes allowed). */
  phone: string;
  /**
   * Postcode / ZIP (Cloudbeds guestZip). Optional for the guest: many
   * countries have none, so the server sends a placeholder when empty.
   * Older saved sessions may lack it - treat undefined as "".
   */
  postcode?: string;
  /** "" or a slot value such as "15:00" ("late" = after 11 PM, by arrangement only). */
  arrivalTime: string;
  specialRequests: string;
  agreedToPolicy: boolean;
}

export type GuestField = keyof GuestDetails;
export type GuestErrors = Partial<Record<GuestField, string>>;

export const EMPTY_GUEST: GuestDetails = {
  firstName: "",
  lastName: "",
  country: "",
  email: "",
  dialCode: "",
  phone: "",
  postcode: "",
  arrivalTime: "",
  specialRequests: "",
  agreedToPolicy: false,
};

export const GUEST_LIMITS = {
  name: 60,
  email: 120,
  postcode: 12,
  specialRequests: 1000,
} as const;

/**
 * Arrival time options: 15:00 .. 23:00 hourly (check-in is 3 PM - 11 PM) plus
 * "After 11 PM" (value "late", kept from when it meant after midnight: saved
 * sessions and the msv_arrival_late flag still use it).
 */
export const ARRIVAL_TIME_OPTIONS: { value: string; label: string }[] = [
  ...Array.from({ length: 9 }, (_, i) => {
    const h = 15 + i;
    const label = h === 12 ? "12:00 PM" : h > 12 ? `${h - 12}:00 PM` : `${h}:00 AM`;
    return { value: `${h}:00`, label };
  }),
  { value: "late", label: "After 11 PM (message us first)" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const POSTCODE_RE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
/** Characters a name may contain: letters of any script, marks, spaces, apostrophes, dots and hyphens. */
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

const NAME_CHARS_MESSAGE = "Please use letters, spaces, apostrophes or hyphens only.";

/**
 * A name as it is checked and sent to Cloudbeds: Unicode NFKC (full-width
 * letters and the ideographic space U+3000 that Japanese/Chinese keyboards
 * insert become their plain forms), every kind of space as " ", runs of spaces
 * collapsed, trimmed.
 */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/[\p{Zs}\t]+/gu, " ").trim();
}

/**
 * A postcode as it is checked and sent to Cloudbeds (guestZip): NFKC (the
 * full-width digits and letters a Japanese or Chinese keyboard types become
 * plain ones), any space as one " ", trimmed, upper case.
 */
export function normalizePostcode(postcode: string): string {
  return postcode.normalize("NFKC").replace(/[\p{Zs}\t]+/gu, " ").trim().toUpperCase();
}

/** Returns one message per invalid field (empty object when valid). */
export function validateGuest(g: GuestDetails): GuestErrors {
  const e: GuestErrors = {};
  const first = normalizeName(g.firstName);
  const last = normalizeName(g.lastName);
  if (!first) e.firstName = "Please enter a first name.";
  else if (first.length > GUEST_LIMITS.name) e.firstName = "That name is too long.";
  else if (!NAME_RE.test(first)) e.firstName = NAME_CHARS_MESSAGE;
  if (!last) e.lastName = "Please enter a last name.";
  else if (last.length > GUEST_LIMITS.name) e.lastName = "That name is too long.";
  else if (!NAME_RE.test(last)) e.lastName = NAME_CHARS_MESSAGE;
  if (!/^[A-Z]{2}$/.test(g.country)) e.country = "Please choose your country.";
  const email = g.email.trim();
  if (!email) e.email = "Please enter your email address.";
  else if (email.length > GUEST_LIMITS.email || !EMAIL_RE.test(email)) e.email = "Please enter a valid email address.";
  const digits = g.phone.replace(/\D/g, "");
  if (!/^\+\d{1,4}$/.test(g.dialCode)) e.dialCode = "Please choose a country code.";
  if (!digits) e.phone = "Please enter a phone number.";
  else if (digits.length < 6 || digits.length > 15 || /[^\d\s()-]/.test(g.phone)) e.phone = "Please enter a valid phone number.";
  const postcode = normalizePostcode(g.postcode ?? "");
  if (postcode && (postcode.length > GUEST_LIMITS.postcode || !POSTCODE_RE.test(postcode))) {
    e.postcode = "Please enter a valid postcode, or leave it empty.";
  }
  if (g.arrivalTime && !ARRIVAL_TIME_OPTIONS.some((o) => o.value === g.arrivalTime)) e.arrivalTime = "Please choose an arrival time.";
  if (g.specialRequests.length > GUEST_LIMITS.specialRequests) e.specialRequests = "Please keep requests under 1,000 characters.";
  // Same wording as the checkbox (HOUSE_POLICIES.agreement; catalogue.test.ts checks they match).
  if (!g.agreedToPolicy) e.agreedToPolicy = "Please agree to the house rules, the deposit and the booking and cancellation policy.";
  return e;
}

export function isGuestValid(g: GuestDetails): boolean {
  return Object.keys(validateGuest(g)).length === 0;
}

/** "+66 952466011" - the format sent to Cloudbeds as guestPhone. */
export function internationalPhone(g: Pick<GuestDetails, "dialCode" | "phone">): string {
  return `${g.dialCode} ${g.phone.replace(/\D/g, "")}`;
}

/** Cloudbeds estimatedArrivalTime ("15:00") or null for "" / "late". */
export function cloudbedsArrivalTime(arrivalTime: string): string | null {
  const m = /^(\d{1,2}):00$/.exec(arrivalTime);
  return m ? `${m[1].padStart(2, "0")}:00` : null;
}
