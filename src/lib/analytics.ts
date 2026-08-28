// Google Ads tag. Public by nature (it ships in the page source), so it lives
// in code rather than an env var. It shares the single gtag.js load with GA4 —
// both IDs are configured in the layout's dataLayer stub.
//
// AW-18404377092 is account 509-900-8547 ("Magic"). The previous value,
// AW-10949739737, belonged to the abandoned 352-328-6086 account.
export const GOOGLE_ADS_ID = "AW-18404377092";
