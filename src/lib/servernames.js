// Server names in the extension language (shared rule of all Colitu apps,
// 2026-10-12). The panel sends a node's name and city in Turkish ("Almanya",
// "Londra", "Letonya (Köprü)"). They are matched case- and
// diacritic-insensitively against the Turkish, English and Russian names (and
// a few aliases) and shown in the chosen language; text that matches nothing
// stays exactly as the panel sent it. The tables are built in: nothing is
// fetched or read at run time.

// [code, en, ru, tr]
const COUNTRIES = [
  ["AE", "United Arab Emirates", "ОАЭ", "BAE"],
  ["AL", "Albania", "Албания", "Arnavutluk"],
  ["AM", "Armenia", "Армения", "Ermenistan"],
  ["AR", "Argentina", "Аргентина", "Arjantin"],
  ["AT", "Austria", "Австрия", "Avusturya"],
  ["AU", "Australia", "Австралия", "Avustralya"],
  ["AZ", "Azerbaijan", "Азербайджан", "Azerbaycan"],
  ["BE", "Belgium", "Бельгия", "Belçika"],
  ["BG", "Bulgaria", "Болгария", "Bulgaristan"],
  ["BR", "Brazil", "Бразилия", "Brezilya"],
  ["BY", "Belarus", "Беларусь", "Belarus"],
  ["CA", "Canada", "Канада", "Kanada"],
  ["CH", "Switzerland", "Швейцария", "İsviçre"],
  ["CN", "China", "Китай", "Çin"],
  ["CY", "Cyprus", "Кипр", "Kıbrıs"],
  ["CZ", "Czechia", "Чехия", "Çekya"],
  ["DE", "Germany", "Германия", "Almanya"],
  ["DK", "Denmark", "Дания", "Danimarka"],
  ["EE", "Estonia", "Эстония", "Estonya"],
  ["ES", "Spain", "Испания", "İspanya"],
  ["FI", "Finland", "Финляндия", "Finlandiya"],
  ["FR", "France", "Франция", "Fransa"],
  ["GB", "United Kingdom", "Великобритания", "Birleşik Krallık"],
  ["GE", "Georgia", "Грузия", "Gürcistan"],
  ["GR", "Greece", "Греция", "Yunanistan"],
  ["HK", "Hong Kong", "Гонконг", "Hong Kong"],
  ["HU", "Hungary", "Венгрия", "Macaristan"],
  ["IE", "Ireland", "Ирландия", "İrlanda"],
  ["IL", "Israel", "Израиль", "İsrail"],
  ["IN", "India", "Индия", "Hindistan"],
  ["IS", "Iceland", "Исландия", "İzlanda"],
  ["IT", "Italy", "Италия", "İtalya"],
  ["JP", "Japan", "Япония", "Japonya"],
  ["KR", "South Korea", "Южная Корея", "Güney Kore"],
  ["KZ", "Kazakhstan", "Казахстан", "Kazakistan"],
  ["LT", "Lithuania", "Литва", "Litvanya"],
  ["LU", "Luxembourg", "Люксембург", "Lüksemburg"],
  ["LV", "Latvia", "Латвия", "Letonya"],
  ["MD", "Moldova", "Молдова", "Moldova"],
  ["NL", "Netherlands", "Нидерланды", "Hollanda"],
  ["NO", "Norway", "Норвегия", "Norveç"],
  ["PL", "Poland", "Польша", "Polonya"],
  ["PT", "Portugal", "Португалия", "Portekiz"],
  ["RO", "Romania", "Румыния", "Romanya"],
  ["RS", "Serbia", "Сербия", "Sırbistan"],
  ["RU", "Russia", "Россия", "Rusya"],
  ["SE", "Sweden", "Швеция", "İsveç"],
  ["SG", "Singapore", "Сингапур", "Singapur"],
  ["SK", "Slovakia", "Словакия", "Slovakya"],
  ["TR", "Türkiye", "Турция", "Türkiye"],
  ["UA", "Ukraine", "Украина", "Ukrayna"],
  ["US", "United States", "США", "ABD"],
  ["UZ", "Uzbekistan", "Узбекистан", "Özbekistan"],
];

