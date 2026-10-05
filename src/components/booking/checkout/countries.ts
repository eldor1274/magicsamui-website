// OWNER: ui-checkout
// ISO 3166-1 alpha-2 countries and territories (plus Kosovo, XK) with their
// main international dial code. Used by CountrySelect and PhoneInput.
// Client-safe static data; no personal information.

export interface Country {
  /** ISO 3166-1 alpha-2, e.g. "TH". */
  code: string;
  name: string;
  /** Main dial code incl. "+", e.g. "+66". */
  dial: string;
  /** Other names guests commonly type ("UK", "Holland"...). */
  aliases?: string[];
}

type Row = [code: string, name: string, dial: string, aliases?: string[]];

const ROWS: Row[] = [
  ["AF", "Afghanistan", "+93"],
  ["AX", "Åland Islands", "+358"],
  ["AL", "Albania", "+355"],
  ["DZ", "Algeria", "+213"],
  ["AS", "American Samoa", "+1"],
  ["AD", "Andorra", "+376"],
  ["AO", "Angola", "+244"],
  ["AI", "Anguilla", "+1"],
  ["AQ", "Antarctica", "+672"],
  ["AG", "Antigua and Barbuda", "+1"],
  ["AR", "Argentina", "+54"],
  ["AM", "Armenia", "+374"],
  ["AW", "Aruba", "+297"],
  ["AU", "Australia", "+61"],
  ["AT", "Austria", "+43"],
  ["AZ", "Azerbaijan", "+994"],
  ["BS", "Bahamas", "+1"],
  ["BH", "Bahrain", "+973"],
  ["BD", "Bangladesh", "+880"],
  ["BB", "Barbados", "+1"],
  ["BY", "Belarus", "+375"],
  ["BE", "Belgium", "+32"],
  ["BZ", "Belize", "+501"],
  ["BJ", "Benin", "+229"],
  ["BM", "Bermuda", "+1"],
  ["BT", "Bhutan", "+975"],
  ["BO", "Bolivia", "+591"],
  ["BQ", "Bonaire, Sint Eustatius and Saba", "+599", ["Caribbean Netherlands"]],
  ["BA", "Bosnia and Herzegovina", "+387"],
  ["BW", "Botswana", "+267"],
  ["BV", "Bouvet Island", "+47"],
  ["BR", "Brazil", "+55", ["Brasil"]],
  ["IO", "British Indian Ocean Territory", "+246"],
  ["VG", "British Virgin Islands", "+1"],
  ["BN", "Brunei", "+673", ["Brunei Darussalam"]],
  ["BG", "Bulgaria", "+359"],
  ["BF", "Burkina Faso", "+226"],
  ["BI", "Burundi", "+257"],
  ["CV", "Cabo Verde", "+238", ["Cape Verde"]],
  ["KH", "Cambodia", "+855"],
  ["CM", "Cameroon", "+237"],
  ["CA", "Canada", "+1"],
  ["KY", "Cayman Islands", "+1"],
  ["CF", "Central African Republic", "+236"],
  ["TD", "Chad", "+235"],
  ["CL", "Chile", "+56"],
  ["CN", "China", "+86", ["PRC"]],
  ["CX", "Christmas Island", "+61"],
  ["CC", "Cocos (Keeling) Islands", "+61"],
  ["CO", "Colombia", "+57"],
  ["KM", "Comoros", "+269"],
  ["CG", "Congo", "+242", ["Republic of the Congo"]],
  ["CD", "Congo (DRC)", "+243", ["Democratic Republic of the Congo"]],
  ["CK", "Cook Islands", "+682"],
  ["CR", "Costa Rica", "+506"],
  ["CI", "Côte d'Ivoire", "+225", ["Ivory Coast"]],
  ["HR", "Croatia", "+385", ["Hrvatska"]],
  ["CU", "Cuba", "+53"],
  ["CW", "Curaçao", "+599"],
  ["CY", "Cyprus", "+357"],
  ["CZ", "Czechia", "+420", ["Czech Republic"]],
  ["DK", "Denmark", "+45", ["Danmark"]],
  ["DJ", "Djibouti", "+253"],
  ["DM", "Dominica", "+1"],
  ["DO", "Dominican Republic", "+1"],
  ["EC", "Ecuador", "+593"],
  ["EG", "Egypt", "+20"],
  ["SV", "El Salvador", "+503"],
  ["GQ", "Equatorial Guinea", "+240"],
  ["ER", "Eritrea", "+291"],
  ["EE", "Estonia", "+372"],
  ["SZ", "Eswatini", "+268", ["Swaziland"]],
  ["ET", "Ethiopia", "+251"],
  ["FK", "Falkland Islands", "+500"],
  ["FO", "Faroe Islands", "+298"],
  ["FJ", "Fiji", "+679"],
  ["FI", "Finland", "+358", ["Suomi"]],
  ["FR", "France", "+33"],
  ["GF", "French Guiana", "+594"],
  ["PF", "French Polynesia", "+689", ["Tahiti"]],
  ["TF", "French Southern Territories", "+262"],
  ["GA", "Gabon", "+241"],
  ["GM", "Gambia", "+220"],
  ["GE", "Georgia", "+995"],
  ["DE", "Germany", "+49", ["Deutschland"]],
  ["GH", "Ghana", "+233"],
  ["GI", "Gibraltar", "+350"],
  ["GR", "Greece", "+30", ["Hellas"]],
  ["GL", "Greenland", "+299"],
  ["GD", "Grenada", "+1"],
  ["GP", "Guadeloupe", "+590"],
  ["GU", "Guam", "+1"],
  ["GT", "Guatemala", "+502"],
  ["GG", "Guernsey", "+44"],
  ["GN", "Guinea", "+224"],
  ["GW", "Guinea-Bissau", "+245"],
  ["GY", "Guyana", "+592"],
  ["HT", "Haiti", "+509"],
  ["HM", "Heard Island and McDonald Islands", "+672"],
  ["HN", "Honduras", "+504"],
  ["HK", "Hong Kong", "+852"],
  ["HU", "Hungary", "+36", ["Magyarorszag"]],
  ["IS", "Iceland", "+354"],
  ["IN", "India", "+91"],
  ["ID", "Indonesia", "+62"],
  ["IR", "Iran", "+98"],
  ["IQ", "Iraq", "+964"],
  ["IE", "Ireland", "+353", ["Eire"]],
  ["IM", "Isle of Man", "+44"],
  ["IL", "Israel", "+972"],
  ["IT", "Italy", "+39", ["Italia"]],
  ["JM", "Jamaica", "+1"],
  ["JP", "Japan", "+81", ["Nippon"]],
  ["JE", "Jersey", "+44"],
  ["JO", "Jordan", "+962"],
  ["KZ", "Kazakhstan", "+7"],
  ["KE", "Kenya", "+254"],
  ["KI", "Kiribati", "+686"],
  ["XK", "Kosovo", "+383"],
  ["KW", "Kuwait", "+965"],
  ["KG", "Kyrgyzstan", "+996"],
  ["LA", "Laos", "+856", ["Lao"]],
  ["LV", "Latvia", "+371"],
  ["LB", "Lebanon", "+961"],
  ["LS", "Lesotho", "+266"],
  ["LR", "Liberia", "+231"],
  ["LY", "Libya", "+218"],
  ["LI", "Liechtenstein", "+423"],
  ["LT", "Lithuania", "+370"],
  ["LU", "Luxembourg", "+352"],
  ["MO", "Macao", "+853", ["Macau"]],
  ["MG", "Madagascar", "+261"],
  ["MW", "Malawi", "+265"],
  ["MY", "Malaysia", "+60"],
  ["MV", "Maldives", "+960"],
  ["ML", "Mali", "+223"],
  ["MT", "Malta", "+356"],
  ["MH", "Marshall Islands", "+692"],
  ["MQ", "Martinique", "+596"],
  ["MR", "Mauritania", "+222"],
  ["MU", "Mauritius", "+230"],
  ["YT", "Mayotte", "+262"],
  ["MX", "Mexico", "+52"],
  ["FM", "Micronesia", "+691"],
  ["MD", "Moldova", "+373"],
  ["MC", "Monaco", "+377"],
  ["MN", "Mongolia", "+976"],
  ["ME", "Montenegro", "+382"],
  ["MS", "Montserrat", "+1"],
  ["MA", "Morocco", "+212"],
  ["MZ", "Mozambique", "+258"],
  ["MM", "Myanmar", "+95", ["Burma"]],
  ["NA", "Namibia", "+264"],
  ["NR", "Nauru", "+674"],
  ["NP", "Nepal", "+977"],
  ["NL", "Netherlands", "+31", ["Holland", "Nederland"]],
  ["NC", "New Caledonia", "+687"],
  ["NZ", "New Zealand", "+64", ["Aotearoa"]],
  ["NI", "Nicaragua", "+505"],
  ["NE", "Niger", "+227"],
  ["NG", "Nigeria", "+234"],
  ["NU", "Niue", "+683"],
  ["NF", "Norfolk Island", "+672"],
  ["KP", "North Korea", "+850"],
  ["MK", "North Macedonia", "+389", ["Macedonia"]],
  ["MP", "Northern Mariana Islands", "+1"],
  ["NO", "Norway", "+47", ["Norge"]],
  ["OM", "Oman", "+968"],
  ["PK", "Pakistan", "+92"],
  ["PW", "Palau", "+680"],
  ["PS", "Palestine", "+970"],
  ["PA", "Panama", "+507"],
  ["PG", "Papua New Guinea", "+675"],
  ["PY", "Paraguay", "+595"],
  ["PE", "Peru", "+51"],
  ["PH", "Philippines", "+63"],
  ["PN", "Pitcairn Islands", "+64"],
  ["PL", "Poland", "+48", ["Polska"]],
  ["PT", "Portugal", "+351"],
  ["PR", "Puerto Rico", "+1"],
  ["QA", "Qatar", "+974"],
  ["RE", "Réunion", "+262"],
  ["RO", "Romania", "+40"],
  ["RU", "Russia", "+7", ["Russian Federation", "Rossiya"]],
  ["RW", "Rwanda", "+250"],
  ["BL", "Saint Barthélemy", "+590", ["St Barts"]],
  ["SH", "Saint Helena, Ascension and Tristan da Cunha", "+290"],
  ["KN", "Saint Kitts and Nevis", "+1", ["St Kitts"]],
  ["LC", "Saint Lucia", "+1", ["St Lucia"]],
  ["MF", "Saint Martin", "+590", ["St Martin"]],
  ["PM", "Saint Pierre and Miquelon", "+508"],
  ["VC", "Saint Vincent and the Grenadines", "+1", ["St Vincent"]],
  ["WS", "Samoa", "+685"],
  ["SM", "San Marino", "+378"],
  ["ST", "São Tomé and Príncipe", "+239"],
  ["SA", "Saudi Arabia", "+966", ["KSA"]],
  ["SN", "Senegal", "+221"],
  ["RS", "Serbia", "+381"],
  ["SC", "Seychelles", "+248"],
  ["SL", "Sierra Leone", "+232"],
  ["SG", "Singapore", "+65"],
  ["SX", "Sint Maarten", "+1"],
  ["SK", "Slovakia", "+421"],
  ["SI", "Slovenia", "+386"],
  ["SB", "Solomon Islands", "+677"],
  ["SO", "Somalia", "+252"],
  ["ZA", "South Africa", "+27", ["RSA"]],
  ["GS", "South Georgia and the South Sandwich Islands", "+500"],
  ["KR", "South Korea", "+82", ["Korea", "Republic of Korea"]],
  ["SS", "South Sudan", "+211"],
  ["ES", "Spain", "+34", ["Espana"]],
  ["LK", "Sri Lanka", "+94"],
  ["SD", "Sudan", "+249"],
  ["SR", "Suriname", "+597"],
  ["SJ", "Svalbard and Jan Mayen", "+47"],
  ["SE", "Sweden", "+46", ["Sverige"]],
  ["CH", "Switzerland", "+41", ["Schweiz", "Suisse"]],
  ["SY", "Syria", "+963"],
  ["TW", "Taiwan", "+886"],
  ["TJ", "Tajikistan", "+992"],
  ["TZ", "Tanzania", "+255"],
  ["TH", "Thailand", "+66", ["Siam", "Prathet Thai"]],
  ["TL", "Timor-Leste", "+670", ["East Timor"]],
  ["TG", "Togo", "+228"],
  ["TK", "Tokelau", "+690"],
  ["TO", "Tonga", "+676"],
  ["TT", "Trinidad and Tobago", "+1"],
  ["TN", "Tunisia", "+216"],
  ["TR", "Türkiye", "+90", ["Turkey"]],
  ["TM", "Turkmenistan", "+993"],
  ["TC", "Turks and Caicos Islands", "+1"],
  ["TV", "Tuvalu", "+688"],
  ["UG", "Uganda", "+256"],
  ["UA", "Ukraine", "+380"],
  ["AE", "United Arab Emirates", "+971", ["UAE", "Emirates", "Dubai"]],
  ["GB", "United Kingdom", "+44", ["UK", "Great Britain", "Britain", "England", "Scotland", "Wales", "Northern Ireland"]],
  ["US", "United States", "+1", ["USA", "US", "America", "United States of America"]],
  ["UM", "U.S. Outlying Islands", "+1"],
  ["VI", "U.S. Virgin Islands", "+1"],
  ["UY", "Uruguay", "+598"],
  ["UZ", "Uzbekistan", "+998"],
  ["VU", "Vanuatu", "+678"],
  ["VA", "Vatican City", "+39", ["Holy See"]],
  ["VE", "Venezuela", "+58"],
  ["VN", "Vietnam", "+84", ["Viet Nam"]],
  ["WF", "Wallis and Futuna", "+681"],
  ["EH", "Western Sahara", "+212"],
  ["YE", "Yemen", "+967"],
  ["ZM", "Zambia", "+260"],
  ["ZW", "Zimbabwe", "+263"],
];

