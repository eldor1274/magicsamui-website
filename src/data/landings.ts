// Localized landing pages: one purpose-built page per language, targeting what
// travellers actually search in that language, with hreflang tying the set
// together. The full site stays English; these pages funnel to /booking and
// WhatsApp, both of which work in any language.

export interface LandingPerk {
  title: string;
  text: string;
}

export interface Landing {
  code: string; // URL segment and hreflang code
  htmlLang: string;
  dir: "ltr" | "rtl";
  label: string; // native-script name, used in language switchers
  title: string;
  description: string;
  eyebrow: string;
  h1: string;
  sub: string;
  ctaBook: string;
  ctaWhats: string;
  roomsTitle: string;
  roomsSub: string;
  viewAll: string;
  guestsWord: string;
  perksTitle: string;
  perks: LandingPerk[];
  reviewsLine: string;
  locationTitle: string;
  locationText: string;
  ctaTitle: string;
  ctaText: string;
  langNote: string;
}

/** hreflang cluster shared by the English homepage and every landing. */
export const LANG_ALTERNATES: Record<string, string> = {
  "x-default": "/",
  en: "/",
  he: "/he",
  ru: "/ru",
  fr: "/fr",
  zh: "/zh",
  es: "/es",
  th: "/th",
};

export const LANG_LINKS = [
  { code: "en", href: "/", label: "English" },
  { code: "he", href: "/he", label: "עברית" },
  { code: "ru", href: "/ru", label: "Русский" },
  { code: "fr", href: "/fr", label: "Français" },
  { code: "zh", href: "/zh", label: "中文" },
  { code: "es", href: "/es", label: "Español" },
  { code: "th", href: "/th", label: "ไทย" },
];

