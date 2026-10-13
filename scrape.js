#!/usr/bin/env node
/**
 scrape.js — jednorazowy parser harmonogramu Festiwalu Kamera Akcja 2026
 Wejście: HTML ze strony https://kameraakcja.com.pl/edycja-2026/harmonogram-godzinowy/
 Wyjście: data/screenings.json

 Użycie:
   node scrape.js                                   # fetch ze strony + opisy z WP JSON API
   node scrape.js --input path/do/pliku.html         # z lokalnego pliku HTML
   node scrape.js --input -                         # ze stdin
   node scrape.js --skip-details                    # tylko harmonogram, bez opisów
   node scrape.js --concurrency 5                   # ile równoległych requestów do API
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const URL = 'https://kameraakcja.com.pl/edycja-2026/harmonogram-godzinowy/';
const WP_API = 'https://kameraakcja.com.pl/wp-json/wp/v2/show';

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
// Kolejność ma znaczenie — najpierw warianty szczegółowe (Budynek H/Z/CNM),
// potem bazowy "Szkoła Filmowa w Łodzi". Matchujemy tekst BEZ znaku "]" bo
// detectVenue przegląda zawartość nawiasów [..] (bez samego nawiasu).
const VENUE_RULES = [
  { re: /\bMonopolis\b/i, group: 'monopolis', name: 'Monopolis' },
  { re: /Muzeum Kinematografii/i, group: 'muzeum-kinematografii', name: 'Muzeum Kinematografii' },
  { re: /Niebostan|Piotrkowska 17/i, group: 'niebostan', name: 'Niebostan / Piotrkowska 17' },
  { re: /TOYA Studios|Łąkowa 29a/i, group: 'toya-studios', name: 'TOYA Studios' },
  { re: /Boutique Hotel/i, group: 'boutique-hotel', name: 'Boutique Hotel' },
  // Szkoła Filmowa — najpierw warianty szczegółowe, potem bazowy
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
// "Otwarcie Festiwalu, [TYTUŁ FILMU], reż. ..." — tytuł poprzedzony słowem kluczowym,
// ale to nadal film. Wcześniejszy regex odrzucał "Otwarcie Festiwalu" bezwarunkowo,
// co eliminowało film taki jak "Dziki Dziki Wschód". Teraz: odrzucamy tylko jeśli w tekście
// nie ma "reż." (bo wtedy to nie film).
function isFilmEvent(text) {
  if (/otwarcie recepcji/i.test(text)) return false;
  if (/^od \d{1,2}:\d{2}\s/i.test(text) && /klubu|afterparty/i.test(text)) return false;
  if (/FILM DOSTĘPNY Z AUDIODESKRYPCJ/i.test(text)) return true;
  if (/re\.?[żz]\.?\s/i.test(text)) return true;
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
  const explicit = text.match(/\((\d{1,3})\s*['′]?\)\s*(?:\+\s*(?:Q&A|INTRO|INTRO Nauka|dyskusja))/i);
  if (explicit) return parseInt(explicit[1], 10);
  // W przeciwnym razie bierzemy pierwsze wystąpienie (z lub bez ′ — strona festiwalu czasem pomija)
  const m = text.match(/\((\d{1,3})\s*['′]?\)/);
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
  // Akceptujemy też oryginalną pisownię "re. Imię Nazwisko" oraz brak ′ przed ) (strona ma literówki).
  // Dopuszczamy też wielu reżyserów oddzielonych przecinkiem: "Tizza Covi, Rainer Frimmel".
  // \p{Lu} = unicode uppercase (łapie İ dla tureckiego, Ł dla polskiego itp.).
  const m = text.match(/re\.?[żz]\.?\s+((?:\p{Lu}[\p{L}\p{M}\s.',’\-]+?,\s*)*\p{Lu}[\p{L}\p{M}\s.'’\-]+?)\s*\(\d{1,3}\s*['′]?\)/u);
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

// ============ Parser detali filmu (z WP JSON) ============
// Struktura content.rendered (po stripTags):
//   [LOKALIZACJA]
//   Tytuł oryginalny / tytuł PL
//   ROK, RUNTIME min.
//   <flagi>
//   Nagrody i selekcje: ...
//   Reżyseria: ...
//   Obsada: ...
//   Kraj: ...
//   [POKAZ STACJONARNY]
//   <OPIS FABUŁY>
//   <BIO REŻYSERA>
//   Tagi: ...

function parseField(text, label, stopLabels) {
  // Szuka "<label>:<spacja>wartość" do przecinka lub klamry lub innego labelu lub końca tekstu
  stopLabels = stopLabels || [];
  const stopPattern = [...stopLabels, 'Reżyseria', 'Obsada', 'Kraj', 'Nagrody', 'Tagi'].join('|');
  const re = new RegExp(`${label}\\s*:\\s*(.+?)(?=\\s*(?:\\n|\\[(?:POKAZ|SCENA|KINO|SALA|MUZEUM)|${stopPattern}|$))`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim();
}

function extractDetails(contentHtml, slug, url) {
  const text = stripTags(contentHtml);
  const details = {
    slug,
    url,
    poster: null,
    originalTitle: null,
    year: null,
    country: null,
    cast: null,
    awards: null,
    plot: null,
    directorBio: null,
    tags: [],
  };

  // Rok
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) details.year = parseInt(yearMatch[0], 10);

  // Reżyseria
  details.director = parseField(text, 'Reżyseria');

  // Obsada
  details.cast = parseField(text, 'Obsada');

  // Kraj
  details.country = parseField(text, 'Kraj');

  // Nagrody
  details.awards = parseField(text, 'Nagrody i selekcje');

  // Tytuł oryginalny — przed "Reżyseria:" lub przed pierwszym rokiem
  // Format: "<i>Tytuł oryginalny / tytuł PL</i>" — zwykle po [LOKALIZACJA], przed rokiem
  const locEnd = text.indexOf(']');
  const searchStart = locEnd >= 0 ? locEnd + 1 : 0;
  const sub = text.slice(searchStart, Math.min(text.length, searchStart + 500));
  // Szukamy "<tytuł> ROK," lub "<tytuł> + INTRO"
  const titleMatch = sub.match(/^\s*([^,\n]+?)\s*(?:\d{4}\s*,|\+\s*(?:Q&A|INTRO|INTRO Nauka))/);
  if (titleMatch) {
    const candidate = titleMatch[1].trim();
    if (candidate.length > 1 && candidate.length < 200 && !/^(?:Intro|Legenda|Łączny|[a-z]+:)/i.test(candidate)) {
      details.originalTitle = candidate;
    }
  }

  // Tagi: "Tagi: tag1, tag2, tag3" — ale tylko do końca sensownego fragmentu (przed buttonami)
  const tagsRaw = text.match(/Tagi:\s*([^.\n]+?)(?=\s*(?:ZOBACZ|SEKCJA|DOSTĘPNOŚĆ|KUP|$))/i);
  if (tagsRaw) {
    details.tags = tagsRaw[1].split(',').map(t => t.trim()).filter(Boolean);
  }

  // Opis fabuły + bio reżysera — operujemy na HTML z <hr/> jako separatorem
  // Ekstrahujemy sekcje między [POKAZ STACJONARNY] a końcem (przed buttonami)
  // Struktura WP content.rendered po [POKAZ STACJONARNY]:
  //   <p>...</p>
  //   <hr/>
  //   <p>...recenzje...</p>  (opcjonalnie)
  //   <hr/>
  //   <p><b>Marine Atlan</b></p>
  //   <p>Bio...</p>
  //   <hr/>
  //   <p><b>Tagi</b>: ...</p>
  //   <hr/>  (separator przed buttonami)
  //   <div class="wp-block-buttons">...</div>
  // Wycinamy "buttons" przez szukanie `<div class="wp-block-buttons">`
  const startMark = '[POKAZ STACJONARNY]';
  const startIdx = contentHtml.indexOf(startMark);
  if (startIdx < 0) return details;

  // Odetnij po [POKAZ STACJONARNY]
  let after = contentHtml.slice(startIdx + startMark.length);
  // Odetnij wszystko od <div class="wp-block-buttons (pierwsze buttony)
  const buttonsIdx = after.search(/<div class="wp-block-buttons/i);
  if (buttonsIdx >= 0) after = after.slice(0, buttonsIdx);

  // Podziel po <hr/>
  const sections = after
    .split(/<hr\s*\/?>\s*/i)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => stripTags(s));

  // sections[0] = opis fabuły (z ewentualnymi recenzjami z mediów)
  // Znajdź sekcję z bio reżysera — to ta, która **zaczyna się od** "<Imię> <Nazwisko>"
  // (bo w HTML jest `<p><b>Imię Nazwisko</b></p>` w osobnej sekcji po <hr/>).
  // NIE bierzemy sekcji, w której imię+nazwisko pojawia się w środku (to recenzja lub opis).
  const directorName = details.director;
  let bioIdx = -1;
  if (directorName) {
    const escaped = directorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (let i = 1; i < sections.length; i++) {
      // Sekcja MUSI zaczynać się od imienia i nazwiska (po ewentualnych białych znakach)
      if (new RegExp(`^\\s*${escaped}\\b`, 'i').test(sections[i])) {
        bioIdx = i;
        break;
      }
    }
  }

  // Opis = wszystko przed bioIdx (łącznie z recenzjami)
  // Filtrujemy krótkie nagłówki typu "W mediach:"
  if (bioIdx > 0) {
    const plotSections = sections.slice(0, bioIdx);
    details.plot = plotSections
      .filter(s => !/^W mediach:?\s*$/i.test(s))
      .filter(s => !/^\s*$/.test(s))
      .join('\n\n')
      .trim() || null;
    // Bio: sekcja z bioIdx zwykle zaczyna się od "<Imię> <Nazwisko>" (sama w jednej sekcji po <hr/>)
    // Ale stripTags usuwa tagi, więc po prostu bierzemy sekcję i ewentualnie wycinamy imię
    let bio = sections[bioIdx];
    if (directorName) {
      // Wycinamy dokładnie imię+nazwisko z początku
      const escaped = directorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      bio = bio.replace(new RegExp(`^\\s*${escaped}\\s*`, 'i'), '').trim();
    }
    details.directorBio = bio || sections[bioIdx];
  } else if (sections.length > 0) {
    // Brak bioIdx — całość to opis
    details.plot = sections.join('\n\n').trim() || null;
  }

  // Wycinamy "Spotkanie po seansie..." / "Q&A..." / "Intro przed..." z plot
  if (details.plot) {
    details.plot = details.plot
      .replace(/\s*—\s*film\s*Otwarcia.*$/, '')
      .replace(/\s*Spotkanie po seansie.*?(?=[A-ZŻŹĆĄĘŚŁÓŃ])/g, '')
      .replace(/\s*Q&A.*?(?=[A-ZŻŹĆĄĘŚŁÓŃ])/g, '')
      .trim();
  }

  return details;
}