const COUNTRY_ALIASES = {
  AE: ["UAE", "Birleşik Arap Emirlikleri", "Объединённые Арабские Эмираты"],
  CZ: ["Czech Republic", "Çek Cumhuriyeti", "Чешская Республика"],
  GB: ["UK", "Great Britain", "England", "İngiltere", "Британия", "Англия"],
  KR: ["Korea", "Kore", "Корея"],
  NL: ["Holland", "The Netherlands", "Голландия"],
  TR: ["Turkey", "Turkiye"],
  US: ["USA", "United States of America", "Amerika", "Amerika Birleşik Devletleri", "Соединённые Штаты"],
};

// { en, ru, tr, aliases }
const CITIES = [
  { en: "Tirana", ru: "Тирана", tr: "Tiran", aliases: ["Tirana"] },
  { en: "Melbourne", ru: "Мельбурн", tr: "Melbourne" },
  { en: "São Paulo", ru: "Сан-Паулу", tr: "São Paulo", aliases: ["Sao Paulo"] },
  { en: "Frankfurt", ru: "Франкфурт", tr: "Frankfurt" },
  { en: "Berlin", ru: "Берлин", tr: "Berlin" },
  { en: "Tallinn", ru: "Таллин", tr: "Tallinn" },
  { en: "Tartu", ru: "Тарту", tr: "Tartu" },
  { en: "Madrid", ru: "Мадрид", tr: "Madrid" },
  { en: "Helsinki", ru: "Хельсинки", tr: "Helsinki" },
  { en: "Paris", ru: "Париж", tr: "Paris" },
  { en: "London", ru: "Лондон", tr: "Londra" },
  { en: "Coventry", ru: "Ковентри", tr: "Coventry" },
  { en: "Thessaloniki", ru: "Салоники", tr: "Selanik" },
  { en: "Tel Aviv", ru: "Тель-Авив", tr: "Tel Aviv", aliases: ["Tel-Aviv"] },
  { en: "Tokyo", ru: "Токио", tr: "Tokyo" },
  { en: "Almaty", ru: "Алматы", tr: "Almatı" },
  { en: "Vilnius", ru: "Вильнюс", tr: "Vilnius" },
  { en: "Riga", ru: "Рига", tr: "Riga" },
  { en: "Kerkrade", ru: "Керкраде", tr: "Kerkrade" },
  { en: "Dronten", ru: "Дронтен", tr: "Dronten" },
  { en: "Warsaw", ru: "Варшава", tr: "Varşova" },
  { en: "Moscow", ru: "Москва", tr: "Moskova" },
  { en: "Singapore", ru: "Сингапур", tr: "Singapur" },
  { en: "Bursa", ru: "Бурса", tr: "Bursa" },
  { en: "Kyiv", ru: "Киев", tr: "Kiev", aliases: ["Kyiv"] },
  { en: "Dallas", ru: "Даллас", tr: "Dallas" },
  { en: "Amsterdam", ru: "Амстердам", tr: "Amsterdam" },
  { en: "Istanbul", ru: "Стамбул", tr: "İstanbul" },
  { en: "Ankara", ru: "Анкара", tr: "Ankara" },
  { en: "Stockholm", ru: "Стокгольм", tr: "Stockholm" },
  { en: "Vienna", ru: "Вена", tr: "Viyana" },
  { en: "Zurich", ru: "Цюрих", tr: "Zürih" },
  { en: "Prague", ru: "Прага", tr: "Prag" },
  { en: "Bucharest", ru: "Бухарест", tr: "Bükreş" },
  { en: "Sofia", ru: "София", tr: "Sofya" },
  { en: "Budapest", ru: "Будапешт", tr: "Budapeşte" },
  { en: "Athens", ru: "Афины", tr: "Atina" },
  { en: "Belgrade", ru: "Белград", tr: "Belgrad" },
  { en: "Yerevan", ru: "Ереван", tr: "Erivan" },
  { en: "Tbilisi", ru: "Тбилиси", tr: "Tiflis" },
  { en: "Baku", ru: "Баку", tr: "Bakü" },
  { en: "Dubai", ru: "Дубай", tr: "Dubai" },
  { en: "Copenhagen", ru: "Копенгаген", tr: "Kopenhag" },
  { en: "Oslo", ru: "Осло", tr: "Oslo" },
  { en: "Milan", ru: "Милан", tr: "Milano" },
  { en: "Rome", ru: "Рим", tr: "Roma" },
  { en: "Munich", ru: "Мюнхен", tr: "Münih" },
  { en: "Düsseldorf", ru: "Дюссельдорф", tr: "Düsseldorf" },
  { en: "Nuremberg", ru: "Нюрнберг", tr: "Nürnberg" },
  { en: "New York", ru: "Нью-Йорк", tr: "New York" },
  { en: "Los Angeles", ru: "Лос-Анджелес", tr: "Los Angeles" },
  { en: "Miami", ru: "Майами", tr: "Miami" },
  { en: "Toronto", ru: "Торонто", tr: "Toronto" },
  { en: "Montreal", ru: "Монреаль", tr: "Montreal" },
  { en: "Sydney", ru: "Сидней", tr: "Sidney" },
  { en: "Hong Kong", ru: "Гонконг", tr: "Hong Kong" },
  { en: "Seoul", ru: "Сеул", tr: "Seul" },
];

