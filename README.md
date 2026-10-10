# Kamera Akcja 2026 — planer seansów

Webowa apka (PWA) do planowania seansów na [17. Festiwal Kamera Akcja](https://kameraakcja.com.pl/edycja-2026/) (Łódź, 22–25 października 2026).

- 📱 mobile-first, instaluje się jak natywna apka (PWA, offline-ready)
- 🎯 wykrywa **kolizje czasowe** (overlap seansów)
- ⏱ wykrywa **zbyt krótkie przejścia** między lokacjami (domyślnie 15 min, edytowalne)
- 🎬 **opis filmu** po kliknięciu (modal: plakat, opis fabuły, bio reżysera, obsada, nagrody, tagi)
- 💾 lista "chcę obejrzeć" zapisywana w `localStorage`
- 🌗 motyw auto (`prefers-color-scheme`)
- 🎬 zero zależności runtime — vanilla HTML/JS, ~45 KB

## Uruchomienie

### Lokalnie
```bash
# serwer HTTP (PWA wymaga, nie file://)
python3 -m http.server 8000
# albo
npx serve .
```
Otwórz `http://localhost:8000`.

### GitHub Pages
1. Push do repo (np. `szymo/fka2026`).
2. Settings → Pages → Source: `main` / `(root)`.
4. Apka dostępna pod `https://<user>.github.io/fka2026/`.

## Aktualizacja danych

Dane są zescrapowane ze strony festiwalu i zapisane w `data/screenings.json`.

```bash
# aktualizacja ze strony festiwalu + opisy z WP JSON API (~31 requestów)
node scrape.js

# tylko harmonogram, bez opisów filmów
node scrape.js --skip-details

# z lokalnego pliku HTML (gdy nie ma netu, scrape harmonogramu)
node scrape.js --input ./kamera-akcja.html

# ze stdin
curl -sL "https://kameraakcja.com.pl/edycja-2026/harmonogram-godzinowy/" | node scrape.js --input -

# kontrola liczby równoległych requestów do API
node scrape.js --concurrency 6
```

Parser wyciąga tylko **filmy** (z `reż.` i linkami do `pokaz/*` / `wydarzenie/*`). Warsztaty, dyskusje, afterparty są pomijane zgodnie z decyzją.

## Struktura danych

`data/screenings.json` (~85 KB z opisami):

```json
{
  "festival": { "name": "...", "year": 2026, "dates": ["2026-10-22", ...], "sourceUrl": "..." },
  "venues": [{ "group": "monopolis", "name": "Monopolis" }, ...],
  "transitionMinutes": 20,
  "screenings": [
    {
      "id": "22-1830-niewierna-zona",
      "day": 22,
      "date": "2026-10-22",
      "start": "18:30",
      "end": "20:08",
      "title": "Niewierna żona",
      "director": "Claude Chabrol",
      "runtime": 98,
      "extraMinutes": 0,
      "section": "Klasyka Krytyka",
      "venueGroup": "szkola-filmowa",
      "venueName": "Szkoła Filmowa w Łodzi",
      "url": "https://kameraakcja.com.pl/pokaz/niewierna-zona/",
      "flags": ["pokaz-specjalny", "rekonstrukcja"],
      "details": {
        "slug": "niewierna-zona",
        "url": "https://kameraakcja.com.pl/pokaz/niewierna-zona/",
        "poster": "https://kameraakcja.com.pl/wp-content/uploads/2024/06/FKA2026-Niewierna-zona-1024x1024.png",
        "originalTitle": "La femme infidèle / The Unfaithful Wife",
        "year": 1969,
        "country": "Francja, Włochy",
        "cast": "Michel Bouquet, Stéphane Audran, Maurice Ronet, Michel Duchaussoy, Guy Marly",
        "awards": "National Board of Review 1969 – Najlepszy Film Zagraniczny",
        "plot": "(Nie)idealne małżeństwo Charles i Hélène prowadzą dostatnie...",
        "directorBio": "Francuski reżyser, scenarzysta i krytyk filmowy...",
        "tags": ["zdrada", "małżeństwo", "zazdrość", "thriller psychologiczny", "mieszczaństwo"]
      }
    }
  ]
}
```

## Algorytm kolizji

Dla każdej pary wybranych seansów `A`, `B` (w tym samym dniu):

1. **Overlap czasowy** — `startA < endB && startB < endA` → 🔴 kolizja czasowa
2. **Przejście** — jeśli `A.end <= B.start && (B.start - A.end) < transitionMinutes && venueGroupA != venueGroupB` → 🟡 za mało czasu na przejście

`venueGroup` to logiczna grupa budynków (np. wszystkie kina Szkoły Filmowej mają osobne grupy: `-h`, `-z`, `-cnm`, bazowa). Przejście między kinami w jednym budynku jest traktowane jako zerowe, między różnymi grupami — `transitionMinutes`.

## Edycja czasów przejść

W zakładce **Czasy przejść** możesz nadpisać domyślne 15 min dla każdej pary venueGroupów (np. `Monopolis → Szkoła Filmowa - Wydział Aktorski, Budynek H = 18 min` bo idzie się dłużej). Zmiany zapisują się w `localStorage`. Przycisk ↺ przy wierszu przywraca domyślne dla tej pary; **Przywróć domyślne** resetuje wszystko.

## Stack

- **Frontend:** statyczny HTML + vanilla JS (zero zależności runtime)
- **PWA:** Web App Manifest + service worker (cache-first dla assets, network-first dla HTML/data)
- **Parser:** Node.js (zero zależności, tylko stdlib) — pobiera harmonogram + WP JSON API z detalami filmów
- **Hosting:** GitHub Pages (lub dowolny statyczny hosting)

## Licencja

Dane filmów: © Festiwal Kamera Akcja (źródło: [kameraakcja.com.pl](https://kameraakcja.com.pl/)).
Kod: MIT.