async function fetchShowDetails(slug) {
  const url = `${WP_API}?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${slug}`);
  }
  const arr = await res.json();
  if (!arr.length) return null;
  const show = arr[0];
  const details = extractDetails(show.content.rendered, show.slug, show.link);
  details.poster = show.uagb_featured_image_src?.large?.[0] || show.uagb_featured_image_src?.full?.[0] || null;
  details.year = details.year || (show.date ? parseInt(show.date.slice(0, 4), 10) : null);
  // Tagi z WordPress (jeśli są w treści nie ma)
  // Sekcje (kategorie) - przydatne do debugowania
  return details;
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
  const skipDetails = args.includes('--skip-details');
  const concurrencyArg = args.indexOf('--concurrency');
  const concurrency = concurrencyArg >= 0 ? parseInt(args[concurrencyArg + 1], 10) || 4 : 4;
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

  // Pobierz opisy filmów z WP JSON API
  if (!skipDetails) {
    const uniqueSlugs = [...new Set(screenings.map(s => s.url?.match(/\/(pokaz|wydarzenie)\/([^/]+)\/?$/)?.[2]).filter(Boolean))];
    console.log(`Pobieram opisy dla ${uniqueSlugs.length} unikalnych filmów (concurrency=${concurrency})...`);

    const detailsBySlug = {};
    let done = 0;
    let failed = 0;
    const queue = [...uniqueSlugs];
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const slug = queue.shift();
        try {
          const details = await fetchShowDetails(slug);
          if (details) detailsBySlug[slug] = details;
        } catch (e) {
          failed++;
          console.warn(`  ⚠ ${slug}: ${e.message}`);
        }
        done++;
        if (done % 5 === 0 || done === uniqueSlugs.length) {
          process.stdout.write(`\r  Postęp: ${done}/${uniqueSlugs.length} (błędy: ${failed})`);
        }
      }
    });
    await Promise.all(workers);
    console.log();

    // Przypisz detale do każdego seansu
    for (const s of screenings) {
      const slug = s.url?.match(/\/(pokaz|wydarzenie)\/([^/]+)\/?$/)?.[2];
      if (slug && detailsBySlug[slug]) {
        s.details = detailsBySlug[slug];
      }
    }
    console.log(`Pobrano opisy dla ${Object.keys(detailsBySlug).length}/${uniqueSlugs.length} filmów`);
  }

  const output = {
    festival: {
      name: '17. Festiwal Kamera Akcja',
      edition: 17,
      year: 2026,
      city: 'Łódź',
      dates: ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'],
      // Default minutes of pre-show (ads/trailers) before each film.
      // Hours on festival page are seance start (incl. ads); film starts
      // a few minutes later. Used by index.html to show film times and
      // detect conflicts based on actual film duration.
      preShowMinutes: 10,
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