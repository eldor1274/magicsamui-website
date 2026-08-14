// Guest points: 3% of what a stay was worth, valid for 3 years from checkout.
// Balances are DERIVED from stay history minus what Eldor has manually cleared,
// so there is no balance field that can drift out of sync with reality.

export const EARN_RATE = 0.03;
export const VALID_YEARS = 3;

// Cloudbeds stores the gross price the guest paid, not what actually lands in
// the bank — the OTA keeps its cut. Points are earned on the net, so a stay is
// only rewarded on money actually received. Adjust these if a rate changes.
const COMMISSION: Record<string, number> = {
  airbnb: 0.2,
  "booking.com": 0.2,
  expedia: 0.2,
  agoda: 0.2,
  ctrip: 0.2,
  hotelbeds: 0.2,
};

/** Share of a stay's gross price that Eldor actually keeps. */
export function netFactor(source: string): number {
  const src = (source || "").toLowerCase();
  for (const [channel, rate] of Object.entries(COMMISSION)) {
    if (src.includes(channel)) return 1 - rate;
  }
  return 1;
}

// Owner/staff numbers and internal booking sources never earn points.
const HOUSE_PHONES = ["66952466011", "66659911732", "66918605001", "66968896525"];
const HOUSE_SOURCES = ["default corporate"];

export interface Stay {
  reservationID: string;
  startDate: string;
  endDate: string;
  total: number;
  source: string;
  roomTypeName: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface ClearEvent {
  phoneKey: string;
  points: number;
  clearedAt: string;
  note: string;
}

export interface Account {
  phoneKey: string;
  name: string;
  lastName: string;
  earned: number;
  cleared: number;
  balance: number;
  spend: number;
  stays: Stay[];
  expiring: { points: number; on: string } | null;
}

/** Last 9 digits: makes +66 81 234 5678, 0812345678 and 66812345678 the same guest. */
export function phoneKey(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : "";
}

function normName(raw: string): string {
  return (raw || "").toLowerCase().replace(/[^a-z]/g, "");
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/** A stay earns points once it has actually happened and was not cancelled. */
export function earnsPoints(stay: Stay, asOf: Date): boolean {
  const end = new Date(stay.endDate);
  if (Number.isNaN(end.getTime()) || end > asOf) return false;
  if (HOUSE_PHONES.includes((stay.phone || "").replace(/\D/g, ""))) return false;
  const src = (stay.source || "").toLowerCase();
  if (HOUSE_SOURCES.some((h) => src.includes(h))) return false;
  return stay.total > 0;
}

export function pointsForStay(stay: Stay): number {
  return Math.floor(stay.total * netFactor(stay.source) * EARN_RATE);
}

export function buildAccounts(
  stays: Stay[],
  clears: ClearEvent[],
  asOf: Date = new Date()
): Map<string, Account> {
  const byPhone = new Map<string, Stay[]>();
  for (const stay of stays) {
    if (!earnsPoints(stay, asOf)) continue;
    const key = phoneKey(stay.phone);
    if (!key) continue;
    // Points older than the validity window are simply never counted.
    if (daysBetween(new Date(stay.endDate), asOf) > VALID_YEARS * 365) continue;
    const list = byPhone.get(key);
    if (list) list.push(stay);
    else byPhone.set(key, [stay]);
  }

  const clearedBy = new Map<string, number>();
  for (const c of clears) {
    clearedBy.set(c.phoneKey, (clearedBy.get(c.phoneKey) ?? 0) + c.points);
  }

  const accounts = new Map<string, Account>();
  for (const [key, list] of byPhone) {
    list.sort((a, b) => a.startDate.localeCompare(b.startDate));
    const earned = list.reduce((sum, s) => sum + pointsForStay(s), 0);
    const cleared = clearedBy.get(key) ?? 0;
    const latest = list[list.length - 1];

    // Whatever expires first still has value only if it survived the clears.
    const oldest = list[0];
    const expiresOn = new Date(oldest.endDate);
    expiresOn.setFullYear(expiresOn.getFullYear() + VALID_YEARS);
    const balance = Math.max(0, earned - cleared);
    const soon = daysBetween(asOf, expiresOn) <= 180 && balance > 0;

    accounts.set(key, {
      phoneKey: key,
      name: `${latest.firstName} ${latest.lastName}`.trim(),
      lastName: latest.lastName,
      earned,
      cleared,
      balance,
      spend: list.reduce((sum, s) => sum + s.total, 0),
      stays: list,
      expiring: soon
        ? { points: Math.min(balance, pointsForStay(oldest)), on: expiresOn.toISOString().slice(0, 10) }
        : null,
    });
  }
  return accounts;
}

/**
 * Lookup is by phone number. The surname is optional and only narrows a match
 * that the number already found.
 *
 * The number has to be the key rather than the name: 16 surnames in the guest
 * list belong to more than one person, so a name lookup would hand one guest
 * another guest's balance. A name is also guessable, which would turn this into
 * a public search for who has stayed here and what they paid.
 */
export function lookup(
  accounts: Map<string, Account>,
  phone: string,
  lastName = ""
): Account | null {
  const key = phoneKey(phone);
  if (!key) return null;
  const account = accounts.get(key);
  if (!account) return null;

  const given = normName(lastName);
  if (!given) return account;

  const matches = account.stays.some((s) => {
    const surname = normName(s.lastName);
    return surname.length > 1 && (surname === given || given === normName(`${s.firstName}${s.lastName}`));
  });
  return matches ? account : null;
}
