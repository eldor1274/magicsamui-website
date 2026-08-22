// Marks Eldor's own browsers so analytics (Clarity, GA4, Google Ads) never
// load for them. Set by unlocking the points admin, or by opening any page
// with ?staff=1 once per device (?staff=0 clears it). IP blocking would not
// work: Thai mobile/home IPs rotate, and the villa Wi-Fi is shared with guests.
export const OWNER_FLAG = "msv_owner";

export function isOwnerDevice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const staff = new URLSearchParams(window.location.search).get("staff");
    if (staff === "1") window.localStorage.setItem(OWNER_FLAG, "1");
    if (staff === "0") window.localStorage.removeItem(OWNER_FLAG);
    return window.localStorage.getItem(OWNER_FLAG) === "1";
  } catch {
    return false; // storage blocked - treat as a normal visitor
  }
}