export const COUNTRIES: Country[] = ROWS.map(([code, name, dial, aliases]) =>
  aliases ? { code, name, dial, aliases } : { code, name, dial },
);

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function getCountry(code: string | null | undefined): Country | undefined {
  return code ? BY_CODE.get(code.toUpperCase()) : undefined;
}

/**
 * The country whose dial code a "+N" value should display as. Prefers the
 * guest's own country (so +1 shows Canada for a Canadian), then the most
 * common owner of a shared code.
 */
const PREFERRED_FOR_DIAL: Record<string, string> = {
  "+1": "US",
  "+7": "RU",
  "+39": "IT",
  "+44": "GB",
  "+47": "NO",
  "+61": "AU",
  "+64": "NZ",
  "+212": "MA",
  "+262": "RE",
  "+358": "FI",
  "+590": "GP",
  "+599": "CW",
  "+672": "NF",
};

export function countryForDial(dial: string, hint?: string | null): Country | undefined {
  if (!dial) return undefined;
  const hinted = getCountry(hint);
  if (hinted && hinted.dial === dial) return hinted;
  const preferred = getCountry(PREFERRED_FOR_DIAL[dial]);
  if (preferred) return preferred;
  return COUNTRIES.find((c) => c.dial === dial);
}

/** Lowercase, accents removed - "Côte d'Ivoire" matches "cote". */
export function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const SEARCH_INDEX = COUNTRIES.map((c) => ({
  country: c,
  name: normalizeSearch(c.name),
  aliases: (c.aliases ?? []).map(normalizeSearch),
}));

/** Countries matching a typed query, best matches first (prefix, then word start, then anywhere). */
export function searchCountries(query: string): Country[] {
  const q = normalizeSearch(query);
  if (!q) return COUNTRIES;
  const scored: { country: Country; score: number }[] = [];
  for (const entry of SEARCH_INDEX) {
    let score = -1;
    const words = [entry.name, ...entry.aliases];
    if (entry.country.code.toLowerCase() === q || words.includes(q)) score = 0;
    else if (words.some((w) => w.startsWith(q))) score = 1;
    else if (words.some((w) => w.split(/[\s,()-]+/).some((part) => part.startsWith(q)))) score = 2;
    else if (words.some((w) => w.includes(q))) score = 3;
    else if (entry.country.dial === q || entry.country.dial === `+${q}`) score = 4;
    if (score >= 0) scored.push({ country: entry.country, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.country);
}

/** Exact (case/accent-insensitive) name or alias match, for browser autofill of "country-name". */
export function findCountryByName(value: string): Country | undefined {
  const q = normalizeSearch(value);
  if (!q) return undefined;
  return SEARCH_INDEX.find((e) => e.name === q || e.aliases.includes(q))?.country;
}