export const landings: Record<string, Landing> = {
  he: {
    code: "he",
    htmlLang: "he",
    dir: "rtl",
    label: "עברית",
    title: "וילות יוקרה עם בריכה פרטית בקוסמוי | Magic Suites",
    description:
      "וילות וסוויטות על צלע הר בקוסמוי, לכל אחת בריכה פרטית ונוף לים. ציון 9.8 בבוקינג. 5 דקות מהחוף — הזמינו ישירות וקבלו את המחיר הטוב ביותר.",
    eyebrow: "קוסמוי, תאילנד",
    h1: "וילות עם בריכה פרטית בקוסמוי",
    sub: "2 וילות ו־4 סוויטות פרטיות — לכל אחת בריכה משלה, על צלע הר מעל מפרץ תאילנד, 5 דקות מהחוף.",
    ctaBook: "הזמינו עכשיו",
    ctaWhats: "דברו איתנו בוואטסאפ",
    roomsTitle: "הווילות והסוויטות שלנו",
    roomsSub: "כל יחידה פרטית לגמרי — עם בריכה, מרפסת ונוף לים.",
    viewAll: "לכל הווילות והסוויטות",
    guestsWord: "אורחים",
    perksTitle: "למה להזמין ישירות?",
    perks: [
      { title: "המחיר הטוב ביותר, תמיד", text: "קוד DIRECT בתשלום — זול יותר מכל אתר הזמנות." },
      { title: "הסעה חינם משדה התעופה", text: "טרנספר חינם בשהייה של שני לילות ומעלה." },
      { title: "קשר ישיר עם המארח", text: "וואטסאפ איתנו לפני, במהלך ואחרי השהייה." },
      { title: "הגעה גמישה", text: "אפשר להשאיר מזוודות בכל שעה — רק תעדכנו מראש." },
    ],
    reviewsLine: "ציון 9.8 ״יוצא מן הכלל״ בבוקינג · 4.96 ב־Airbnb",
    locationTitle: "המיקום",
    locationText:
      "אנחנו בצ׳ונג מון (פלאי לאם) — פינה שקטה ויוקרתית של קוסמוי: 3 ק״מ משדה התעופה, ליד הבודהה הגדול, ו־7 דקות נסיעה מצ׳אוונג ומכפר הדייגים.",
    ctaTitle: "מוכנים לסמוי?",
    ctaText:
      "כתבו לנו בוואטסאפ — אלדור, המארח, גר באי יותר מ־12 שנה וישמח לעזור בתכנון. מדברים עברית.",
    langNote: "האתר המלא באנגלית",
  },

  ru: {
    code: "ru",
    htmlLang: "ru",
    dir: "ltr",
    label: "Русский",
    title: "Виллы с частным бассейном на Самуи | Magic Suites",
    description:
      "Виллы и люксы на холме с видом на море на Ко Самуи — у каждой собственный бассейн. 9,8 на Booking.com. 5 минут до пляжа. Бронируйте напрямую по лучшей цене.",
    eyebrow: "Ко Самуи, Таиланд",
    h1: "Виллы с частным бассейном на Самуи",
    sub: "2 виллы и 4 люкса — каждый со своим бассейном, на холме над Сиамским заливом, всего в 5 минутах от пляжа.",
    ctaBook: "Забронировать",
    ctaWhats: "Написать в WhatsApp",
    roomsTitle: "Наши виллы и люксы",
    roomsSub: "Каждый номер полностью приватный: свой бассейн, терраса и вид на море.",
    viewAll: "Все виллы и люксы",
    guestsWord: "гостей",
    perksTitle: "Почему бронировать напрямую",
    perks: [
      { title: "Лучшая цена — всегда", text: "Промокод DIRECT при оформлении дешевле любого сайта бронирования." },
      { title: "Бесплатный трансфер из аэропорта", text: "Для проживания от 2 ночей." },
      { title: "Прямая связь с хозяином", text: "WhatsApp до, во время и после поездки." },
      { title: "Гибкое заселение", text: "Оставьте багаж в любое время — просто предупредите нас." },
    ],
    reviewsLine: "9,8 «Исключительно» на Booking.com · 4,96 на Airbnb",
    locationTitle: "Расположение",
    locationText:
      "Мы в районе Чонг Мон (Плай Лаем) — тихом и престижном уголке Самуи: 3 км от аэропорта, рядом Биг Будда, 7 минут на машине до Чавенга и Рыбацкой деревни.",
    ctaTitle: "Готовы на Самуи?",
    ctaText:
      "Напишите нам в WhatsApp — хозяин Эльдор живёт на острове больше 12 лет и поможет спланировать поездку. Говорим по-русски.",
    langNote: "Полная версия сайта — на английском",
  },

  fr: {
    code: "fr",
    htmlLang: "fr",
    dir: "ltr",
    label: "Français",
    title: "Villas avec piscine privée à Koh Samui | Magic Suites",
    description:
      "Villas et suites à flanc de colline avec vue mer à Koh Samui, chacune avec piscine privée. Note 9,8 sur Booking.com. Plage à 5 minutes — réservez en direct au meilleur tarif.",
    eyebrow: "Koh Samui, Thaïlande",
    h1: "Villas avec piscine privée à Koh Samui",
    sub: "2 villas et 4 suites privées — chacune avec sa piscine, à flanc de colline au-dessus du golfe de Thaïlande, à 5 minutes de la plage.",
    ctaBook: "Réserver",
    ctaWhats: "Écrivez-nous sur WhatsApp",
    roomsTitle: "Nos villas et suites",
    roomsSub: "Chaque logement est entièrement privé : piscine, terrasse et vue mer.",
    viewAll: "Voir toutes les villas et suites",
    guestsWord: "personnes",
    perksTitle: "Pourquoi réserver en direct ?",
    perks: [
      { title: "Le meilleur tarif, toujours", text: "Le code DIRECT au paiement bat tous les sites de réservation." },
      { title: "Transfert aéroport offert", text: "Navette gratuite dès 2 nuits." },
      { title: "Contact direct avec l’hôte", text: "WhatsApp avant, pendant et après votre séjour." },
      { title: "Arrivée flexible", text: "Déposez vos bagages à toute heure — prévenez-nous simplement." },
    ],
    reviewsLine: "9,8 « Exceptionnel » sur Booking.com · 4,96 sur Airbnb",
    locationTitle: "Emplacement",
    locationText:
      "Nous sommes à Choeng Mon (Plai Laem), un coin calme et résidentiel de Koh Samui : aéroport à 3 km, Big Bouddha tout proche, Chaweng et le Fisherman's Village à 7 minutes en voiture.",
    ctaTitle: "Prêts pour Samui ?",
    ctaText:
      "Écrivez-nous sur WhatsApp — Eldor, votre hôte, vit sur l’île depuis plus de 12 ans et vous aidera à organiser votre séjour.",
    langNote: "Site complet en anglais",
  },

  zh: {
    code: "zh",
    htmlLang: "zh-Hans",
    dir: "ltr",
    label: "中文",
    title: "苏梅岛私人泳池别墅 | Magic Suites",
    description:
      "苏梅岛山坡海景别墅与套房，每间均配私人泳池。Booking.com 评分 9.8。距海滩仅 5 分钟——直接预订享最优价格。",
    eyebrow: "泰国 · 苏梅岛",
    h1: "苏梅岛私人泳池别墅",
    sub: "2 栋别墅与 4 间私享套房——每间都有专属泳池，坐落于俯瞰泰国湾的山坡上，距海滩仅 5 分钟。",
    ctaBook: "立即预订",
    ctaWhats: "WhatsApp 联系我们",
    roomsTitle: "别墅与套房",
    roomsSub: "每间均完全独立：私人泳池、露台与海景。",
    viewAll: "查看全部别墅与套房",
    guestsWord: "位客人",
    perksTitle: "为什么直接预订",
    perks: [
      { title: "始终最优价", text: "结账时使用 DIRECT 优惠码，比任何预订网站都划算。" },
      { title: "免费机场接送", text: "入住 2 晚及以上免费接送。" },
      { title: "直连房东", text: "入住前后随时通过 WhatsApp 联系我们。" },
      { title: "灵活抵达", text: "任何时间都可寄存行李——提前告知即可。" },
    ],
    reviewsLine: "Booking.com 9.8 分「超棒」 · Airbnb 4.96 分",
    locationTitle: "位置",
    locationText:
      "我们位于苏梅岛安静高档的乔蒙区（Plai Laem）：距机场 3 公里，紧邻大佛寺，驱车 7 分钟即达查汶海滩和渔人村。",
    ctaTitle: "准备好来苏梅岛了吗？",
    ctaText: "通过 WhatsApp 联系我们——房东 Eldor 在岛上生活超过 12 年，很乐意帮您规划行程。",
    langNote: "查看英文完整网站",
  },

  es: {
    code: "es",
    htmlLang: "es",
    dir: "ltr",
    label: "Español",
    title: "Villas con piscina privada en Koh Samui | Magic Suites",
    description:
      "Villas y suites en la ladera con vistas al mar en Koh Samui, cada una con piscina privada. 9,8 en Booking.com. Playa a 5 minutos: reserva directa al mejor precio.",
    eyebrow: "Koh Samui, Tailandia",
    h1: "Villas con piscina privada en Koh Samui",
    sub: "2 villas y 4 suites privadas, cada una con su propia piscina, en una ladera sobre el golfo de Tailandia, a solo 5 minutos de la playa.",
    ctaBook: "Reservar ahora",
    ctaWhats: "Escríbenos por WhatsApp",
    roomsTitle: "Nuestras villas y suites",
    roomsSub: "Cada alojamiento es totalmente privado: piscina, terraza y vistas al mar.",
    viewAll: "Ver todas las villas y suites",
    guestsWord: "huéspedes",
    perksTitle: "Por qué reservar directo",
    perks: [
      { title: "El mejor precio, siempre", text: "El código DIRECT al pagar supera a cualquier web de reservas." },
      { title: "Traslado gratis desde el aeropuerto", text: "Gratuito en estancias de 2 noches o más." },
      { title: "Línea directa con el anfitrión", text: "WhatsApp antes, durante y después de tu estancia." },
      { title: "Llegada flexible", text: "Deja tu equipaje a cualquier hora; solo avísanos." },
    ],
    reviewsLine: "9,8 «Excepcional» en Booking.com · 4,96 en Airbnb",
    locationTitle: "Ubicación",
    locationText:
      "Estamos en Choeng Mon (Plai Laem), un rincón tranquilo y exclusivo de Koh Samui: a 3 km del aeropuerto, junto al Gran Buda y a 7 minutos en coche de Chaweng y el Fisherman's Village.",
    ctaTitle: "¿Listo para Samui?",
    ctaText:
      "Escríbenos por WhatsApp: Eldor, tu anfitrión, vive en la isla desde hace más de 12 años y te ayudará a planear tu viaje.",
    langNote: "Web completa en inglés",
  },

  th: {
    code: "th",
    htmlLang: "th",
    dir: "ltr",
    label: "ไทย",
    title: "พูลวิลล่าส่วนตัว เกาะสมุย | Magic Suites",
    description:
      "วิลล่าและห้องสวีทวิวทะเลบนเนินเขาเกาะสมุย ทุกหลังมีสระว่ายน้ำส่วนตัว คะแนน 9.8 บน Booking.com ห่างหาด 5 นาที จองตรงราคาดีที่สุด",
    eyebrow: "เกาะสมุย ประเทศไทย",
    h1: "พูลวิลล่าส่วนตัวบนเกาะสมุย",
    sub: "วิลล่า 2 หลังและสวีทส่วนตัว 4 ห้อง ทุกยูนิตมีสระส่วนตัว ตั้งอยู่บนเนินเขามองเห็นอ่าวไทย ห่างจากหาดเพียง 5 นาที",
    ctaBook: "จองเลย",
    ctaWhats: "แชท WhatsApp",
    roomsTitle: "วิลล่าและสวีทของเรา",
    roomsSub: "ทุกยูนิตเป็นส่วนตัวทั้งหมด มีสระ ระเบียง และวิวทะเล",
    viewAll: "ดูวิลล่าและสวีททั้งหมด",
    guestsWord: "ท่าน",
    perksTitle: "ทำไมต้องจองตรง",
    perks: [
      { title: "ราคาดีที่สุดเสมอ", text: "ใส่โค้ด DIRECT ตอนชำระเงิน ถูกกว่าทุกเว็บจอง" },
      { title: "รับส่งสนามบินฟรี", text: "ฟรีเมื่อเข้าพัก 2 คืนขึ้นไป" },
      { title: "ติดต่อเจ้าของโดยตรง", text: "WhatsApp ได้ทั้งก่อน ระหว่าง และหลังเข้าพัก" },
      { title: "เช็คอินยืดหยุ่น", text: "ฝากกระเป๋าได้ทุกเวลา เพียงแจ้งล่วงหน้า" },
    ],
    reviewsLine: "9.8 “ยอดเยี่ยม” บน Booking.com · 4.96 บน Airbnb",
    locationTitle: "ทำเลที่ตั้ง",
    locationText:
      "เราอยู่ที่เชิงมน (พลายแหลม) มุมเงียบสงบของเกาะสมุย ห่างสนามบิน 3 กม. ใกล้พระใหญ่ ขับรถ 7 นาทีถึงเฉวงและฟิชเชอร์แมนวิลเลจ",
    ctaTitle: "พร้อมมาสมุยหรือยัง?",
    ctaText:
      "ทักเราทาง WhatsApp ได้เลย — คุณเอลดอร์เจ้าของที่พักอยู่บนเกาะมากว่า 12 ปี ยินดีช่วยวางแผนทริป พูดไทยได้",
    langNote: "เว็บไซต์ฉบับเต็มภาษาอังกฤษ",
  },
};
