# Viaggi: The Great Race – web proof of concept

Race round Europe getting your passport stamped, against a clock and a budget.

```bash
npm start        # then open http://localhost:5173
npm run solve    # prove every challenge is winnable and print fastest/cheapest orders
node tools/bot.mjs   # naive player across 30 seeds per challenge, for difficulty tuning
```

No build step: plain ES modules, MapLibre GL from a CDN, OpenFreeMap tiles.
`npm start` runs `tools/serve.py`, a static server that disables browser caching.
Add `?seed=anything` to replay the same disruption, `?debug` to expose `window.tg`.

## Layout

| Path | What it is |
|---|---|
| `src/data/europe.js` | Region pack: cities, airline hubs and bases, rail corridors |
| `src/data/challenges.js` | Challenges, with limits set from the solver |
| `src/engine/world.js` | Turns a region pack into dated departures and fares; one provider per transport mode |
| `src/engine/game.js` | State and rules (no DOM) |
| `src/engine/events.js` | Strikes, storms, airport closures |
| `src/engine/tickets.js` | Bonus tickets (secret optional objectives) |
| `src/data/postcards.js` | One line per city for the stamp screen |
| `src/audio.js` | Generated location music. Parked: not wired into the game |
| `src/engine/planner.js` | Earliest-arrival search and calibration, used by the solver and the daily challenge |
| `src/main.js`, `styles.css` | Map and departure-board UI |

## Data

Timetables are modelled, not downloaded. Each airline flies from its real hubs
or bases; frequency follows city size; flight numbers and times are generated
deterministically, so every player sees the same board. To use a real schedule
snapshot (for example AeroDataBox), replace the `air` provider in `world.js`
with one that reads the snapshot – the rest of the game is unchanged.

## Air and rail are separate games

Each challenge declares its transport (`modes`) and, for rail, which timetable
is in play (`rail`):

- `rail: 'international'` – only cross-border trains between major cities, plus cross-border ferries.
- `rail: 'IT'` (any country code) – only that country's domestic network.
- `domestic: ['ES']` alongside `rail: 'international'` – an international journey in which
  one country's full home network is also open, for example London into Spain.

Ferries (`FERRIES` in the region pack) sail by season: short crossings many times a day, long
ones in the evening a few times a week. They sail port to port, and a free shuttle (minutes per
port in the data) links each port with that city's station. An overnight sailing of seven hours
or more includes a berth, so it replaces that night's hotel.

Only the part of the rail map connected to the challenge's home city is used.
Cities marked `railOnly` in the region pack exist on the rail map but have no flights.

## Extending

- **New region:** add a pack like `europe.js` and pass it to `createWorld`.
- **New transport mode:** add a provider to `PROVIDERS` in `world.js` and an entry in `MODES`.
