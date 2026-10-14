// Exports the game data from the web prototype's modules to plain JSON, so the
// iOS app (and later Android) read exactly the same cities, routes and journeys.
//   node tools/export-data.mjs
// Writes data/*.json and copies them into the Swift package's resources.
import { writeFileSync, mkdirSync } from 'node:fs';
import { EUROPE } from '../src/data/europe.js';
import { CHALLENGES, TRAINING } from '../src/data/challenges.js';
import { POSTCARDS } from '../src/data/postcards.js';

const region = {
  id: EUROPE.id, name: EUROPE.name, currency: EUROPE.currency,
  cities: EUROPE.cities.map((c) => ({ ...c, railOnly: !!c.railOnly })),
  countryNames: EUROPE.countryNames,
  carriers: EUROPE.carriers.map(({ code, name, type, hubs }) => ({ code, name, type, hubs })),
  airlines: Object.fromEntries(Object.entries(EUROPE.airlines).map(([k, [code, kind, shown]]) => [k, { code, kind, shown: shown || null }])),
  airlinesDropped: EUROPE.airlinesDropped,
  winterResorts: EUROPE.winterResorts,
  airRoutesDate: EUROPE.airRoutesDate,
  airRoutes: EUROPE.airRoutes.map(([a, b, airline, seasonal]) => ({ a, b, airline, seasonal: !!seasonal })),
  rail: EUROPE.rail.map(([a, b, minutes, perDay, code, name, premium, sleeperPerWeek]) =>
    ({ a, b, minutes, perDay, code, name, premium: !!premium, sleeperPerWeek: sleeperPerWeek || 0 })),
  ferries: EUROPE.ferries.map(([a, portA, linkA, minsA, b, portB, linkB, minsB, minutes, summer, winter, code, name]) =>
    ({ a, portA, linkA, minsA, b, portB, linkB, minsB, minutes, summer, winter, code, name })),
};

const files = {
  'europe.json': region,
  'challenges.json': { challenges: CHALLENGES, training: TRAINING },
  'postcards.json': POSTCARDS,
};
for (const dir of ['data', 'ios/ViaggiKit/Sources/ViaggiKit/Resources']) {
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(`${dir}/${name}`, `${JSON.stringify(value, null, 1)}\n`);
}
console.log(`exported ${region.cities.length} cities, ${region.airRoutes.length} air routes, ${region.rail.length} rail, ${region.ferries.length} ferries, ${CHALLENGES.length + 1} journeys`);
