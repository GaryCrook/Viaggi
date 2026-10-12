// Builds src/data/europe-routes.js from the "Airlines and destinations" tables
// on Wikipedia's airport pages (text licensed CC BY-SA 4.0).
//
//   node tools/fetch-routes.mjs [cacheDir]
//
// It records which airline flies between which of the game's cities and
// whether the route is seasonal. It does not know how often a route runs.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { EUROPE } from '../src/data/europe.js';

const cache = process.argv[2] || 'tools/.wiki-cache';
mkdirSync(cache, { recursive: true });

// Airport pages to read for each city. Cities with several airports list them all.
const AIRPORTS = {
  LON: ['Heathrow Airport', 'Gatwick Airport', 'London Stansted Airport', 'London Luton Airport', 'London City Airport'],
  MAN: ['Manchester Airport'], EDI: ['Edinburgh Airport'], DUB: ['Dublin Airport'],
  PAR: ['Charles de Gaulle Airport', 'Orly Airport'], NCE: ["Nice Côte d'Azur Airport"],
  AMS: ['Amsterdam Airport Schiphol'], BRU: ['Brussels Airport', 'Brussels South Charleroi Airport'], LUX: ['Luxembourg Airport'],
  FRA: ['Frankfurt Airport'], MUC: ['Munich Airport'], BER: ['Berlin Brandenburg Airport'],
  ZRH: ['Zurich Airport'], GVA: ['Geneva Airport'], VIE: ['Vienna Airport'],
  MAD: ['Madrid–Barajas Airport'], BCN: ['Barcelona–El Prat Airport'], AGP: ['Málaga Airport'], PMI: ['Palma de Mallorca Airport'],
  LIS: ['Lisbon Airport'], OPO: ['Porto Airport'],
  ROM: ['Rome Fiumicino Airport', 'Rome Ciampino Airport'], MIL: ['Milan Malpensa Airport', 'Linate Airport', 'Milan Bergamo Airport'],
  VCE: ['Venice Marco Polo Airport', 'Treviso Airport'], NAP: ['Naples International Airport'], MLA: ['Malta International Airport'],
  CPH: ['Copenhagen Airport'], STO: ['Stockholm Arlanda Airport'], OSL: ['Oslo Airport, Gardermoen'], HEL: ['Helsinki Airport'],
  REK: ['Keflavík International Airport'], TLL: ['Tallinn Airport'], RIX: ['Riga International Airport'], VNO: ['Vilnius Airport'],
  WAW: ['Warsaw Chopin Airport', 'Warsaw Modlin Airport'], KRK: ['Kraków John Paul II International Airport'],
  PRG: ['Václav Havel Airport Prague'], BUD: ['Budapest Ferenc Liszt International Airport'],
  BUH: ['Henri Coandă International Airport'], SOF: ['Sofia Airport'], BEG: ['Belgrade Nikola Tesla Airport'],
  ZAG: ['Zagreb Airport'], DBV: ['Dubrovnik Airport'], LJU: ['Ljubljana Jože Pučnik Airport'],
  ATH: ['Athens International Airport'], IST: ['Istanbul Airport', 'Sabiha Gökçen International Airport'],
  TOS: ['Tromsø Airport'], KRN: ['Kiruna Airport'], OUL: ['Oulu Airport'], AEY: ['Akureyri Airport'],
  INN: ['Innsbruck Airport'], PDL: ['João Paulo II Airport'], IOA: ['Ioannina National Airport'],
};

const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').replace(/ł/g, 'l').toLowerCase().trim();
const NAMES = new Map(EUROPE.cities.filter((c) => AIRPORTS[c.id]).map((c) => [plain(c.name), c.id]));
for (const [alias, id] of Object.entries({
  malta: 'MLA', 'palma de mallorca': 'PMI', keflavik: 'REK', cracow: 'KRK', charleroi: 'BRU', treviso: 'VCE', bergamo: 'MIL',
  'luxembourg city': 'LUX', zurich: 'ZRH', 'rome': 'ROM', 'milan': 'MIL', 'london': 'LON', 'paris': 'PAR', 'stockholm': 'STO',
  'warsaw': 'WAW', 'istanbul': 'IST', 'bucharest': 'BUH', 'oslo': 'OSL', 'venice': 'VCE', 'brussels': 'BRU', 'berlin': 'BER',
})) NAMES.set(alias, id);
// Secondary airports that carry a big city's name but are too far out to count.
const TOO_FAR = ['hahn', 'torp', 'skavsta', 'vasteras', 'radom', 'weeze', 'vatry', 'southend', 'rygge', 'beauvais'];

function cityOf(display) {
  const [head, tail] = plain(display).split(/\s*[–-]\s*/);
  if (tail && TOO_FAR.some((x) => tail.includes(x))) return null;
  return NAMES.get(plain(display)) || NAMES.get(head) || null;
}

