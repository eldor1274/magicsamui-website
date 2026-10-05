// Display helpers for money (input is always integer satang). Formatting is
// done from integers, never floats, so 0.1 + 0.2 style drift cannot appear.

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1875000 -> "18,750.00" (Cloudbeds style, no currency). Negative -> "-937.50". */
export function formatThb(satang: number): string {
  const rounded = Math.round(satang);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const baht = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${groupThousands(baht)}.${rest < 10 ? "0" : ""}${rest}`;
}

/** 1968750 -> "THB 19,687.50" (totals). */
export function formatThbWithCode(satang: number): string {
  return `THB ${formatThb(satang)}`;
}

/** 1875000 -> "18,750" (whole baht, for compact chips). */
export function formatThbWhole(satang: number): string {
  const rounded = Math.round(satang / 100);
  return rounded < 0 ? `-${groupThousands(-rounded)}` : groupThousands(rounded);
}
