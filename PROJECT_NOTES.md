# Viaggi: The Great Race – project notes

Working notes for picking the project up again. Last updated 10 October 2026.
The README covers how to run it and the file layout; this file covers what was
decided, why, and what is still open.

## What it is

A travel race game for iOS, prototyped as a web app. Inspired by Waddingtons'
Go, the BBC's Race Across the World and Ticket to Ride. One player (two-player
planned) gets a list of cities, a time limit and a budget; they collect a
passport stamp in each city and get home before either runs out. The heart of
the game is the departure board: you see what leaves from where you are and
choose under pressure.

- Folder: `/Users/garycrook/TravelGo` (still the old name; the game is "Viaggi: The Great Race")
- Run: `npm start`, then http://localhost:5173 (preview config `travel-go` in `~/.claude/launch.json`)
- Version control: its own git repository, pushed to https://github.com/GaryCrook/Viaggi (branch `main`). GitHub CLI is not installed on this Mac; plain `git push` works.
- The preview server must be `tools/serve.py` (no caching, IPv4 and IPv6). Plain `python -m http.server` served stale files.

## Name

- "Travel Go" was dropped: Go belongs to Hasbro (ex-Waddingtons) and clashes with Go / Pokémon Go.
- "Race Across the World" and "Race Around the World" are out: BBC show title, and an official board game is on sale under it.
- Current name: **Viaggi: The Great Race**. A web search found no blocking use of "Viaggi" for a game. "The Great Race" is a common phrase already used by other games (including a travel-race board game), so it is weak and unprotectable.
- Not done: a proper search of the UK IPO, TMview and USPTO registers (classes 9, 28, 41), and the App Store / Google Play.

## Rules as built

- **Stamps, not souvenirs.** Each listed city gives a passport stamp (90 minutes in town, small fee) with a postcard fact.
- **Clock.** Game time, not real time. The clock jumps when you travel, with a time-lapse on the map. Analogue clock in the header, dark face at night.
- **Night.** Nothing departs 22:00–06:00. At night the player is automatically booked into a hotel (room, meals, shuttle). No free bench option. Cannot afford the room = journey ends "Out of money".
- **Berths.** An overnight ferry or sleeper train of 7h+ includes a berth: no hotel that night.
- **Disruption.** Forecast strike on day two (8 hours only in single-country games), forecast storms, sudden airport closure with diversion (air only), traffic jams into town. Rail strikes do not stop ferries.
- **Run for it.** A departure you are slightly too late for can be gambled on with a shown chance; a flexible ticket (+25%) refunds the fare if you miss.
- **Bonus tickets.** Two secret objectives drawn at the start, keep one or both, ±75 points.
- **Scoring.** Three stars (finish, under 80% of budget, under par time) plus points.
- **Information.** Own board only, two look-ups of other cities per day, tomorrow's board shown read-only, and a Routes tab giving fastest / cheapest / best-value ways to each listed city.
- **Splash and training.** The game opens on a splash page (purpose, how to play). "Training Flight" is a guided London–Paris–Amsterdam trip with no disruption or tickets; a coach box and a pulsing highlight show the next step, worked out from the game state (`coachStep` in `src/main.js`).
- **Daily challenge.** Four cities from the date, same timetable and disruption for everyone, limits calibrated automatically, best score stored locally, copyable result.

## Air and surface are separate games

Decided by Gary: no mixing flights with trains.

- **By air:** 45 cities, modelled airline network (real hubs and bases, generated flight numbers and times). Airports need a paid transfer into town.
- **Rail and sail:** trains, sleepers and ferries only, station to station.
  - `rail: 'international'` – only cross-border trains between major cities (tier 1–2), plus cross-border ferries.
  - `rail: 'IT'` / `'ES'` – one country's domestic network only.
  - `domestic: ['ES']` with `rail: 'international'` – international journey with one country's home network open (used for London into Spain).
  - Ferries sail port to port; a free shuttle (time only) links each port to the station.
  - Only the part of the network reachable from the journey's home city is shown.
- Rail-only cities (`railOnly: true`): Turin, Bologna, Florence, Genoa, Palermo, Gdańsk, Seville, Valencia, Zaragoza, Bilbao, Santander.

## Journeys

Air: Daily Challenge, Weekend Dash, The Grand Tour, Edges of Europe.
Rail and sail: The Channel Triangle, The Alpine Loop, The Iron Road, Biscay or Barcelona (international + Spain), Sol y Sombra (Spain), Il Bel Paese (Italy), The Baltic Run.

Limits come from `npm run solve`; difficulty is sanity-checked with `node tools/bot.mjs` (30 seeds each).

## Known weaknesses

- **All timetable data is modelled or estimated**, not taken from operators. Rail and ferry durations and frequencies need checking against published timetables. Airline names are real but flights are invented: use licensed data or fictional carriers before release.
- **Difficulty is rough.** Biscay or Barcelona, Il Bel Paese and the Baltic Run are too easy (bot wins 27–30 of 30). Edges of Europe is very hard (5 of 30). The Iron Road is long (about five game days).
- **Some "free shuttles" are really long connections** (Holyhead 3h40 from London, Patras 3h from Athens, Rostock 2h30 from Berlin).
- **The Routes tab weakens the fog of war** and makes look-ups less useful. Could be limited to a few uses a day.
- **Map uses MapLibre with free OpenFreeMap tiles**, not Mapbox (no token). One-line swap in `src/main.js`.
- **The map does not draw while the preview pane is hidden**, which makes screenshots look blank; it is not a bug in the game.

## Parked or not built

- Music: generated location music exists in `src/audio.js` but is not wired in. Gary found it annoying.
- Two-player mode.
- Real timetable data (AeroDataBox snapshot for air; GTFS for rail).
- Timetable versions: routes with start and end dates, seasonal updates, version stamped on each daily challenge.
- Paris–Milan sleeper and a Cologne stop were asked about; left out pending confirmation that the services run.
- iOS app itself.

## Expansion thinking

- Sellable add-ons: Rail Europe (needs about 10 international journeys and 4–5 country networks), World by air (per region), possibly Japan by rail.
- Features, not products: ferries, sleepers, single countries on their own, coaches.
- Free: disruption, seasonal journeys, two-player.
- Later idea: an "Overland" mode (no flying, tight budget).

## Likely next steps

1. Check the name against the trademark registers and app stores.
2. Tune the easy rail journeys; decide whether to limit the Routes tab.
3. Add more international journeys and another country network (Germany, France or Britain).
4. Verify rail and ferry data against real timetables.
5. Add a second training lesson for rail and sail (ferries, sleepers, running for a departure, bonus tickets).
6. Decide the open design questions below.

## Open questions for Gary

Answered 11 October 2026:
- Running out of money ends the game. Settled.
- Subtitle stays "The Great Race" for now.
- Routes tab: undecided. Leave as it is until he has played more.
- Long port connections: he was not sure what was meant and wants to test rail and ferry first. Explained again; awaiting his view after testing.

Still open:
- Which country network next: Germany, France or Britain? Should Italy be opened inside international journeys the way Spain is?

## Ideas for later

- **USA by air, with a roads expansion** (Gary, 11 October 2026). A new region pack for flights, and a road mode (car or coach) as its surface counterpart, the way rail and sail is for Europe. Not started.

## State at last save (10 October 2026)

Everything described here is built, played through in the preview, committed and pushed.
The start screen opens on the splash page; the training flight was played to "Training complete".
Nothing is half-finished.