async function wikitext(title) {
  const file = `${cache}/${title.replace(/[^\w]+/g, '_')}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const url = `https://en.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&redirects=1&page=${encodeURIComponent(title)}`;
  // Wikipedia asks robots to go slowly: one page at a time, backing off when told to.
  let json = null;
  for (let attempt = 1; attempt <= 6 && !json; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ViaggiGamePrototype/0.1 (route table import; https://github.com/GaryCrook/Viaggi)' } });
    const body = await res.text();
    try { json = JSON.parse(body); } catch { await new Promise((r) => setTimeout(r, 8000 * attempt)); }
  }
  if (!json) return { title: null, text: '', error: 'rate limited' };
  const out = { title: json.parse?.title || null, text: json.parse?.wikitext || '', error: json.error?.info || null };
  writeFileSync(file, JSON.stringify(out));
  await new Promise((r) => setTimeout(r, 2000));
  return out;
}

// Split on "|" that is not inside [[...]] or {{...}}.
function cells(body) {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; cur += two; i++; }
    else if (two === ']]' || two === '}}') { depth--; cur += two; i++; }
    else if (body[i] === '|' && depth === 0) { out.push(cur); cur = ''; }
    else cur += body[i];
  }
  out.push(cur);
  return out;
}

function passengerTable(text) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '');
  const from = Math.max(0, clean.search(/==+\s*Airlines and destinations\s*==+/i));
  const start = clean.slice(from).search(/\{\{\s*Airport[- ]dest(ination)?[- ]list/i);
  if (start < 0) return null;
  let i = from + start, depth = 0;
  for (let j = i; j < clean.length; j++) {
    if (clean.startsWith('{{', j)) { depth++; j++; } else if (clean.startsWith('}}', j)) { depth--; j++; if (!depth) return clean.slice(i + 2, j - 1); }
  }
  return null;
}

const routes = new Map();          // "A|B|carrier" (A<B) -> { regular, seasonal }
const report = [];
for (const [cityId, pages] of Object.entries(AIRPORTS)) {
  for (const page of pages) {
    const { title, text, error } = await wikitext(page);
    const body = text && passengerTable(text);
    if (!body) { report.push(`!! ${cityId} ${page}: ${error || 'no destination table found'}`); continue; }
    const all = cells(body).slice(1);
    const step = all.some((c) => /^\s*3rdcoltitle\s*=/.test(c)) ? 3 : 2;
    const rows = all.filter((c) => !/^\s*\w+\s*=/.test(c));
    let found = 0;
    for (let r = 0; r + 1 < rows.length; r += step) {
      const airline = (rows[r].match(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/)?.[1] || rows[r]).replace(/\{\{[^}]*\}\}/g, '').replace(/'''?/g, '').trim();
      if (!airline) continue;
      // Walk the destination cell, switching between regular, seasonal and charter runs.
      let kind = 'regular';
      for (const part of rows[r + 1].split(/('''[^']*''')/)) {
        if (part.startsWith("'''")) { kind = /charter/i.test(part) ? 'charter' : /seasonal/i.test(part) ? 'seasonal' : 'regular'; continue; }
        if (kind === 'charter') continue;
        for (const m of part.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
          const to = cityOf(m[2] || m[1]);
          if (!to || to === cityId) continue;
          const key = `${[cityId, to].sort().join('|')}|${airline}`;
          const rec = routes.get(key) || { regular: false, seasonal: false };
          rec[kind] = true;
          routes.set(key, rec);
          found++;
        }
      }
    }
    report.push(`${cityId} ${title}: ${found} links to game cities`);
  }
}

const rows = [...routes.entries()].map(([key, rec]) => { const [a, b, airline] = key.split('|'); return [a, b, airline, rec.regular ? 0 : 1]; })
  .sort((x, y) => (x[0] + x[1] + x[2]).localeCompare(y[0] + y[1] + y[2]));
const today = new Date().toISOString().slice(0, 10);
writeFileSync('src/data/europe-routes.js', `// Real air routes between the game's cities, generated by tools/fetch-routes.mjs.
// Source: the "Airlines and destinations" tables on Wikipedia's airport pages,
// read on ${today}. Text from Wikipedia is licensed CC BY-SA 4.0
// (https://creativecommons.org/licenses/by-sa/4.0/), and so is this file.
// [city, city, airline, seasonal]  seasonal: 1 = runs for part of the year only
export const AIR_ROUTES_DATE = '${today}';
export const AIR_ROUTES = ${JSON.stringify(rows).replace(/\],\[/g, '],\n  [').replace('[[', '[\n  [').replace(']]', '],\n]')};
`);
console.log(report.join('\n'));
console.log(`\n${rows.length} airline routes, ${new Set(rows.map((r) => r[0] + r[1])).size} city pairs, ${new Set(rows.map((r) => r[2])).size} airlines`);
