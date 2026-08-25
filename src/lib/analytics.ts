// Google Ads tag. Public by nature (it ships in the page source), so it lives
// in code rather than an env var. It shares the single gtag.js load with GA4 —
// both IDs are configured in the layout's dataLayer stub.
//
// AW-18404377092 is account 509-900-8547 ("Magic"). The previous value,
// AW-10949739737, belonged to the abandoned 352-328-6086 account.
export const GOOGLE_ADS_ID = "AW-18404377092";

// Full send_to target of the Ads "Purchase" conversion action (ctId
// 7730068954), e.g. "AW-18404377092/AbC-dEfGhIjKl". The Cloudbeds engine
// fires a GA4 `purchase` through our gtag stub on /booking; the stub mirrors
// it to this conversion so Google Ads counts bookings without the (broken)
// GA4 import. Empty string keeps the mirror disabled until the label is
// copied from the conversion action's tag-setup screen.
export const ADS_PURCHASE_SEND_TO = "";