const SUFFIXES = [
  { en: "Bridge", ru: "Мост", tr: "Köprü" },
];

const LANGS = ["en", "ru", "tr"];
const FOLDS = { ı: "i", ş: "s", ğ: "g", ß: "ss", ø: "o", ё: "е", й: "и" };

// normalize: lower case, no diacritics, single spaces (the matching key).
export function normalize(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[ışğßøёй]/g, (c) => FOLDS[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function index(rows, names) {
  const map = new Map();
  for (const row of rows) for (const name of names(row)) map.set(normalize(name), row);
  return map;
}

const cityIndex = index(CITIES, (c) => [c.en, c.ru, c.tr, ...(c.aliases || [])]);
const suffixIndex = index(SUFFIXES, (s) => [s.en, s.ru, s.tr]);
const countryByCode = new Map(COUNTRIES.map(([code, en, ru, tr]) => [code, { en, ru, tr }]));
const countryIndex = new Map();
for (const [code, en, ru, tr] of COUNTRIES) for (const name of [en, ru, tr]) countryIndex.set(normalize(name), code);
for (const [code, names] of Object.entries(COUNTRY_ALIASES)) for (const name of names) countryIndex.set(normalize(name), code);

const pick = (row, lang) => row[LANGS.includes(lang) ? lang : "en"];

// countryCodeFor: the code of a country named in any language (or by alias).
export function countryCodeFor(name) {
  return countryIndex.get(normalize(name)) || null;
}

// countryLabel: a country code's name in `lang`, or null when unknown.
export function countryLabel(code, lang) {
  const row = countryByCode.get(String(code ?? "").toUpperCase());
  return row ? pick(row, lang) : null;
}

// cityName: a city in `lang`; unknown text as it is.
export function cityName(raw, lang) {
  const text = String(raw ?? "").trim();
  if (!text) return text;
  const row = cityIndex.get(normalize(text));
  return row ? pick(row, lang) : text;
}

// displayName: "Letonya (Köprü)" -> "Latvia (Bridge)". The part before a
// trailing "(...)" becomes the country name when it is `countryCode` or a
// known country name; a known suffix is translated, another stays.
export function displayName(raw, lang, countryCode) {
  const text = String(raw ?? "").trim();
  if (!text) return text;
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(text);
  const head = (m ? m[1] : text).trim();
  const suffix = m ? m[2].trim() : null;
  const cc = String(countryCode ?? "").trim().toUpperCase();
  let code = null;
  if (head && cc.length === 2 && normalize(head) === normalize(cc)) code = cc;
  else if (head.length === 2 && countryByCode.has(head.toUpperCase())) code = head.toUpperCase();
  else if (head) code = countryCodeFor(head);
  let localized;
  if (code && countryByCode.has(code)) localized = countryLabel(code, lang);
  else {
    const city = cityIndex.get(normalize(head));
    if (!city && !m) return text;
    localized = city ? pick(city, lang) : head;
  }
  if (suffix === null) return localized;
  if (!head) return text;
  const s = suffixIndex.get(normalize(suffix));
  return `${localized} (${s ? pick(s, lang) : suffix})`;
}

// routeName: "Varşova → Frankfurt", each end localized.
export function routeName(raw, lang) {
  const text = String(raw ?? "").trim();
  if (!text.includes("→")) return displayName(text, lang);
  return text.split("→").map((part) => displayName(part, lang)).join(" → ");
}

// isBridgeName: the name ends in the bridge suffix in any language ("Letonya
// (Köprü)", "Латвия (Мост)", "Latvia (Bridge)"): a node whose entry address is
// in Russia and whose traffic leaves abroad (its country is the exit's).
export function isBridgeName(raw) {
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(String(raw ?? "").trim());
  return Boolean(m && m[1].trim() && suffixIndex.has(normalize(m[2].trim())));
}
