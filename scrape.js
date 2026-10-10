#!/usr/bin/env node
/**
 scrape.js — jednorazowy parser harmonogramu Festiwalu Kamera Akcja 2026
 Wejście: HTML ze strony https://kameraakcja.com.pl/edycja-2026/harmonogram-godzinowy/
 Wyjście: data/screenings.json

 Użycie:
   node scrape.js                                   # fetch ze strony
   node scrape.js --input path/do/pliku.html         # z lokalnego pliku
   node scrape.js --input -                         # ze stdin
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const URL = 'https://kameraakcja.com.pl/edycja-2026/harmonogram-godzinowy/';

// ============ Pomocnicze ============
function stripTags(s) {
  s = s
    .replace(/&#8217;/g, "'") // ’ — right single quote (encoded)
    .replace(/&#8242;/g, "'") // ′ — prime (encoded)
    .replace(/&#8243;/g, '"') // ″ — double prime
    .replace(/&#039;/g, "'") // ' — apostrophe (encoded)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  // Również literalne znaki Unicode (bez encji) — normalizujemy do ASCII apostrofu
  s = s
    .replace(/\u2019/g, "'") // ’ — right single quotation mark
    .replace(/\u2032/g, "'") // ′ — prime
    .replace(/\u2033/g, '"') // ″ — double prime
    .replace(/\u2018/g, "'") // ‘ — left single quotation mark
    .replace(/\u201c/g, '"') // “ — left double quotation mark
    .replace(/\u201d/g, '"'); // ” — right double quotation mark
  s = s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function extractParagraphs(html) {
  // Strona festiwalu ma niezamknięte <p> — non-greedy regex <p[^>]*>([\s\S]*?)<\/p>
  // łapie tylko część treści. Rozwiązanie: iterujemy po początkach <p> i dopasowujemy
  // do najbliższego </p>, który nie należy do następnego <p>.
  const out = [];
  const reStart = /<p\b[^>]*>/gi;
  const reEnd = /<\/p>/gi;
  const starts = [];
  let m;
  while ((m = reStart.exec(html)) !== null) starts.push(m.index);
  const ends = [];
  while ((m = reEnd.exec(html)) !== null) ends.push(m.index);
  let endIdx = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    while (endIdx < ends.length && ends[endIdx] <= start) endIdx++;
    if (endIdx >= ends.length) break;
    const nextStart = i + 1 < starts.length ? starts[i + 1] : html.length;
    if (nextStart < ends[endIdx]) {
      // <p> nie jest zamknięty przed następnym — treść do następnego <p>
      out.push(html.slice(start, nextStart));
    } else {
      out.push(html.slice(start, ends[endIdx] + 4));
      endIdx++;
    }
  }
  return out;
}

// ============ Mapa lokacji -> venueGroup ============
const VENUE_RULES = [
  { re: /Scena Monopolis|Galeria Monopolis|\bMonopolis\]/i, group: 'monopolis', name: 'Monopolis' },
  { re: /Muzeum Kinematografii/i, group: 'muzeum-kinematografii', name: 'Muzeum Kinematografii' },
  { re: /Niebostan|Piotrkowska 17/i, group: 'niebostan', name: 'Niebostan / Piotrkowska 17' },
  { re: /TOYA Studios|Łąkowa 29a/i, group: 'toya-studios', name: 'TOYA Studios' },
  { re: /Boutique Hotel/i, group: 'boutique-hotel', name: 'Boutique Hotel' },
  // Szkoła Filmowa — kolejność ma znaczenie (najpierw CNM, potem H, Z, bazowy)
  { re: /Szkoła Filmowa w Łodzi \(Budynek CNM\)/i, group: 'szkola-filmowa-cnm', name: 'Szkoła Filmowa - Budynek CNM' },
  { re: /Szkoła Filmowa w Łodzi \(Wydział Aktorski, Budynek H\)/i, group: 'szkola-filmowa-h', name: 'Szkoła Filmowa - Wydział Aktorski, Budynek H' },
  { re: /Szkoła Filmowa w Łodzi,?\s*Budynek Z|Szkoła Filmowa w Łodzi\s*\(Budynek Z\)/i, group: 'szkola-filmowa-z', name: 'Szkoła Filmowa - Budynek Z' },
  { re: /Szkoła Filmowa w Łodzi\b/i, group: 'szkola-filmowa', name: 'Szkoła Filmowa w Łodzi' },
];

function detectVenue(text) {
  const bracketMatches = [...text.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  const candidates = bracketMatches.length ? bracketMatches : [text];
  for (const c of candidates) {
    for (const rule of VENUE_RULES) {
      if (rule.re.test(c)) return rule;
    }
  }
  return null;
}

// ============ Ekstrakcja linku do pokazu ============
// Pokazy są linkowane jako /pokaz/... lub /wydarzenie/... (specjalne pokazy z dyskusją).
// Jako "link do pokazu" traktujemy pierwszy link do podstrony kamery akcji w paragrafie.
function extractShowLink(paragraphHtml) {
  const m = paragraphHtml.match(/<a[^>]+href="(https:\/\/kameraakcja\.com\.pl\/(?:pokaz|wydarzenie)\/[^"]+)"/);
  return m ? m[1] : null;
}

function extractShowTitle(paragraphHtml) {
  const m = paragraphHtml.match(/<a[^>]+href="https:\/\/kameraakcja\.com\.pl\/(?:pokaz|wydarzenie)\/[^"]+"[^>]*>([\s\S]*?)<\/a>/);
  if (!m) return '';
  // Wycinamy tylko pierwszy kawałek — tytuł, a nie cały opis (Q&A, intro itp.)
  // Tytuł kończy się przed pierwszą informacją o reżyserze / runtime / dodatkach.
  let raw = stripTags(m[1]);
  // Odetnij wszystko od "reż." (bo to w środku tytułu bywa część opisu, np. specjalne pokazy)
  const cut = raw.search(/\s+re\.?[żz]\.\s+/i);
  if (cut > 0) raw = raw.slice(0, cut);
  return raw.trim();
}

// ============ Kategoryzacja: film vs wydarzenie ============
function isFilmEvent(text) {
  if (/(otwarcie recepcji|otwarcie festiwalu|klub festiwalowy|afterparty)/i.test(text)) return false;
  if (/FILM DOSTĘPNY Z AUDIODESKRYPCJ/i.test(text)) return true;
  if (/reż\.?\s/i.test(text)) return true;
  if (/pokaz przedpremierowy|polska premiera/i.test(text)) return true;
  return false;
}

// ============ Ekstrakcja runtime ============
// Pierwsze "(XX')" w tekście to runtime filmu. Kolejne, oznaczone jako "+ Q&A" lub "+ INTRO",
// to dodatkowe bloki (już obsłużone w parseExtraMinutes). Jeśli w tekście jest kilka "(XX')"
// bez znacznika + / Q&A / INTRO (np. specjalny pokaz "film (45') + dyskusja (100')"),
// traktujemy pierwsze jako runtime i kolejne jako część tego samego wydarzenia.
function parseRuntime(text) {
  // Najpierw szukamy "(XX')" tuż przed "+ Q&A" / "+ INTRO" / "+ dyskusja" — jeśli jest, to runtime filmu
  const explicit = text.match(/\((\d{1,3})\s*['′]\)\s*(?:\+\s*(?:Q&A|INTRO|INTRO Nauka|dyskusja))/i);
  if (explicit) return parseInt(explicit[1], 10);
  // W przeciwnym razie bierzemy pierwsze wystąpienie
  const m = text.match(/\((\d{1,3})\s*['′]\)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseExtraMinutes(text) {
  let total = 0;
  // Najpierw jawne znaczniki + Q&A / + INTRO
  for (const re of [
    /\+\s*Q&A\s*\((\d{1,3})\s*['′]\)/i,
    /\+\s*INTRO\s*\((\d{1,3})\s*['′]\)/i,
    /INTRO Nauka Inspiruje UŁ\s*\((\d{1,3})\s*['′']\)/i,
  ]) {
    const m = text.match(re);
    if (m) total += parseInt(m[1], 10);
  }
  // Jeśli nie ma jawnych znaczników, ale są dodatkowe "(XX')" po pierwszym runtime
  // (np. specjalny pokaz "film (45') + dyskusja (100')"), dodaj różnicę.
  if (total === 0) {
    const all = [...text.matchAll(/\((\d{1,3})\s*['′]\)/g)];
    if (all.length > 1) {
      // Pierwszy to runtime filmu, reszta to ekstra
      for (let i = 1; i < all.length; i++) total += parseInt(all[i][1], 10);
    }
  }
  return total;
}

function parseFlags(text) {
  const flags = [];
  if (/pokaz przedpremierowy/i.test(text)) flags.push('przedpremierowy');
  if (/polska premiera/i.test(text)) flags.push('polska-premiera');
  if (/film bez polskiej dystrybucji/i.test(text)) flags.push('bez-dystrybucji');
  if (/pokaz specjalny/i.test(text)) flags.push('pokaz-specjalny');
  if (/FILM DOSTĘPNY Z AUDIODESKRYPCJ/i.test(text)) flags.push('audiodeskrypcja');
  if (/spotkanie w języku angielskim/i.test(text)) flags.push('lang-en');
  if (/pokaz przedpremierowy po rekonstrukcji|pokaz specjalny po rekonstrukcji/i.test(text)) flags.push('rekonstrukcja');
  return flags;
}

function parseDirector(text) {
  // "reż. Jan Holoubek" / "reż. Claude Chabrol" — kończy się przed nawiasem z runtime
  // Akceptujemy też oryginalną pisownię "re. Imię Nazwisko"
  const m = text.match(/re\.?[żz]\.?\s+([A-ZŁŚŻŹĆĄĘŃÓ][^()]+?)\s*\(\d{1,3}\s*['′]\)/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

function parseSection(text) {
  const m = text.match(/sekcja:\s*([^,[\]]+?)(?=\s*(?:,\s*(?:Partnerami|Kino|Scena|Muzeum|sekcja)|[\],]|$))/);
  return m ? m[1].trim() : null;
}

function parseScreening(paragraphHtml, day, dateISO) {
  const text = stripTags(paragraphHtml);
  if (!text) return null;
  if (/^\d+\s+października 2026 r/i.test(text)) return null;
  if (/^&nbsp;$/.test(text)) return null;
  if (!isFilmEvent(text)) return null;

  const timeMatch = text.match(/^(\d{1,2}):(\d{2})\b/);
  if (!timeMatch) return null;
  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);

  const runtime = parseRuntime(text);
  if (!runtime) return null;

  const extraMinutes = parseExtraMinutes(text);
  const totalMin = hour * 60 + minute + runtime + extraMinutes;
  const endH = Math.floor(totalMin / 60) % 24;
  const endM = totalMin % 60;

  const start = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const end = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;

  const link = extractShowLink(paragraphHtml);
  let title = extractShowTitle(paragraphHtml);
  if (!title) {
    const titleAfter = text.match(/^\d{1,2}:\d{2}\s+(.+?)(?:,\s*reż\.|\s+\+\s*Q&A|\s+\+\s*INTRO|,\s*\(|$)/);
    if (titleAfter) title = titleAfter[1].trim();
  }
  if (!title) return null;

  const director = parseDirector(text);
  const section = parseSection(text);
  const venue = detectVenue(text);
  if (!venue) return null;

  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    id: `${day}-${start.replace(':', '')}-${slug}`,
    day,
    date: dateISO,
    start,
    end,
    title,
    director,
    runtime,
    extraMinutes,
    section,
    venueGroup: venue.group,
    venueName: venue.name,
    url: link,
    flags: parseFlags(text),
  };
}

// ============ Main ============
async function fetchHtml() {
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function readInput(args) {
  const idx = args.indexOf('--input');
  if (idx === -1) return null;
  const val = args[idx + 1];
  if (!val || val === '-') return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
  return fs.promises.readFile(val, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const input = await readInput(args);
  const html = input !== null ? input : await fetchHtml();

  const bodyStart = html.indexOf('<body');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const start = body.indexOf('CZĘŚĆ STACJONARNA');
  if (start < 0) throw new Error('Nie znaleziono "CZĘŚĆ STACJONARNA"');
  let content = body.slice(start);
  const stop = content.search(/CZĘŚĆ ONLINE|<footer|<\/article|<\/body/);
  if (stop > 0) content = content.slice(0, stop);

  const rawParas = extractParagraphs(content);
  const paragraphs = rawParas.map(stripTags);

  const dateMap = { 22: '2026-10-22', 23: '2026-10-23', 24: '2026-10-24', 25: '2026-10-25' };
  const screenings = [];
  let currentDay = null;

  for (let i = 0; i < paragraphs.length; i++) {
    const t = paragraphs[i];
    const dm = t.match(/^(\d+)\s+października 2026 r/);
    if (dm) {
      currentDay = parseInt(dm[1], 10);
      continue;
    }
    if (!currentDay) continue;
    const s = parseScreening(rawParas[i], currentDay, dateMap[currentDay]);
    if (s) screenings.push(s);
  }

  // Statystyki per dzień
  const byDay = screenings.reduce((acc, s) => { acc[s.day] = (acc[s.day] || 0) + 1; return acc; }, {});

  const output = {
    festival: {
      name: '17. Festiwal Kamera Akcja',
      edition: 17,
      year: 2026,
      city: 'Łódź',
      dates: ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'],
      sourceUrl: URL,
      generatedAt: new Date().toISOString(),
    },
    venues: VENUE_RULES.map(({ group, name }) => ({ group, name })),
    transitionMinutes: 20,
    screenings,
  };

  const outPath = path.resolve(__dirname, 'data/screenings.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`Zapisano ${screenings.length} seansów do ${outPath}`);
  console.log('Per dzień:', byDay);
}

main().catch((e) => { console.error(e); process.exit(1); });