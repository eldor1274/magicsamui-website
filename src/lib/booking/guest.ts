// Guest details (client only). This is personal data: it stays in the
// browser (React state + sessionStorage for the return page) and is never
// put in a URL, a token or an analytics payload. The preview never sends it
// to the server.

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
  /** "" or a slot value such as "15:00". */
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
  arrivalTime: "",
  specialRequests: "",
  agreedToPolicy: false,
};

export const GUEST_LIMITS = {
  name: 60,
  email: 120,
  specialRequests: 1000,
} as const;

/** Arrival time options: 15:00 .. 23:00 hourly plus "After midnight" (value "late"). */
export const ARRIVAL_TIME_OPTIONS: { value: string; label: string }[] = [
  ...Array.from({ length: 9 }, (_, i) => {
    const h = 15 + i;
    const label = h === 12 ? "12:00 PM" : h > 12 ? `${h - 12}:00 PM` : `${h}:00 AM`;
    return { value: `${h}:00`, label };
  }),
  { value: "late", label: "After midnight" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Returns one message per invalid field (empty object when valid). */
export function validateGuest(g: GuestDetails): GuestErrors {
  const e: GuestErrors = {};
  const first = g.firstName.trim();
  const last = g.lastName.trim();
  if (!first) e.firstName = "Please enter a first name.";
  else if (first.length > GUEST_LIMITS.name) e.firstName = "That name is too long.";
  if (!last) e.lastName = "Please enter a last name.";
  else if (last.length > GUEST_LIMITS.name) e.lastName = "That name is too long.";
  if (!/^[A-Z]{2}$/.test(g.country)) e.country = "Please choose your country.";
  const email = g.email.trim();
  if (!email) e.email = "Please enter your email address.";
  else if (email.length > GUEST_LIMITS.email || !EMAIL_RE.test(email)) e.email = "Please enter a valid email address.";
  const digits = g.phone.replace(/\D/g, "");
  if (!/^\+\d{1,4}$/.test(g.dialCode)) e.dialCode = "Please choose a country code.";
  if (!digits) e.phone = "Please enter a phone number.";
  else if (digits.length < 6 || digits.length > 15 || /[^\d\s()-]/.test(g.phone)) e.phone = "Please enter a valid phone number.";
  if (g.specialRequests.length > GUEST_LIMITS.specialRequests) e.specialRequests = "Please keep requests under 1,000 characters.";
  if (!g.agreedToPolicy) e.agreedToPolicy = "Please agree to the booking and cancellation policy.";
  return e;
}

export function isGuestValid(g: GuestDetails): boolean {
  return Object.keys(validateGuest(g)).length === 0;
}
