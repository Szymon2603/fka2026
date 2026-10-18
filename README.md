# Kamera Akcja 2026 — planer seansów

Webowa apka (PWA) do planowania seansów na [17. Festiwal Kamera Akcja](https://kameraakcja.com.pl/edycja-2026/) (Łódź, 22–25 października 2026).

- 📱 mobile-first, instaluje się jak natywna apka (PWA, offline-ready)
- 🎯 wykrywa **kolizje czasowe** (overlap seansów, liczone od rzeczywistego czasu filmu, nie seansu)
- ⏱ wykrywa **zbyt krótkie przejścia** między lokacjami (domyślnie 15 min, edytowalne per para)
- 🎞 uwzględnia **czas reklam przed filmem** (domyślnie 10 min, konfigurowalny) — pokazuje godzinę startu samego filmu
- 🎬 **opis filmu** po kliknięciu (modal: plakat, opis fabuły, bio reżysera, obsada, nagrody, tagi)
- 📤 **udostępnianie planu** linkiem lub plikiem JSON (selected + konfiguracja przejść + ustawienia)
- 💾 lista "chcę obejrzeć" + konfiguracja zapisywana w `localStorage`
- 🌗 motyw auto (`prefers-color-scheme`)
- 🎬 zero zależności runtime — vanilla HTML/JS, ~50 KB

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

Pełna instrukcja dla osoby bez doświadczenia z git/GitHubem:

#### 1. Utwórz konto GitHub (jeśli nie masz)
- Wejdź na https://github.com/signup
- Podaj email, hasło, nazwę użytkownika

#### 2. Utwórz nowe repo
- Wejdź na https://github.com/new
- **Repository name:** `fka2026` (lub inna — bez spacji, bez polskich znaków)
- **Public** (prywatne też zadziała, ale strona będzie wymagała logowania)
- **NIE zaznaczaj** "Add a README file", "Add .gitignore", "Choose a license" — klikamy **Create repository**

#### 3. Skonfiguruj git lokalnie (raz, jeśli jeszcze nie masz)
```bash
git config --global user.email "twoj@email.com"
git config --global user.name "Twoje Imię"
```

#### 4. Dodaj remote i wypchnij kod

**Opcja A — z HTTPS (prostsze, wymaga PAT):**
```bash
cd ~/projects/fka2026
git remote add origin https://github.com/<twój-user>/fka2026.git
git branch -M main
git push -u origin main
```

**Opcja B — z SSH (wymaga klucza SSH w GitHubie):**
```bash
cd ~/projects/fka2026
git remote add origin git@github.com:<twój-user>/fka2026.git
git branch -M main
git push -u origin main
```

Przy HTTPS GitHub zapyta o login + hasło. Hasło GitHuba już nie działa — potrzebujesz **Personal Access Token**:
1. GitHub → ikona profilu → **Settings** → **Developer settings** (na dole po lewej) → **Personal access tokens** → **Tokens (classic)**
2. **Generate new token** → zaznacz `repo` → **Generate token**
3. Skopiuj token (pokazuje się tylko raz) i użyj go jako hasła przy `git push`

#### 5. Włącz GitHub Pages
1. Na GitHubie otwórz swoje repo `https://github.com/<twój-user>/fka2026`
2. **Settings** (zakładka na górze)
3. Po lewej: **Pages**
4. **Source:** `Deploy from a branch`
5. **Branch:** `main` / **`/(root)`** ← ważne: root, nie /docs
6. Klik **Save**

#### 6. Poczekaj i odwiedź stronę
- Po 1–2 minutach GitHub wygeneruje URL widoczny na stronie Settings → Pages
- Domyślnie: **`https://<twój-user>.github.io/fka2026/`**
- Wejdź w przeglądarkę na ten URL — powinna działać pełna apka, PWA, offline

#### 7. Dodaj do ekranu głównego (opcjonalnie)
- **Android (Chrome):** menu (⋮) → "Dodaj do ekranu głównego"
- **iOS (Safari):** ikona udostępniania (↑) → "Na ekranie początkowym"
- Apka zainstaluje się jak natywna i będzie działać offline

#### 8. Aktualizacje
Po każdej zmianie w kodzie:
```bash
cd ~/projects/fka2026
git add -A
git commit -m "opis zmiany"
git push
```
GitHub automatycznie zrebuilduje stronę w 1–2 min. Odśwież w przeglądarce.

#### 9. Aktualizacja danych filmów
```bash
cd ~/projects/fka2026
node scrape.js
git add -A
git commit -m "Update screenings data"
git push
```

#### 10. Własna domena (opcjonalnie)
W **Settings → Pages → Custom domain** wpisz np. `fka.example.com` i skonfiguruj DNS u rejestratora domeny według instrukcji GitHuba.

#### Troubleshooting

| Problem | Rozwiązanie |
|---|---|
| Strona pokazuje JSON zamiast HTML | GitHub Pages cache'uje — sprawdź URL musi być `…/fka2026/` (z końcowym `/`), nie bezpośrednio plik JSON |
| Service worker serwuje starą wersję | W przeglądarce: DevTools → Application → Service Workers → Unregister + Clear storage |
| 404 na `data/screenings.json` | Sprawdź czy plik jest w `data/` w repo i czy push się udał |
| Push wymaga hasła, a hasło nie działa | Użyj Personal Access Token (krok 4, opcja A) |
| Custom domain nie działa | Sprawdź DNS (A record na `185.199.108.153` itp.) — propagacja do 24h |

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

W zakładce **Czasy przejść** możesz nadpisać domyślne 15 min dla każdej pary venueGroupów (np. `Monopolis → Szkoła Filmowa - Wydział Aktorski, Budynek H = 18 min` bo idzie się dłużej). Domyślnie pokazywane są tylko pary venue, które faktycznie mają seanse w programie (teraz: 6 par). Toggle "Pokaż pary bez seansów w programie" przywraca pełną listę 36 par (na przyszłość). Zmiany zapisują się w `localStorage`. Przycisk ↺ przy wierszu przywraca domyślne dla tej pary; **Przywróć domyślne** resetuje wszystko.

## Ustawienia (czas reklam)

W zakładce **Ustawienia** możesz włączyć/wyłączyć blok reklam przed filmami oraz zmienić jego długość (0–60 min, domyślnie 10). Godziny na stronie festiwalu to początek seansu (reklamy + film), więc apka odejmuje ten czas przy wyświetlaniu godziny startu samego filmu. Algorytm kolizji też operuje na rzeczywistym czasie filmu — np. `Niewierna żona` (rekl. 10 + film 98 = 108 min) kończy się o `20:18`, nie `20:08`.

## Oznaczanie odrzuconych filmów

Trzy niezależne stany: neutralny, **wybrany** (✓), **odrzucony** (✕). Filmu nie można mieć jednocześnie w planie i na liście odrzuconych — kliknięcie ✕ na wybranym filmie automatycznie usuwa go z planu.

- Przycisk **✕** obok ✓ przy każdym filmie (day-view i plan-view).
- **Pokaż odrzucone (N)** — toolbar w day-view i plan-view. Domyślnie wyłączony, nie zapisywany w `localStorage`. Po włączeniu odrzucone filmy pojawiają się z przekreślonym tytułem i szarym tłem.
- Odrzucony film **nie wchodzi w kolizje** — skoro go nie obejrzę, nie koliduje z innymi.
- Eksport/import: w snapsecie (`?import=` i JSON) jest pole `unwanted: [...]`. Stare snapshoty bez tego pola nadal importują się poprawnie (pole opcjonalne).

## Udostępnianie planu

Zakładka **Plan** (trzecia zakładka, obok dat) ma trzy przyciski:

| Przycisk | Co robi |
|---|---|
| 📋 Kopiuj link | Generuje URL `?import=<base64>` ze snapshotem i kopiuje do schowka |
| ⬇ Pobierz JSON | Ściąga `fka2026-plan-YYYY-MM-DD.json` (czytelny, z wcięciami) |
| ⬆ Importuj JSON | Wczytuje wcześniej pobrany snapshot z pliku |

### Jak to działa

- Link jest **self-contained** — wystarczy wysłać go znajomemu, nic nie trzeba konfigurować
- Po kliknięciu linku pojawia się banner na górze *"Zaimportowano plan z linku — 5 seansów · 2 własnych przejść · reklamy: 10 min"*. Przyciskiem **Akceptuj** zapisujesz plan u siebie, **Odrzuć** zamyka banner
- Plik JSON ma identyczną strukturę jak wewnętrzny snapshot — można nim np. backupować plan przed zmianą telefonu lub przenosić między przeglądarkami

### Format snapshotu

```json
{
  "v": 1,
  "app": "fka2026",
  "selected": ["monopolis/2026-10-22/18:00"],
  "transitions": [["monopolis\tszkola-filmowa", 12]],
  "settings": { "preShowEnabled": true, "preShowMinutes": 10 }
}
```

`v` to schema version — przyszłe migracje będą odrzucać nieznane wersje. `applySnapshot` filtruje IDs których nie ma w aktualnym programie, więc zaimportowanie starego planu po aktualizacji danych nie zepsuje nic.

### Ograniczenia

- URL w nosi ~750–900 znaków dla pełnego planu (limit przeglądarek to zwykle 2000+). Jeśli chcesz krótszy link — wrzuć przez [TinyURL](https://tinyurl.com) albo `git.io`
- Bez real-time sync — każda osoba ma własny `localStorage`. Do prawdziwego współdzielenia między telefonami potrzeba backendu (Firebase, Gist API itp.)
- Dane są w przeglądarce klienta — wyczyszczenie danych przeglądarki czyści plan

## Stack

- **Frontend:** statyczny HTML + vanilla JS (zero zależności runtime)
- **PWA:** Web App Manifest + service worker (cache-first dla assets, network-first dla HTML/data)
- **Parser:** Node.js (zero zależności, tylko stdlib) — pobiera harmonogram + WP JSON API z detalami filmów
- **Hosting:** GitHub Pages (lub dowolny statyczny hosting)

## Licencja

Dane filmów: © Festiwal Kamera Akcja (źródło: [kameraakcja.com.pl](https://kameraakcja.com.pl/)).
Kod: MIT.