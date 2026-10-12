// Web prototype UI: map on one side, departure board on the other.
/* global maplibregl */

import { EUROPE } from './data/europe.js';
import { CHALLENGES, TRAINING, dailyChallenge } from './data/challenges.js';
import { POSTCARDS } from './data/postcards.js';
import { createWorld, MODES, inSeason } from './engine/world.js';
import * as G from './engine/game.js';
import { legStatus } from './engine/events.js';
import { sfx } from './sfx.js';
import { routeOptions } from './engine/planner.js';
import { arc, hash, local, distKm, fmtTime, fmtDay, fmtDur, MIN } from './engine/util.js';

// Swap for a Mapbox style URL + access token when moving to the Mapbox SDK.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const $ = (id) => document.getElementById(id);
const money = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;
const params = new URLSearchParams(location.search);
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// Best times for the no-time-limit mode. Kept on this device only.
const timesKey = (ch) => `tg-times-${ch.id}${ch.key ? `-${ch.key}` : ''}`;
const bestTimes = (ch) => store.get(timesKey(ch)) || [];
function addTime(ch, entry) {
  const list = [...bestTimes(ch), entry].sort((a, b) => a.mins - b.mins || a.spent - b.spent).slice(0, 10);
  store.set(timesKey(ch), list);
  return list;
}
// Time pill for the HUD: counts down against a deadline, or up when there is none.
const clockPill = (t) => (g.challenge.untimed
  ? ['Time taken', fmtDur((t - g.start) / MIN), false]
  : ['Time left', fmtDur((g.deadline - t) / MIN), (g.deadline - t) / MIN < 8 * 60]);

const ALL_CHALLENGES = [dailyChallenge(createWorld(EUROPE)), ...CHALLENGES];

let world, g, map, popup;
const pins = new Map();
const ui = { open: null, filter: 'all', peek: null, busy: false, modal: 'splash', coach: null, mode: 'race', saved: null, challenge: ALL_CHALLENGES[0].id,
  seenNews: 0, flip: false, keep: [], stamped: null };

// ------------------------------------------------------------------ map

function initMap() {
  map = new maplibregl.Map({
    container: 'map', style: MAP_STYLE, center: [10, 50], zoom: 3.3, minZoom: 2.5, maxZoom: 9,
    dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.on('load', () => {
    const empty = { type: 'FeatureCollection', features: [] };
    map.addLayer({ id: 'night', type: 'background', paint: { 'background-color': '#0a1530', 'background-opacity': 0 } });
    map.addSource('network', { type: 'geojson', data: empty });
    map.addLayer({ id: 'network', type: 'line', source: 'network', filter: ['==', ['get', 'mode'], 'rail'],
      paint: { 'line-color': '#1f7a5c', 'line-width': 1.6, 'line-opacity': 0.45 } });
    map.addLayer({ id: 'network-sea', type: 'line', source: 'network', filter: ['==', ['get', 'mode'], 'ferry'],
      paint: { 'line-color': '#1f5fa8', 'line-width': 1.6, 'line-opacity': 0.5, 'line-dasharray': [1, 2] } });
    // Route map: the spokes from whichever city the player has tapped.
    map.addSource('spokes', { type: 'geojson', data: empty });
    map.addLayer({ id: 'spokes', type: 'line', source: 'spokes', layout: { 'line-cap': 'round' },
      paint: { 'line-width': 1.8, 'line-opacity': 0.75,
        'line-color': ['match', ['get', 'mode'], 'rail', '#1f7a5c', 'ferry', '#1f5fa8', '#f28c28'] } });
    map.on('click', () => { if (ui.routes) { ui.routes = null; render(); fitRoutes(); } });
    map.addSource('path', { type: 'geojson', data: empty });
    map.addSource('preview', { type: 'geojson', data: empty });
    map.addLayer({ id: 'path-air', type: 'line', source: 'path', filter: ['==', ['get', 'mode'], 'air'],
      layout: { 'line-cap': 'round' }, paint: { 'line-color': '#e2532d', 'line-width': 2.5, 'line-opacity': 0.8 } });
    map.addLayer({ id: 'path-rail', type: 'line', source: 'path', filter: ['==', ['get', 'mode'], 'rail'],
      paint: { 'line-color': '#1f7a5c', 'line-width': 3, 'line-dasharray': [1.5, 1] } });
    map.addLayer({ id: 'path-ferry', type: 'line', source: 'path', filter: ['==', ['get', 'mode'], 'ferry'],
      paint: { 'line-color': '#1f5fa8', 'line-width': 3, 'line-dasharray': [0.5, 1.5] } });
    map.addLayer({ id: 'preview', type: 'line', source: 'preview',
      paint: { 'line-color': '#ffc24b', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
    showNetwork();
    renderMap();
  });
  for (const c of EUROPE.cities) {
    const el = document.createElement('div');
    el.className = 'pin';
    el.innerHTML = `<i>${c.emoji}</i><span>${c.name}</span><b class="tag"></b>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); pinClick(c.id); });
    pins.set(c.id, { el, marker: new maplibregl.Marker({ element: el }).setLngLat([c.lon, c.lat]).addTo(map) });
  }
}

// How dark it is at a local time. It follows the rule the player cares about:
// fully dark only while nothing departs (22:00 to 06:00), with dusk from 20:00.
function darkness(tz, ms) {
  const m = local(tz, ms).minutes;
  if (m >= 1320 || m < 270) return 1;
  if (m < 360) return 1 - (m - 270) / 90;
  if (m >= 1200) return (m - 1200) / 120;
  return 0;
}

function shade(tz, ms) {
  const d = darkness(tz, ms);
  if (map.getLayer('night')) map.setPaintProperty('night', 'background-opacity', d * 0.55);
  $('stage').classList.toggle('dark', d > 0.6);
}

const byRail = () => !world.modes.includes('air');

// In a rail game, draw the rail map so the player can see where the tracks go.
function showNetwork() {
  if (!world || !map.getSource('network')) return;
  const features = [...world.services.values()].flat().filter((s) => s.mode !== 'air' && s.from < s.to)
    .map((s) => line(world.cities.get(s.from), world.cities.get(s.to), s.mode));
  map.getSource('network').setData({ type: 'FeatureCollection', features });
}

// The route map belongs to the Routes tab. It shows the city you are in, or
// another city if you tap one while the tab is open.
const routeCity = () => (g && !g.over && ui.filter === 'routes' && !ui.peek ? ui.routes || g.city : null);

function fitRoutes() {
  const id = routeCity();
  if (!id) return;
  const c = world.cities.get(id), b = new maplibregl.LngLatBounds([c.lon, c.lat], [c.lon, c.lat]);
  for (const to of routeMap(id).keys()) { const d = world.cities.get(to); b.extend([d.lon, d.lat]); }
  map.fitBounds(b, { padding: { top: 150, bottom: 60, left: 60, right: 80 }, maxZoom: 6, duration: 700 });
}

// Everywhere you can travel to direct from a city, with the mode used: Map of cityId -> mode.
function routeMap(id) {
  const out = new Map();
  if (!id || !world) return out;
  const month = local(world.cities.get(id).tz, g.clock).m;
  for (const s of world.services.get(id)) if (inSeason(s, month) && (!out.has(s.to) || s.mode === 'air')) out.set(s.to, s.mode);
  return out;
}

const line = (a, b, mode) => ({ type: 'Feature', properties: { mode }, geometry: { type: 'LineString', coordinates: arc(a, b) } });

function renderMap() {
  if (!g) return;
  const reach = new Set(G.board(g).filter((r) => r.bookable).map((r) => r.leg.to));
  const wanted = G.stampCities(g);
  const hub = routeCity(), spokes = routeMap(hub);
  for (const [id, { el }] of pins) {
    const cls = ['pin'];
    if (!world.services.get(id).length) cls.push('off');
    if (id === g.challenge.home) cls.push('home');
    if (id === g.challenge.home && id !== g.city && g.challenge.targets.every((t) => g.collected.includes(t))) cls.push('rush');
    if (wanted.includes(id)) cls.push('target');
    if (g.collected.includes(id)) cls.push('done');
    if (id === g.city) cls.push('here');
    if (reach.has(id)) cls.push('reach');
    if (id === ui.open) cls.push('open');
    if (id === hub) cls.push('hub');
    else if (spokes.has(id)) cls.push('spoke');
    else if (hub) cls.push('faded');
    el.className = cls.join(' ');
    // Airport codes keep a busy route map readable; cities on your list keep their names.
    const named = byRail() || wanted.includes(id) || id === g.challenge.home || id === g.city;
    el.lastChild.textContent = named ? world.cities.get(id).name : world.cities.get(id).apt;
    el.firstChild.textContent = id === g.challenge.home ? '🏠' : world.cities.get(id).emoji;
  }
  if (!map.getSource('path')) return;
  const city = (id) => world.cities.get(id);
  shade(G.here(g).tz, g.clock);
  map.getSource('spokes').setData({ type: 'FeatureCollection',
    features: [...spokes].map(([to, mode]) => line(city(hub), city(to), mode)) });
  map.getSource('path').setData({ type: 'FeatureCollection', features: g.path.map((p) => line(city(p.from), city(p.to), p.mode)) });
  map.getSource('preview').setData({ type: 'FeatureCollection',
    features: ui.open && world.cities.has(ui.open) && ui.open !== g.city && !ui.peek ? [line(G.here(g), city(ui.open), 'preview')] : [] });
}

function frame() {
  const ids = new Set([g.city, g.challenge.home, ...G.stampCities(g).filter((t) => !g.collected.includes(t))]);
  const b = new maplibregl.LngLatBounds();
  for (const id of ids) { const c = world.cities.get(id); b.extend([c.lon, c.lat]); }
  map.fitBounds(b, { padding: { top: 90, bottom: 50, left: 50, right: 70 }, maxZoom: 5.5, duration: 900 });
}

// Time-lapse of one leg: the clock spins through the wait at the terminal, then
// the plane or train crosses the map at a speed that reflects the journey time,
// and the map darkens and lightens as the day passes.
function travel(from, to, row) {
  return new Promise((resolve) => {
    const pts = arc(from, to, 120), el = document.createElement('div');
    el.className = 'mover';
    el.innerHTML = `<span>${MODES[row.leg.mode].icon}</span><b></b>`;
    const m = new maplibregl.Marker({ element: el }).setLngLat(pts[0]).addTo(map);
    const label = el.lastChild, left = $('hud').querySelector('.pill b');
    const wait = row.dep - g.clock > 20 * MIN ? 700 : 0;
    const ride = Math.min(4200, 1100 + ((row.arr - row.dep) / MIN) * 9);
    const dur = wait + ride, t0 = performance.now();
    setTimeout(() => sfx.travel(row.leg.mode, ride), wait);
    let finished = false;
    const end = () => { if (finished) return; finished = true; m.remove(); resolve(); };
    const step = (now) => {
      const ms = Math.min(dur, now - t0);
      let clock, tz, e = 0;
      if (ms < wait) { clock = g.clock + (row.dep - g.clock) * (ms / wait); tz = from.tz; }
      else {
        const f = (ms - wait) / ride;
        e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
        clock = row.dep + (row.arr - row.dep) * e;
        tz = e < 0.5 ? from.tz : to.tz;
      }
      m.setLngLat(pts[Math.round(e * (pts.length - 1))]);
      label.textContent = fmtTime(tz, clock);
      shade(tz, clock);
      setClock(tz, clock);
      if (left) left.textContent = clockPill(clock)[1];
      if (ms < dur) requestAnimationFrame(step); else end();
    };
    requestAnimationFrame(step);
    setTimeout(end, dur + 500);     // rAF is paused in background tabs
  });
}

// One line above the map saying whose routes are showing, kept clear of the map itself.
function renderCaption() {
  const el = $('caption'), id = routeCity();
  if (!id || ui.modal) { el.innerHTML = ''; return; }
  const c = world.cities.get(id), here = G.here(g), n = routeMap(id).size;
  const direct = id === g.city ? 0 : G.board(g).filter((r) => r.leg.to === id).length;
  const local = id === g.city ? 'Tap any city to see its routes.'
    : `${direct ? `${here.name} to ${c.name}: ${direct} today.` : `Nothing direct from ${here.name} today.`} Tap ${c.name} again for ${here.name}.`;
  el.innerHTML = `<div><b>${c.emoji} From ${c.name}</b>
    <span>${n} place${n === 1 ? '' : 's'} direct ${byRail() ? 'by train or ferry' : 'by air'} · ${local}</span>
    <button data-act="noroutes" aria-label="Close route map">✕</button></div>`;
}

// Tapping a city. With the Routes tab open it moves the route map to that city
// (tap again to return to your own). Otherwise it opens today's departures to
// that city on the board and offers its route map.
function pinClick(id) {
  if (!g || g.over || ui.busy || ui.modal) return;
  const c = world.cities.get(id), here = G.here(g);
  popup?.remove();
  if (ui.filter === 'routes') {
    ui.routes = ui.routes === id || id === g.city ? null : id;
    render();
    fitRoutes();
    return;
  }
  const onList = G.stampCities(g).includes(id);
  const status = id === g.city ? 'You are here.'
    : onList ? (g.collected.includes(id) ? 'Passport stamped.' : 'On your list: stamp needed.')
    : id === g.challenge.home ? 'Home. Finish here.' : 'Not on your list.';
  const direct = id === g.city ? 0 : G.board(g).filter((r) => r.leg.to === id).length;
  const board = id === g.city ? '' : direct
    ? `<p><b>${here.name} to ${c.name}:</b> ${direct} departure${direct > 1 ? 's' : ''} today, shown on the board.</p>`
    : `<p><b>${here.name} to ${c.name}:</b> nothing direct today.</p>`;
  popup = new maplibregl.Popup({ offset: 16, closeButton: false, maxWidth: '260px' })
    .setLngLat([c.lon, c.lat])
    .setHTML(`<h3>${c.emoji} ${c.name}</h3><p>${status}</p>${board}
      <button class="btn" data-act="routesfrom" data-id="${id}">Route map from ${c.name}</button>`)
    .addTo(map);
  if (id !== g.city) { ui.open = id; ui.filter = 'all'; }
  render();
  scrollToOpen();
}

// Bring the opened destination and its list of departures into view. The row
// goes last so that it wins when the list is taller than the board.
function scrollToOpen() {
  const row = document.querySelector('.row.open');
  if (!row) return;
  if (row.nextElementSibling?.classList.contains('opts')) row.nextElementSibling.scrollIntoView({ block: 'nearest' });
  row.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ clock

// Four clock faces to choose from (Menu > Clock style). Each is an SVG on a
// 100 x 100 grid whose `.hour` and `.minute` parts are turned to the time.
const ring = (n, draw) => Array.from({ length: n }, (_, i) => draw(i)).join('');
const ROMAN = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
const numeral = (label, i, r, size) => {
  const a = (i * 30 * Math.PI) / 180;
  return `<text x="${(50 + r * Math.sin(a)).toFixed(1)}" y="${(50 - r * Math.cos(a) + size * 0.36).toFixed(1)}" text-anchor="middle" font-size="${size}">${label}</text>`;
};

const CLOCKS = {
  platform: {
    name: 'Platform classic', note: 'Roman numerals, dark case',
    svg: `<circle class="case" cx="50" cy="50" r="49"/><circle class="bezel" cx="50" cy="50" r="44.5"/><circle class="face" cx="50" cy="50" r="42"/>
      <g class="ticks">${ring(60, (i) => `<line x1="50" y1="9.5" x2="50" y2="${i % 5 ? 11.5 : 13.5}" stroke-width="${i % 5 ? 0.7 : 1.6}" transform="rotate(${i * 6} 50 50)"/>`)}</g>
      <g class="numerals serif">${ring(12, (i) => numeral(ROMAN[i], i, 30.5, 9))}</g>
      <path class="hour" d="M50 55 L47.6 50 L48.7 33 Q50 24 51.3 33 L52.4 50 Z"/>
      <path class="minute" d="M50 57 L48.4 50 L49.2 20 Q50 12 50.8 20 L51.6 50 Z"/>
      <circle class="hub" cx="50" cy="50" r="2.8"/>`,
  },
  continental: {
    name: 'Continental station', note: 'Bold markers, baton hands',
    svg: `<circle class="case" cx="50" cy="50" r="49"/><circle class="face" cx="50" cy="50" r="44"/>
      <g class="ticks">${ring(60, (i) => (i % 5
        ? `<line x1="50" y1="9" x2="50" y2="12" stroke-width="1" transform="rotate(${i * 6} 50 50)"/>`
        : `<line x1="50" y1="9" x2="50" y2="19" stroke-width="3.6" transform="rotate(${i * 6} 50 50)"/>`))}</g>
      <rect class="hour" x="47.2" y="24" width="5.6" height="34" rx="0.6"/>
      <rect class="minute" x="48" y="10" width="4" height="48" rx="0.5"/>
      <circle class="hub" cx="50" cy="50" r="2.4"/>`,
  },
  brass: {
    name: 'Ticket hall brass', note: 'Brass rim, cream face',
    svg: `<circle class="case" cx="50" cy="50" r="49"/><circle class="bezel" cx="50" cy="50" r="45"/><circle class="face" cx="50" cy="50" r="41"/>
      <g class="ticks">${ring(60, (i) => `<circle cx="50" cy="12" r="${i % 5 ? 0.5 : 1.2}" transform="rotate(${i * 6} 50 50)"/>`)}</g>
      <g class="numerals serif">${ring(12, (i) => numeral(i || 12, i, 30, 9.5))}</g>
      <text class="maker" x="50" y="66" text-anchor="middle" font-size="4.2" letter-spacing="1.2">VIAGGI</text>
      <path class="hour" d="M50 55 L48 50 L49 30 L50 25 L51 30 L52 50 Z"/>
      <path class="minute" d="M50 57 L48.8 50 L49.4 17 L50 12 L50.6 17 L51.2 50 Z"/>
      <circle class="hub" cx="50" cy="50" r="2.6"/>`,
  },
  modern: {
    name: 'Modern', note: 'Plain face, coloured minute hand',
    svg: `<circle class="face" cx="50" cy="50" r="47"/>
      <g class="ticks">${ring(12, (i) => `<line x1="50" y1="${i % 3 ? 9 : 7}" x2="50" y2="${i % 3 ? 13 : 16}" transform="rotate(${i * 30} 50 50)"/>`)}</g>
      <line class="hour" x1="50" y1="54" x2="50" y2="27"/><line class="minute" x1="50" y1="56" x2="50" y2="13"/>
      <circle class="hub" cx="50" cy="50" r="3.5"/>`,
  },
};
const clockStyle = () => (CLOCKS[store.get('tg-clock')] ? store.get('tg-clock') : 'platform');
const dial = (style) => `<svg class="dial c-${style}" viewBox="0 0 100 100" role="img">${CLOCKS[style].svg}</svg>`;
const clockHTML = () => `<div class="clock" id="clock">${dial(clockStyle())}<b></b><small></small></div>`;

// Turn the hands of one dial to a local time.
function setHands(svg, p) {
  svg.querySelector('.hour').setAttribute('transform', `rotate(${(p.minutes / 2) % 360} 50 50)`);
  svg.querySelector('.minute').setAttribute('transform', `rotate(${p.min * 6} 50 50)`);
}

// Point the header clock at a local time. At night the face is lit from within,
// since an analogue dial cannot tell 8 in the morning from 8 in the evening.
function setClock(tz, ms) {
  const el = $('clock');
  if (!el) return;
  const p = local(tz, ms);
  setHands(el.querySelector('svg'), p);
  el.classList.toggle('night', p.minutes >= 1320 || p.minutes < 360);
  el.querySelector('svg').setAttribute('aria-label', `${fmtTime(tz, ms)} local time`);
  el.querySelector('b').textContent = fmtTime(tz, ms);
  el.querySelector('small').textContent = p.h < 12 ? 'morning' : p.h < 18 ? 'afternoon' : p.h < 22 ? 'evening' : 'night';
}

function clocksSheet() {
  const p = local(G.here(g).tz, g.clock), current = clockStyle();
  const cards = Object.entries(CLOCKS).map(([id, c]) => `
    <button class="card clockcard ${id === current ? 'on' : ''}" data-act="clockstyle" data-id="${id}">
      ${dial(id)}<b>${c.name}</b><small>${c.note}</small></button>`).join('');
  setTimeout(() => document.querySelectorAll('.clockcard svg').forEach((svg) => setHands(svg, p)));
  return `<h2>Clock style</h2><p>Each shows the time where you are now. Tap one to use it.</p>
    <div class="clockgrid">${cards}</div>
    <div class="row-btns"><button class="btn" data-act="close">Done</button></div>`;
}

// ------------------------------------------------------------------ passport

// Border stamps. Schengen countries use the familiar rectangle: country letter
// in a ring of stars, how you arrived, the date and the crossing point.
// Countries outside Schengen get their own shapes.
const INKS = ['#1f3f8f', '#a3262a', '#1d6b4f', '#3b2a6b', '#26282c'];
const NATIONS = {
  GB: ['GB', 'UNITED KINGDOM'], IE: ['IRL', 'ÉIRE · IRELAND'], FR: ['F', 'FRANCE'], NL: ['NL', 'NEDERLAND'], BE: ['B', 'BELGIË · BELGIQUE'],
  LU: ['L', 'LËTZEBUERG'], DE: ['D', 'DEUTSCHLAND'], CH: ['CH', 'SCHWEIZ · SUISSE'], AT: ['A', 'ÖSTERREICH'], ES: ['E', 'ESPAÑA'],
  PT: ['P', 'PORTUGAL'], IT: ['I', 'ITALIA'], MT: ['M', 'MALTA'], DK: ['DK', 'DANMARK'], SE: ['S', 'SVERIGE'], NO: ['N', 'NORGE'],
  FI: ['FIN', 'SUOMI'], IS: ['IS', 'ÍSLAND'], EE: ['EST', 'EESTI'], LV: ['LV', 'LATVIJA'], LT: ['LT', 'LIETUVA'], PL: ['PL', 'POLSKA'],
  CZ: ['CZ', 'ČESKO'], HU: ['H', 'MAGYARORSZÁG'], RO: ['RO', 'ROMÂNIA'], BG: ['BG', 'БЪЛГАРИЯ'], RS: ['SRB', 'СРБИЈА'], HR: ['HR', 'HRVATSKA'],
  SI: ['SLO', 'SLOVENIJA'], GR: ['GR', 'ΕΛΛΑΣ'], TR: ['TR', 'TÜRKİYE'],
};
const OUTSIDE_SCHENGEN = { GB: 'oval', IE: 'double', TR: 'round', RS: 'hex' };
const ICONS = {
  air: 'M8 0l2 6 6 3v2l-6-1-1 3 2 1.5V16l-3-1-3 1v-1.5L7 13l-1-3-6 1V9l6-3z',
  rail: 'M3 1h10a2 2 0 012 2v8a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm1 2v4h8V3zm0 6.5v1.5h2V9.5zm6 0v1.5h2V9.5zM4 14l-2 2h2l1-2zm8 0l2 2h-2l-1-2z',
  ferry: 'M7 0h2v3h3v4l3 1-2 5H3L1 8l3-1V3h3zm-1 5v2h4V5zM0 15h16v1H0z',
};

function stampHTML(id, big = false) {
  const c = world.cities.get(id), t = g.stampAt[id];
  if (!t) return `<div class="stp blank ${big ? 'big' : ''}"><i>${c.emoji}</i><small>${c.name}</small></div>`;
  const p = local(c.tz, t), h = hash(`ink|${c.country}`), [letter, nation] = NATIONS[c.country] || [c.country, c.name];
  const via = g.stampVia[id] || { mode: 'air', place: c.apt };
  const date = `${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}.${String(p.y).slice(2)}`;
  const shape = OUTSIDE_SCHENGEN[c.country] || 'rect';
  const frame = {
    rect: '<rect x="3" y="3" width="114" height="78" rx="4"/>',
    double: '<rect x="3" y="3" width="114" height="78" rx="2"/><rect x="7" y="7" width="106" height="70" rx="1" stroke-width="1"/>',
    oval: '<ellipse cx="60" cy="42" rx="57" ry="39"/><ellipse cx="60" cy="42" rx="52" ry="34" stroke-width="1"/>',
    round: '<circle cx="60" cy="42" r="39"/><circle cx="60" cy="42" r="34" stroke-width="1"/>',
    hex: '<path d="M22 3h76l19 39-19 39H22L3 42z"/>',
  }[shape];
  const place = (via.place === c.name ? c.name : `${via.place} · ${c.name}`).toUpperCase();
  const body = shape === 'rect' || shape === 'double'
    ? `<circle cx="21" cy="22" r="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="1.4 4.88"/>
       <text x="21" y="${letter.length > 2 ? 24.5 : 26}" text-anchor="middle" font-size="${letter.length > 2 ? 7.5 : 11}" font-weight="700">${letter}</text>
       <text x="66" y="19" text-anchor="middle" font-size="${nation.length > 13 ? 6.2 : 8}" letter-spacing=".8">${nation}</text>
       <path d="${ICONS[via.mode]}" transform="translate(97 24)"/>
       <path d="M78 57h13m-4-4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="96" y="50" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"/>
       <text x="44" y="53" text-anchor="middle" font-size="17" font-weight="700" class="mono">${date}</text>
       <text x="60" y="73" text-anchor="middle" font-size="${place.length > 20 ? 6 : 7.5}" letter-spacing=".5">${place}</text>`
    : `<text x="60" y="${shape === 'round' ? 24 : 22}" text-anchor="middle" font-size="${nation.length > 13 ? 6.5 : 8}" letter-spacing=".8">${nation}</text>
       <path d="${ICONS[via.mode]}" transform="translate(52 ${shape === 'round' ? 27 : 25}) scale(.9)"/>
       <text x="60" y="56" text-anchor="middle" font-size="15" font-weight="700" class="mono">${date}</text>
       <text x="60" y="67" text-anchor="middle" font-size="${place.length > 16 ? 5.5 : 7}" letter-spacing=".5">${place}</text>`;
  return `<svg class="stp ${big ? 'big' : ''}" viewBox="0 0 120 84" role="img" aria-label="${c.name} entry stamp, ${date}"
      style="--ink:${INKS[h % INKS.length]};--r:${(hash(`tilt|${id}`) % 17) - 8}deg">
    <g filter="url(#rough)"><g fill="none" stroke="currentColor" stroke-width="2.4">${frame}</g><g fill="currentColor">${body}</g></g></svg>`;
}

// ------------------------------------------------------------------ training coach

// The next thing to teach, worked out from where the player is. Because it is
// derived from the game state, the player can wander off and the coach keeps up.
function coachStep() {
  if (!g?.challenge.training || g.over || !ui.coach) return null;
  const want = g.challenge.targets.filter((t) => !g.collected.includes(t));
  const T = want.includes(g.city) ? g.city : want[0] || g.challenge.home;
  const there = world.cities.get(T), here = G.here(g);
  if (ui.modal === 'stamp') {
    return { text: 'That stamp is your proof of the visit. Collect one in every city on your list.', target: '.sheet [data-act=close]' };
  }
  if (ui.modal === 'night') {
    return { text: 'Nothing departs between 22:00 and 06:00, so you are booked into a hotel. It costs money, which is why arriving late is a risk. On rail and sail journeys an overnight ferry or sleeper is your bed instead.', target: '.sheet [data-act=sleep]' };
  }
  if (ui.modal) return null;
  if (ui.coach.intro) {
    const names = g.challenge.targets.map((t) => world.cities.get(t).name).join(' and ');
    return { next: true, target: '#hud .pill:not(.menu)',
      text: `Welcome to ${here.name}. Your list is ${names}, then home again. Top left shows the time left, the money left and your stamps. The clock on the right shows local time.` };
  }
  if (g.city === T && want.includes(T)) {
    const plan = G.visitPlan(g);
    return { target: '.act[data-act=visit]',
      text: `You are in ${here.name}, but the stamp office is in town. Going there takes time${plan.transfer ? ` and a ${money(plan.transfer)} airport transfer` : ''}. Tap “Get passport stamped”.` };
  }
  const home = want.length ? '' : `Full passport! Now get home to ${there.name} before the time runs out. `;
  const toT = G.board(g).filter((r) => r.leg.to === T);
  const direct = toT.some((r) => r.bookable || r.tight), onlyRisky = direct && !toT.some((r) => r.bookable);
  if (ui.filter === 'routes') {
    const today = G.board(g);
    const ready = (routeOptions(g, (leg) => legStatus(g.events, leg, world, g.seed, g.clock)).get(T) || [])
      .some((r) => today.some((x) => x.leg.id === r.legs[0].leg.id && (x.bookable || x.tight)));
    if (!ready && onlyRisky) {
      return { target: '[data-act=filter][data-id=all]',
        text: `${home}It is getting late. One departure to ${there.name} is still on the board, but you would have to run for it. Tap “All” to look, or stay the night.` };
    }
    if (!ready) {
      return { target: '.act[data-act=night]',
        text: `${home}Every way to ${there.name} now leaves tomorrow. Tap “Stay the night”: you are booked into a hotel and wake at 06:00.` };
    }
    return { target: `.rt-city[data-city="${T}"] .go`,
      text: `${home}Routes compares the fastest, the cheapest and the best value way to each city. Press Go on a route to ${there.name} to take its first leg.` };
  }
  if (g.collected.length === 1 && !ui.coach.routes && want.length) {
    return { target: '[data-act=filter][data-id=routes]',
      text: `One stamp down. You are now in the city centre, so a flight needs extra time and a transfer back to the airport. Tap “Routes” to compare ways to ${there.name}.` };
  }
  if (!direct) {
    return { target: '[data-act=filter][data-id=routes]',
      text: `${home}Nothing more goes straight to ${there.name} today. Tap “Routes” to look for a connection, or stay the night.` };
  }
  if (ui.open === T && onlyRisky) {
    return { target: '.opts .go.run, .act[data-act=night]',
      text: `You are too late to stroll to this one. “Run” gambles the fare on the chance shown; “Flex” costs more, but if you miss it you are moved to the next departure. Or play safe and stay the night: nothing leaves after 22:00.` };
  }
  if (ui.open === T) {
    return { target: '.opts .go:not([disabled])',
      text: 'Each line is one departure: when it leaves, when it lands and what it costs. Cheaper ones often leave later. Press Go on the one you want and watch the clock.' };
  }
  return { target: `.row[data-id="${T}"]`, text: `${home}This is the departure board. A ★ marks a city on your list. Tap ${there.name}.` };
}

function coachHTML() {
  const step = coachStep();
  if (!step) return '';
  return `<div class="coach"><b>Coach</b><p>${step.text}</p><div>
    ${step.next ? '<button class="btn" data-act="coachnext">Got it</button>' : ''}
    <button class="skip" data-act="again">Leave training</button></div></div>`;
}

function markCoachTarget() {
  document.querySelectorAll('.coach-target').forEach((el) => el.classList.remove('coach-target'));
  const step = coachStep();
  if (!step?.target) return;
  const els = document.querySelectorAll(step.target);
  els.forEach((el) => el.classList.add('coach-target'));
  if (els[0]?.closest('.rows')) els[0].scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ panel

function render() {
  $('app').classList.toggle('busy', ui.busy);
  renderModal();
  if (!g) { $('panel').innerHTML = ''; $('hud').innerHTML = ''; $('caption').innerHTML = ''; return; }
  renderHud();
  renderPanel();
  renderMap();
  renderCaption();
  if (ui.flip) { ui.flip = false; flipBoard(); }
  markCoachTarget();
}

function renderHud() {
  const cash = G.remaining(g);
  const got = g.challenge.targets.filter((t) => g.collected.includes(t)).length;
  const pill = (label, value, warn) => `<div class="pill ${warn ? 'warn' : ''}"><small>${label}</small><b>${value}</b></div>`;
  $('hud').innerHTML =
    pill(...clockPill(g.clock)) +
    pill('Budget left', money(cash), cash < g.challenge.budget * 0.15) +
    pill('Stamps', `${got}/${g.challenge.targets.length}`) +
    '<button class="pill menu" data-act="menu" aria-label="Menu">☰ Menu</button>';
}

function renderPanel() {
  const c = G.here(g), tz = c.tz;
  const latest = G.news(g).at(-1);
  const plan = G.visitPlan(g);
  const slots = G.stampCities(g).map((id) => {
    const t = world.cities.get(id);
    const state = g.collected.includes(id) ? 'done' : id === g.city ? 'due' : g.skipped.includes(id) ? 'missed' : '';
    return `<div class="slot ${state}"><i>${t.emoji}</i>${t.name}${state === 'missed' ? ' ↩' : ''}</div>`;
  }).join('');
  const tickets = G.tickets(g).map((t) =>
    `<span class="tkt ${t.status}" title="${t.text}">${t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '🎫'} ${t.name}</span>`).join('');

  // Rebuilding the panel resets its scroll, so carry the position over unless the board itself is new.
  const keep = ui.flip ? null : { rows: document.querySelector('.rows')?.scrollTop, panel: $('panel').scrollTop };
  const homeCity = world.cities.get(g.challenge.home);
  const allDone = g.challenge.targets.every((t) => g.collected.includes(t));
  const hurry = allDone && !g.over
    ? `<div class="gohome"><b>🏁 Full passport! Hurry home to ${homeCity.name}.</b><span>${g.challenge.untimed ? 'The clock is still running.' : `${clockPill(g.clock)[1]} left to get there.`}</span></div>` : '';
  $('panel').innerHTML = `
    ${ui.modal ? '' : coachHTML()}
    ${hurry}
    ${latest ? `<button class="ticker" data-act="log"><b>NEWS</b><span>${latest.text}</span></button>` : ''}
    <header class="where">
      <div>
        <div class="kicker">${g.place === 'airport' ? `Airport · ${c.apt}` : g.place === 'port' ? `Ferry port · ${g.port.name}` : byRail() ? 'Central station' : 'City centre'}</div>
        <h1>${c.name}</h1>
        <div class="when">${fmtDay(tz, g.clock)} · local time</div>
      </div>
      ${clockHTML()}
    </header>
    <button class="strip" data-act="passport" aria-label="Open passport">
      <span class="cover">PASS<br>PORT</span><span class="slots">${slots}</span>
    </button>
    ${tickets ? `<div class="tkts">${tickets}</div>` : ''}
    <div class="actions">
      <button class="act primary ${plan.why ? '' : 'ready'}" data-act="visit" ${plan.why ? 'disabled' : ''}>
        <b>${c.emoji} Get passport stamped</b>
        <small>${plan.why || `${fmtDur(plan.mins)} · ${money(plan.cost)}${plan.transfer ? ' incl. transfer' : ''}`}</small>
      </button>
      <button class="act" data-act="night">
        <b>🛏 Stay the night</b>
        <small>Hotel ${money(G.hotelCost(g).total)} · wake at 06:00</small>
      </button>
    </div>
    ${renderBoard()}
    <div class="foot"><button data-act="log">Journey log</button><button data-act="menu">End journey</button></div>`;
  setClock(tz, g.clock);
  if (!keep) $('panel').scrollTop = 0;
  if (keep) {
    $('panel').scrollTop = keep.panel;
    if (keep.rows) document.querySelector('.rows').scrollTop = keep.rows;
  }
}

function grouped(rows, want) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.leg.to)) groups.set(r.leg.to, []);
    groups.get(r.leg.to).push(r);
  }
  let list = [...groups.entries()].map(([to, rs]) =>
    ({ to, rows: rs, lead: rs.find((r) => r.bookable) || rs.find((r) => r.tight) || rs.find((r) => !r.why) || rs[0] }));
  if (ui.filter === 'mine') list = list.filter((x) => want.has(x.to));
  return list.sort((a, b) => a.lead.dep - b.lead.dep);
}

function renderBoard() {
  const cityId = ui.peek || g.city, c = world.cities.get(cityId);
  const want = new Set([...G.stampCities(g).filter((t) => !g.collected.includes(t)), g.challenge.home]);
  const today = G.board(g, cityId);

  const rowHTML = ({ to, rows, lead }, later) => {
    const d = world.cities.get(to), leg = lead.leg;
    const dim = later || (ui.peek ? lead.status === 'cancelled' : !lead.bookable && !lead.tight);
    const more = rows.length > 1 ? ` · ${rows.length} ${later ? 'tomorrow' : 'today'}` : '';
    const st = lead.status === 'cancelled' ? '<span class="st-cancelled">CANCELLED</span> · '
      : lead.status === 'delayed' ? `<span class="st-delayed">DELAYED from ${fmtTime(c.tz, leg.dep)}</span> · `
      : lead.tight && !ui.peek && !later ? '<span class="st-delayed">RUN FOR IT</span> · '
      : lead.why === 'late' && !ui.peek && !later ? `<span class="st-late">TOO LATE · NEED ${fmtDur(lead.lead.min).toUpperCase()}</span> · ` : '';
    const key = later ? `t:${to}` : to;
    const head = `
      <button class="row ${dim ? 'dim' : ''} ${ui.open === key ? 'open' : ''}" data-act="open" data-id="${key}">
        <span class="t ${lead.status !== 'ontime' ? `st-${lead.status}` : ''}">${fmtTime(c.tz, lead.dep)}</span>
        <span class="d"><span class="n">${d.name}</span>${want.has(to) ? '<em>★</em>' : ''}<span class="m">${st}${leg.sleeper ? '🌙' : MODES[leg.mode].icon} ${leg.no} · ${fmtDur(leg.durMin)}${more}</span></span>
        <span class="p">${money(lead.total)}</span>
      </button>`;
    return ui.open === key ? head + `<div class="opts">${rows.map((r) => renderOption(r, c, d, later)).join('')}</div>` : head;
  };

  const rows = grouped(today, want).map((x) => rowHTML(x, false)).join('');
  const next = grouped(G.tomorrow(g, cityId), want);
  const nextRows = next.length
    ? `<div class="sep"><b>Tomorrow</b><span>Stay the night to book</span></div>${next.map((x) => rowHTML(x, true)).join('')}` : '';

  const title = ui.peek
    ? `<button class="back" data-act="unpeek">← Back to ${G.here(g).name}</button><h2>From ${c.name}</h2>`
      + `<span class="peeknote">Tap ${c.name} on the map to flip back</span>`
    : `<h2>Departures</h2><div class="seg">
        <button class="${ui.filter === 'all' ? 'on' : ''}" data-act="filter" data-id="all">All</button>
        <button class="${ui.filter === 'mine' ? 'on' : ''}" data-act="filter" data-id="mine">★ My list</button>
        <button class="${ui.filter === 'routes' ? 'on' : ''}" data-act="filter" data-id="routes">Routes</button></div>`;
  if (ui.filter === 'routes' && !ui.peek) {
    return `<section class="board"><div class="board-head">${title}</div><div class="rows">${renderRoutes(today, want)}</div></section>`;
  }
  const empty = !today.length ? 'Nothing more leaves tonight.' : `No direct departures to your cities today.<br>Switch to All and ${byRail() ? 'change trains on the way' : 'connect through a hub'}.`;
  return `<section class="board">
    <div class="board-head">${title}</div>
    <div class="cols"><span>Time</span><span>Destination</span><span>From</span></div>
    <div class="rows">${rows || `<div class="empty">${empty}</div>`}${nextRows}</div>
  </section>`;
}

// Ways to reach each city still on the list: fastest, cheapest, best value.
function renderRoutes(today, want) {
  const options = routeOptions(g, (leg) => legStatus(g.events, leg, world, g.seed, g.clock));
  const here = G.here(g);
  const blocks = [...want].filter((id) => id !== g.city).map((id) => {
    const d = world.cities.get(id), routes = (options.get(id) || []).sort((a, b) => a.t - b.t);
    if (!routes.length) return `<div class="rt-city"><h3>${d.emoji} ${d.name}</h3><p class="rt-none">No way there in the next four days.</p></div>`;
    const cards = routes.map((r) => {
      const first = r.legs[0], row = today.find((x) => x.leg.id === first.leg.id);
      const path = r.legs.map((x) => `${x.leg.sleeper ? '🌙' : MODES[x.leg.mode].icon} ${world.cities.get(x.leg.to).name}`).join(' → ');
      const berth = r.legs.some((x) => x.leg.berth);
      const tags = [r.legs.length > 1 ? `${r.legs.length - 1} change${r.legs.length > 2 ? 's' : ''}` : 'direct',
        r.nights ? `${r.nights} hotel night${r.nights > 1 ? 's' : ''}` : '', berth ? 'sleep on board' : ''].filter(Boolean).join(' · ');
      const go = row && (row.bookable || row.tight)
        ? `<button class="go ${row.tight ? 'run' : ''}" data-act="go" data-id="${first.leg.id}">${row.tight ? 'Run' : 'Go'} ${fmtTime(here.tz, first.dep)}</button>`
        : `<span class="rt-later">leaves ${fmtDay(here.tz, first.dep).slice(0, 3)} ${fmtTime(here.tz, first.dep)}</span>`;
      return `<div class="rt"><div>
          <b class="rt-label">${r.labels.join(' · ')}</b>
          <span class="rt-path">${path}</span>
          <span class="note">arrives ${fmtDay(d.tz, r.t).slice(0, 3)} ${fmtTime(d.tz, r.t)} · ${fmtDur((r.t - g.clock) / MIN)} · ${tags}</span>
        </div><div class="rt-side"><b>${money(r.money)}</b>${go}</div></div>`;
    }).join('');
    return `<div class="rt-city" data-city="${id}"><h3>${d.emoji} ${d.name}</h3>${cards}</div>`;
  }).join('');
  return blocks + '<p class="rt-foot">Prices include an estimate for hotel nights spent waiting. Only the first leg is booked; plans can change on the way.</p>';
}

function renderOption(r, from, to, later) {
  const { leg } = r, readOnly = ui.peek || later;
  const notes = [];
  if (r.status === 'cancelled') notes.push('<span class="st-cancelled">Cancelled</span>');
  if (r.status === 'delayed') notes.push(`<span class="st-delayed">Delayed ${fmtDur((r.dep - leg.dep) / MIN)}</span>`);
  if (r.divertTo && r.known) notes.push(`<span class="st-delayed">Diverting to ${world.cities.get(r.divertTo).name}</span>`);
  if (!readOnly && r.lead.cost) notes.push(`incl. ${money(r.lead.cost)} transfer`);
  if (fmtDay(to.tz, r.arr) !== fmtDay(from.tz, r.dep)) notes.push(`arrives ${fmtDay(to.tz, r.arr)}`);
  if (leg.mode === 'ferry') notes.push(`${leg.port.name} to ${leg.portTo.name}`);
  if (!readOnly) r.lead.links.forEach((l) => notes.push(`${l.kind} ${fmtDur(l.mins)} ${l === leg.port ? 'to' : 'from'} ${l.name}`));
  if (leg.berth) notes.push(`${leg.sleeper ? 'sleeper: ' : ''}berth included, no hotel`);
  if (leg.seats) notes.push(`${leg.seats} seat${leg.seats > 1 ? 's' : ''} left`);
  if (!readOnly && r.tight) notes.push(`<span class="st-delayed">${Math.round(r.tight.p * 100)}% chance you make it</span> · miss it and Run loses the fare; Flex moves you to the next departure`);
  else if (!readOnly && r.why === 'late') {
    notes.push(leg.mode === 'air' && g.place !== 'airport'
      ? `Too late: ${fmtDur(G.here(g).xfer)} to the airport plus ${fmtDur(G.RULES.airFromCity)} check-in`
      : `Too late: you need ${fmtDur(r.lead.min)} before departure`);
  }
  if (!readOnly && r.why === 'funds') notes.push('Over budget');
  let btn = `<b>${money(leg.fare)}</b>`;
  if (!readOnly && r.tight) {
    btn = `<span class="pair">
      <button class="go run" data-act="go" data-id="${leg.id}" title="Miss it and the fare is lost">Run ${money(r.total)}</button>
      <button class="go flex" data-act="goflex" data-id="${leg.id}" title="Miss it and you are moved to the next departure, paying any difference" ${r.flexTotal > G.remaining(g) ? 'disabled' : ''}>Flex ${money(r.flexTotal)}</button></span>`;
  } else if (!readOnly) {
    btn = `<button class="go" data-act="go" data-id="${leg.id}" ${r.bookable ? '' : 'disabled'}>Go ${money(r.total)}</button>`;
  }
  return `<div class="opt"><div>
      <b>${fmtTime(from.tz, r.dep)} → ${fmtTime(to.tz, r.arr)}</b> ${leg.no} · ${leg.carrier}
      <span class="note">${notes.join(' · ') || `Arrives ${fmtDay(to.tz, r.arr)}, local time`}</span>
    </div>${btn}</div>`;
}

// Split-flap effect: times and destinations rattle through characters before settling.
function flipBoard() {
  const cells = [...document.querySelectorAll('.rows .row')].slice(0, 16).flatMap((row, i) =>
    [...row.querySelectorAll('.t, .n')].map((el) => ({ el, text: el.textContent, delay: i })));
  const CHARS = 'ABCDEFGHIJKLMNOPRSTUVWZ0123456789';
  let tick = 0;
  const id = setInterval(() => {
    tick++;
    let busy = false;
    for (const { el, text, delay } of cells) {
      if (!el.isConnected) continue;
      const shown = Math.max(0, tick - delay) * 1.5;
      if (shown < text.length) busy = true;
      el.textContent = [...text].map((ch, i) => (i < shown || ch === ' ' || ch === ':' ? ch : CHARS[Math.floor(Math.random() * CHARS.length)])).join('');
    }
    if (!busy) clearInterval(id);
  }, 45);
}

// ------------------------------------------------------------------ modals

const SHEETS = { leaving: leavingSheet, left: leftSheet, clocks: clocksSheet, missed: missedSheet, times: timesSheet, splash: splashSheet, menu: menuSheet, start: startSheet, tickets: ticketSheet, night: nightSheet, stamp: stampSheet, passport: passportSheet, end: endSheet, log: logSheet };

function renderModal() {
  const el = $('modal');
  if (!ui.modal) { el.innerHTML = ''; return; }
  // Redrawing the sheet would jump it back to the top, so keep its scroll while the same sheet stays open.
  const old = el.querySelector('.sheet'), keep = old?.classList.contains(ui.modal) ? old.scrollTop : 0;
  el.innerHTML = `<div class="sheet ${ui.modal}">${['stamp', 'night'].includes(ui.modal) ? coachHTML() : ''}${SHEETS[ui.modal]()}</div>`;
  el.querySelector('.sheet').scrollTop = keep;
}

function splashSheet() {
  const steps = [
    ['🛫', 'Read the departure board', 'You only see what leaves from where you are. Pick a departure and go; the clock jumps forward to your arrival.'],
    ['🛂', 'Collect your stamps', 'In each city on your list, go into town to get your passport stamped. It takes time, and from an airport it costs a transfer.'],
    ['🕙', 'Watch the clock', 'Nothing leaves between 22:00 and 06:00. Get caught out and you pay for a hotel. An overnight ferry or sleeper train is a bed that moves.'],
    ['💷', 'Mind the money', 'Fares change with distance, season and time of day. If you cannot pay for a room, the journey is over.'],
    ['📣', 'Expect trouble', 'Strikes, storms and closures are announced in the news strip. Plan around them, or run for a tight connection and risk the fare.'],
    ['⭐', 'Score', 'One star for getting home with every stamp, one for thrift, one for speed. Secret bonus tickets add or cost points.'],
  ].map(([icon, title, text]) => `<li><i>${icon}</i><div><b>${title}</b><span>${text}</span></div></li>`).join('');
  const buttons = g
    ? '<button class="btn big" data-act="close">Back to the journey</button>'
    : `<button class="btn big" data-act="train">Start with a guided training flight</button>
       <button class="btn ghost wide" data-act="journeys">Choose a journey</button>`;
  return `
    <h1>Viag<span>gi</span></h1>
    <div class="tagline">The Great Race</div>
    <p class="pitch">A race against the clock and your wallet. You are handed a list of cities, a deadline and a budget. Get your passport stamped in every city and make it home in time.</p>
    <h3 class="how">How to play</h3>
    <ol class="steps">${steps}</ol>
    <p class="modes"><b>✈ By air</b> covers more than 50 cities by plane, on real airline routes. <b>🚆 Rail and sail</b> is trains, sleepers and ferries only, across borders or within one country.</p>
    <p class="credit">Flight routes: which airline flies where is taken from Wikipedia’s airport pages (${EUROPE.airRoutesDate}), licensed CC BY-SA 4.0. Flight times, numbers, frequencies and all fares are generated for the game.</p>
    <div class="startbar">${buttons}</div>`;
}

const timeRows = (list, mark) => list.map((e, i) =>
  `<li class="${e === mark || (mark && e.at === mark.at) ? 'me' : ''}"><i>${i + 1}</i><b>${e.name}</b><span>${fmtDur(e.mins)}</span><small>${money(e.spent)}</small></li>`).join('');

function timesSheet() {
  const blocks = ALL_CHALLENGES.map((ch) => {
    const list = bestTimes(ch);
    return list.length ? `<h3 class="how">${ch.name}</h3><ol class="times">${timeRows(list.slice(0, 5))}</ol>` : '';
  }).join('');
  return `<h2>Best times</h2>
    <p>Fastest finishes in the no-time-limit mode, on this device.</p>
    ${blocks || '<p>No times yet. Pick “No time limit”, finish a journey and save your time.</p>'}
    <div class="row-btns"><button class="btn" data-act="journeys">Back</button></div>`;
}

function menuSheet() {
  const got = g.challenge.targets.filter((t) => g.collected.includes(t)).length;
  return `
    <h2>${g.challenge.name}</h2>
    <p>${got} of ${g.challenge.targets.length} stamps · ${clockPill(g.clock)[1]} ${g.challenge.untimed ? 'so far' : 'left'} · ${money(G.remaining(g))} left</p>
    <div class="menu-list">
      <button class="btn big" data-act="close">Keep playing</button>
      <button class="btn ghost" data-act="passport">Passport</button>
      <button class="btn ghost" data-act="log">Journey log</button>
      <button class="btn ghost" data-act="help">How to play</button>
      <button class="btn ghost" data-act="clocks">Clock style</button>
      <button class="btn ghost" data-act="sound">Travel sounds: ${sfx.on ? 'on' : 'off'}</button>
      <button class="btn ghost" data-act="quit">End this journey and see my score</button>
      <button class="btn ghost" data-act="again">Abandon and return to the start screen</button>
    </div>`;
}

function startSheet() {
  const card = (ch) => {
    const cities = ch.targets.map((id) => EUROPE.cities.find((c) => c.id === id));
    const best = ch.key && store.get(`tg-daily-${ch.key}`);
    const from = ch.home === 'LON' ? '' : `From ${EUROPE.cities.find((c) => c.id === ch.home).name}: `;
    const top = bestTimes(ch)[0];
    const limits = ui.mode === 'free'
      ? `no time limit · ${money(ch.budget)}${top ? ` · best ${fmtDur(top.mins)} (${top.name})` : ''}`
      : `${ch.hours}h · ${money(ch.budget)}${best ? ` · best ${best.points}` : ''}`;
    return `<button class="card ${ui.challenge === ch.id ? 'on' : ''}" data-act="pick" data-id="${ch.id}">
      <b>${ch.name}</b><span class="lvl">${ch.level}</span>
      <small>${ch.blurb}</small>
      <span class="meta">${ch.rail ? `${ch.rail === 'international' ? `International${ch.domestic ? ` + ${ch.domestic.map((c) => EUROPE.countryNames[c].replace('the ', '')).join(', ')}` : ''}` : `${EUROPE.countryNames[ch.rail].replace('the ', '')} only`} · ` : ''}${cities.map((c) => c.emoji).join(' ')} · ${limits}</span>
      <small>${from}${cities.map((c) => c.name).join(', ')}</small>
    </button>`;
  };
  const pack = (id) => ALL_CHALLENGES.filter((ch) => ch.pack === id).map(card).join('');
  return `
    <h2>Choose a journey</h2>
    <p><button class="link" data-act="help">How to play</button> · <button class="link" data-act="train">Guided training flight</button> · <button class="link" data-act="times">Best times</button></p>
    <div class="seg light">
      <button class="${ui.mode === 'race' ? 'on' : ''}" data-act="mode" data-id="race">⏱ Against the clock</button>
      <button class="${ui.mode === 'free' ? 'on' : ''}" data-act="mode" data-id="free">🏁 No time limit</button>
    </div>
    <p class="modehint">${ui.mode === 'free'
      ? 'No deadline. Collect every stamp and get home as fast as you can; your time goes on the leaderboard. The budget still applies.'
      : 'Beat the deadline and the budget. Stars for finishing, thrift and speed, plus bonus tickets.'}</p>
    <div class="packhead first"><b>✈ By air</b><span>Fly between more than 50 cities. Airports are out of town, so allow for transfers. Hard journeys include places with no direct flight.</span></div>
    <div class="cards">${pack('air')}</div>
    <div class="packhead"><b>🚆 Rail and sail</b><span>No flying. International journeys show cross-border trains between major cities; single-country journeys show that country’s network. Ferries offer a slower, cheaper way round from ports a short taxi ride or an easy train from the station, and an overnight sailing or a sleeper train is your bed for the night.</span></div>
    <div class="cards">${pack('rail')}</div>
    <div class="startbar"><button class="btn big" data-act="start">Start ${ALL_CHALLENGES.find((ch) => ch.id === ui.challenge).name}</button></div>`;
}

function ticketSheet() {
  const cards = g.offer.map((t, i) => `
    <button class="card ${ui.keep.includes(i) ? 'on' : ''}" data-act="keep" data-id="${i}">
      <b>${t.icon} ${t.name}</b><span class="lvl">${ui.keep.includes(i) ? 'Keeping' : 'Discarding'}</span>
      <small>${t.text}</small>
    </button>`).join('');
  return `
    <h2>Bonus tickets</h2>
    <p>You have drawn two secret tickets. Keep one or both. Each one you complete is worth ${G.RULES.ticketPoints} points; each one you keep and fail costs ${G.RULES.ticketPoints}.</p>
    <div class="cards">${cards}</div>
    <button class="btn big" data-act="depart" ${ui.keep.length ? '' : 'disabled'}>${ui.keep.length ? `Keep ${ui.keep.length === 2 ? 'both' : 'one'} and depart` : 'Keep at least one'}</button>`;
}

// The traveller slapping their forehead: drawn in the same style as the walk home.
const DOH = `
  <svg class="doh" viewBox="0 0 320 150" role="img" aria-label="A traveller slapping their forehead: Doh!">
    <rect width="320" height="150" rx="12" fill="#f6dcd2"/>
    <g class="burst"><path d="M196 18l14 12 16-10-2 18 18 6-15 10 8 17-18-3-6 18-11-15-16 9 3-18-17-7 15-9-6-17 17 4z" fill="#e2532d"/>
      <text x="212" y="57" text-anchor="middle" font-size="19" font-weight="700" fill="#fff" transform="rotate(-8 212 52)">DOH!</text></g>
    <g class="lines" stroke="#e2532d" stroke-width="3" stroke-linecap="round"><path d="M104 30l-8-9M118 24l-2-12M132 28l6-10"/></g>
    <g transform="translate(118 132)" fill="none" stroke="#1c2b3a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M-7 0L0 -30L9 0"/>
      <path d="M0 -30L0 -62"/>
      <path class="slap" d="M0 -56L18 -66L8 -84"/>
      <path d="M0 -54L-16 -36"/>
      <rect x="-27" y="-40" width="13" height="17" rx="2" fill="#7b1e2b" stroke="#1c2b3a" stroke-width="2.5" transform="rotate(-18 -20 -32)"/>
      <circle cx="0" cy="-76" r="12" fill="#fbf8f1" stroke-width="4"/>
      <path d="M-6 -78l4 2M6 -78l-3 2" stroke-width="2.4"/><path d="M-4 -69q4 -4 8 0" stroke-width="2.4"/>
      <path class="slap" d="M2 -88q8 -2 11 5" stroke-width="5"/>
    </g>
  </svg>`;

// Easy journeys and training warn before you leave a city without its stamp.
// Harder ones let you make the mistake and tell you afterwards.
const gentle = () => ['Easy', 'Guided'].includes(g.challenge.level);

function leavingSheet() {
  const c = G.here(g), plan = G.visitPlan(g), to = world.cities.get(ui.pending.to);
  return `
    <h2>Leave ${c.name} without your stamp?</h2>
    <div class="page">${stampHTML(c.id, true)}</div>
    <p>${c.name} is on your list and your passport has not been stamped here yet. If you travel on to ${to.name} now, you will have to come back to ${c.name} later to get it.</p>
    <div class="row-btns">
      <button class="btn ghost" data-act="leaveanyway">Travel on anyway</button>
      <button class="btn" data-act="visit" ${plan.why ? 'disabled' : ''}>${c.emoji} Get it stamped first${plan.why ? '' : ` · ${fmtDur(plan.mins)}`}</button>
    </div>`;
}

// Shown on arrival when the player has just left a listed city without its stamp.
function leftSheet() {
  const c = world.cities.get(ui.left), here = G.here(g);
  const back = G.board(g).filter((r) => r.leg.to === c.id && (r.bookable || r.tight)).length;
  return `
    <h2>You left ${c.name} without your stamp</h2>
    ${DOH}
    <p class="lost">Your passport was not stamped in ${c.name}. To complete the journey you will need to go back to ${c.name} and get it.</p>
    <p>You are now in ${here.name}. ${back ? `There ${back === 1 ? 'is 1 departure' : `are ${back} departures`} back to ${c.name} today.` : `Nothing goes direct to ${c.name} from here today; check the Routes tab.`}
      Next time, tap “Get passport stamped” before you travel on.</p>
    <div class="row-btns"><button class="btn" data-act="close">Understood</button></div>`;
}

// Shown when a run for a tight departure fails. A flexible ticket moves you to
// the next departure and charges any difference; a standard ticket is lost.
function missedSheet() {
  const m = ui.missed, { leg } = m.row, c = G.here(g), d = world.cities.get(leg.to);
  const what = leg.mode === 'air' ? 'flight' : leg.mode === 'rail' ? 'train' : 'ferry';
  const head = `<h2>You missed it</h2>
    <p>The doors closed on ${leg.no} to ${d.name} before you got there. You are still in ${c.name}, and it is now ${fmtTime(c.tz, g.clock)}.</p>`;
  const extras = `${m.out.premium ? `<li>Flexible supplement <span>${money(m.out.premium)} paid</span></li>` : ''}
      ${m.out.transfer ? `<li>Getting to the ${what} <span>${money(m.out.transfer)} paid</span></li>` : ''}`;

  if (m.flex && m.next) {
    const n = m.next, extra = Math.max(0, n.total - m.out.credit);
    return `${head}
      <p class="rush">Your flexible ticket has moved you to ${n.leg.no} at ${fmtTime(c.tz, n.dep)}.</p>
      <ul class="bill">
        <li>Your ticket on ${leg.no} <span>${money(m.out.credit)} carried over</span></li>
        <li>Fare on ${n.leg.no} <span>${money(n.total)}</span></li>
        <li class="sum">${extra ? 'Difference to pay' : 'Nothing more to pay'} <span class="${extra ? 'bad' : 'ok'}">${money(extra)}</span></li>
        ${extras}
      </ul>
      ${extra ? '' : n.total < m.out.credit ? '<p>The new fare is lower, but a flexible ticket does not pay back the difference.</p>' : ''}
      <div class="row-btns">
        <button class="btn ghost" data-act="refund">Cancel and take the ${money(m.out.credit)} back</button>
        <button class="btn" data-act="rebook">Board the ${fmtTime(c.tz, n.dep)} to ${d.name}</button>
      </div>`;
  }
  if (m.flex) {
    return `${head}
      <p class="rush">Nothing else you can reach goes to ${d.name} today, so your flexible fare has been refunded.</p>
      <ul class="bill"><li>Your ticket on ${leg.no} <span class="ok">${money(m.out.credit)} refunded</span></li>${extras}</ul>
      <p>Check the Routes tab for a connection, or stay the night.</p>
      <div class="row-btns"><button class="btn" data-act="close">Back to the board</button></div>`;
  }
  const next = G.board(g).filter((r) => r.leg.to === leg.to && (r.bookable || r.tight)).slice(0, 3);
  const options = next.map((r) => `<li><b>${fmtTime(c.tz, r.dep)}</b> ${r.leg.no} · ${r.leg.carrier}
      <button class="btn" data-act="go" data-id="${r.leg.id}">${r.tight ? `Run ${Math.round(r.tight.p * 100)}%` : 'Book'} ${money(r.total)}</button></li>`).join('');
  return `${head}
    <p class="lost">You did not have a flexible ticket, so the fare is lost and you need to buy a new ticket to travel on.</p>
    <ul class="bill">
      <li>Standard ticket on ${leg.no} <span class="bad">${money(leg.fare)} lost</span></li>
      ${extras}
      <li class="sum">This cost you <span>${money(m.out.lost)}</span></li>
    </ul>
    ${options ? `<p class="hint">Next to ${d.name} today</p><ul class="bill next rebook">${options}</ul>`
      : `<p><b>Nothing else goes to ${d.name} today.</b> Check the Routes tab for a connection, or stay the night.</p>`}
    <div class="row-btns"><button class="btn ghost" data-act="close">Back to the board</button></div>`;
}

function nightSheet() {
  const c = G.here(g), h = G.hotelCost(g), forced = G.isNight(g), broke = h.total > G.remaining(g);
  const where = g.place === 'airport' ? 'the airport hotel' : g.place === 'port' ? 'a hotel by the port' : byRail() ? 'a hotel by the station' : 'a city hotel';
  const want = [...G.stampCities(g).filter((t) => !g.collected.includes(t)), g.challenge.home];
  const first = G.tomorrow(g).filter((r) => r.status !== 'cancelled' && want.includes(r.leg.to)).slice(0, 3)
    .map((r) => `<li><b>${fmtTime(c.tz, r.dep)}</b> ${world.cities.get(r.leg.to).name} <span>${money(r.leg.fare)}</span></li>`).join('');
  return `
    <h2>${forced ? 'No more departures today' : `Stay the night in ${c.name}?`}</h2>
    <p>${forced ? `It is ${fmtTime(c.tz, g.clock)} in ${c.name} and nothing leaves before morning. You have been booked into ${where}.`
      : `It is only ${fmtTime(c.tz, g.clock)}. You will lose the rest of today and check into ${where}.`}</p>
    <ul class="bill">
      <li>Room <span>${money(h.room)}</span></li>
      <li>Dinner and breakfast <span>${money(h.meals)}</span></li>
      ${h.transfer ? `<li>Hotel shuttle <span>${money(h.transfer)}</span></li>` : ''}
      <li class="sum">Total <span>${money(h.total)}</span></li>
    </ul>
    ${first ? `<p class="hint">First departures to your cities tomorrow</p><ul class="bill next">${first}</ul>` : ''}
    ${broke ? `<p class="st-cancelled">You only have ${money(G.remaining(g))} left. With no room for the night, the journey ends here.</p>` : ''}
    <div class="row-btns">
      ${forced ? '' : '<button class="btn ghost" data-act="close">Not yet</button>'}
      <button class="btn" data-act="sleep">${broke ? 'End the journey' : 'Good night · wake at 06:00'}</button>
    </div>`;
}

function stampSheet() {
  const c = world.cities.get(ui.stamped);
  const left = g.challenge.targets.filter((t) => !g.collected.includes(t)).length;
  return `
    <div class="page thump">${stampHTML(c.id, true)}</div>
    <h2>${c.name}</h2>
    <p class="postcard">${POSTCARDS[c.id] || ''}</p>
    ${left ? `<p>${left} more stamp${left > 1 ? 's' : ''} to collect.</p>` : `<p class="rush">🏁 That’s the full set. Now hurry home to ${world.cities.get(g.challenge.home).name}!</p>`}
    <button class="btn big" data-act="close">Back to the journey</button>`;
}

function passportSheet() {
  return `
    <div class="booklet"><b>PASSPORT</b><span>Viaggi · ${g.challenge.name}</span></div>
    <div class="page grid" data-no="${12 + (hash(g.seed) % 20)}">${G.stampCities(g).map((id) => stampHTML(id)).join('')}</div>
    <div class="row-btns"><button class="btn" data-act="close">Close</button></div>`;
}

function logItems() {
  return g.log.map((l) => `<li><time>${fmtDay(l.tz, l.t).slice(0, 3)} ${fmtTime(l.tz, l.t)}</time><span>${l.icon}</span><span>${l.text}</span><span class="c">${l.cost < 0 ? `+${money(-l.cost)}` : l.cost ? money(l.cost) : ''}</span></li>`).join('');
}

function logSheet() {
  const items = G.news(g).map((e) => `<li class="newsitem"><span>📣</span><span>${e.text}</span></li>`).join('');
  return `<h2>Journey log</h2>
    <ul class="log">${items}${logItems() || '<li><time></time><span></span><span>Nothing yet. Pick a departure.</span></li>'}</ul>
    <div class="row-btns"><button class="btn" data-act="close">Back to the board</button></div>`;
}

function shareText(s) {
  const ch = g.challenge;
  const stars = '★'.repeat(s.stars) + '☆'.repeat(3 - s.stars);
  const route = [ch.home, ...g.path.map((p) => p.to)].map((id) => (id === ch.home ? '🏠' : world.cities.get(id).emoji)).join('');
  return [`Viaggi · ${ch.key ? `Daily ${ch.key}` : ch.name}`,
    `${stars} ${s.points} pts`, `${fmtDur(s.hours * 60)} · ${money(s.spent)} · 🎫 ${s.ticketsDone}/${s.tickets.length}`, route].join('\n');
}

// The long walk home: shown when the money runs out.
function brokeHTML() {
  const here = G.here(g), home = world.cities.get(g.challenge.home);
  const miles = Math.round(distKm(here, home) * 0.621 / 5) * 5;
  const where = here.id === home.id ? `${home.name.toUpperCase()}` : `${home.name.toUpperCase()} ${miles.toLocaleString('en-GB')} mi`;
  return `
    <svg class="walk" viewBox="0 0 320 150" role="img" aria-label="A traveller trudging home with an empty wallet">
      <defs><linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#27384d"/><stop offset="1" stop-color="#8d7f8f"/></linearGradient></defs>
      <rect width="320" height="118" fill="url(#dusk)"/>
      <circle cx="262" cy="30" r="13" fill="#f3e9c9" opacity=".9"/>
      <path d="M0 118 Q60 92 120 108 T240 100 T320 110 V118z" fill="#3b4a5c"/>
      <rect y="118" width="320" height="32" fill="#2a3038"/>
      <path class="lane" d="M-40 134H360" stroke="#d8c98f" stroke-width="3" stroke-dasharray="22 18"/>
      <g class="post"><rect x="236" y="62" width="4" height="58" fill="#6b5a45"/>
        <path d="M196 63h84l11 10-11 10h-84z" fill="#f3ede1" stroke="#1c2b3a" stroke-width="1.5"/>
        <text x="240" y="76.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="#1c2b3a" textLength="${Math.min(78, where.length * 5.2)}" lengthAdjust="spacingAndGlyphs">${where}</text></g>
      <g class="cloud"><path d="M98 34a9 9 0 0117-4 8 8 0 0113 6 7 7 0 01-2 13H100a8 8 0 01-2-15z" fill="#c9d2dc"/>
        <path class="rain" d="M104 54l-2 7M114 54l-2 7M124 54l-2 7" stroke="#9fc3e6" stroke-width="2" stroke-linecap="round"/></g>
      <g class="walker" transform="translate(116 120)" fill="none" stroke="#f3ede1" stroke-width="4" stroke-linecap="round">
        <line class="leg a" x1="0" y1="-26" x2="0" y2="0"/><line class="leg b" x1="0" y1="-26" x2="0" y2="0"/>
        <path d="M3 -54 Q-2 -40 0 -26"/>
        <line class="arm" x1="2" y1="-48" x2="-7" y2="-30"/>
        <path d="M2 -48 L12 -32"/>
        <rect x="6" y="-32" width="17" height="13" rx="2" fill="#a0522d" stroke="#f3ede1" stroke-width="2"/>
        <circle cx="6" cy="-63" r="8" fill="#f3ede1" stroke="none"/>
        <path d="M5 -59 q3 -3 6 0" stroke="#1c2b3a" stroke-width="1.6"/><circle cx="5" cy="-65" r="1.1" fill="#1c2b3a" stroke="none"/><circle cx="10" cy="-65" r="1.1" fill="#1c2b3a" stroke="none"/>
      </g>
    </svg>
    <p class="lost">You have run out of money. With ${money(Math.max(0, G.remaining(g)))} left you cannot pay for a ticket or a room, so the journey ends in ${here.name}. It is a long walk home.</p>`;
}

function freeEndSheet() {
  const s = G.score(g), ch = g.challenge, mins = Math.round(s.hours * 60);
  const list = bestTimes(ch);
  const rank = list.filter((e) => e.mins < mins || (e.mins === mins && e.spent <= s.spent)).length + 1;
  const title = s.won ? 'Home with a full passport!' : g.over === 'broke' ? 'Out of money' : 'Journey abandoned';
  const got = ch.targets.filter((t) => g.collected.includes(t)).length;
  let entry = '';
  if (s.won && ui.saved) entry = `<p class="rank">Saved. You are number ${list.findIndex((e) => e.at === ui.saved.at) + 1} on this device.</p>`;
  else if (s.won && rank <= 10) {
    entry = `<p class="rank">That is number ${rank} on this device.</p>
      <div class="namerow"><input id="who" maxlength="14" placeholder="Your name" value="${store.get('tg-name') || ''}" autocomplete="off">
      <button class="btn" data-act="savetime">Save my time</button></div>`;
  } else if (s.won) entry = '<p class="rank">Outside the top ten this time.</p>';
  return `
    <h2>${title}</h2>
    ${g.over === 'broke' ? brokeHTML() : ''}
    <p>${s.won ? `${ch.name}, no time limit.` : `${got} of ${ch.targets.length} stamps collected. No time recorded.`}</p>
    <div class="facts">
      <div><small>Time</small><b>${fmtDur(mins)}</b></div>
      <div><small>Spent</small><b>${money(s.spent)}</b></div>
      <div><small>Nights</small><b>${g.nights}</b></div>
    </div>
    ${entry}
    ${list.length ? `<h3 class="how">Best times</h3><ol class="times">${timeRows(list, ui.saved)}</ol>` : ''}
    <div class="page grid small">${G.stampCities(g).map((id) => stampHTML(id)).join('')}</div>
    <ul class="log">${logItems()}</ul>
    <div class="row-btns"><button class="btn" data-act="again">Play again</button></div>`;
}

function endSheet() {
  if (g.challenge.untimed) return freeEndSheet();
  const s = G.score(g), ch = g.challenge;
  const title = s.won && ch.training ? 'Training complete' : s.won ? 'Home with a full passport!' : g.over === 'timeout' ? 'Out of time' : g.over === 'broke' ? 'Out of money' : 'Journey abandoned';
  const got = ch.targets.filter((t) => g.collected.includes(t)).length;
  const sub = s.won && ch.training ? 'You know the board, the stamps and the clock. Real journeys add bonus tickets, strikes and storms.' : s.won ? `${ch.name} complete.` : `${got} of ${ch.targets.length} stamps collected.`;
  const star = (on) => `<span class="${on ? 'on' : ''}">★</span>`;
  const best = ch.key && store.get(`tg-daily-${ch.key}`);
  return `
    <h2>${title}</h2>${g.over === 'broke' ? brokeHTML() : ''}<p>${sub}</p>
    <div class="stars">${star(s.won)}${star(s.thrift)}${star(s.speed)}<b>${s.points}<small>points</small></b></div>
    <ul class="checks">
      <li class="${s.won ? 'on' : ''}">★ Every stamp, home inside ${ch.hours}h</li>
      <li class="${s.thrift ? 'on' : ''}">★ Spent under ${money(ch.budget * G.RULES.costStar)}</li>
      <li class="${s.speed ? 'on' : ''}">★ Home within ${ch.parHours}h</li>
      ${s.tickets.map((t) => `<li class="${t.status === 'done' ? 'on' : ''}">${t.status === 'done' ? `✓ +${G.RULES.ticketPoints}` : `✗ −${G.RULES.ticketPoints}`} 🎫 ${t.name}: ${t.text}</li>`).join('')}
    </ul>
    <div class="facts">
      <div><small>Time</small><b>${fmtDur(s.hours * 60)}</b></div>
      <div><small>Spent</small><b>${money(s.spent)}</b></div>
      <div><small>${best ? 'Today’s best' : 'Nights'}</small><b>${best ? best.points : g.nights}</b></div>
    </div>
    <div class="page grid small">${G.stampCities(g).map((id) => stampHTML(id)).join('')}</div>
    <ul class="log">${logItems()}</ul>
    <div class="row-btns">
      <button class="btn ghost" data-act="share">Copy result</button>
      <button class="btn" data-act="again">${ch.training ? 'Choose a journey' : 'Play again'}</button>
    </div>`;
}

// ------------------------------------------------------------------ flow

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 7000);
}

function afterMove(notes = [], modal = null) {
  if (G.stranded(g)) g.over = 'broke';
  if (g.over) $('toasts').innerHTML = '';
  else notes.forEach((n) => toast(n));
  const all = G.news(g);
  if (!g.over) all.slice(ui.seenNews).forEach((e) => toast(e.text, 'news'));
  ui.seenNews = all.length;
  ui.open = null; ui.peek = null; ui.routes = null; ui.busy = false; ui.flip = true;
  popup?.remove();
  // Arriving late with a stamp to collect: let the player get it before the hotel takes over.
  const stampFirst = !G.visitPlan(g).why;
  ui.modal = g.over ? 'end' : modal || (G.isNight(g) && !stampFirst ? 'night' : null);
  if (g.over && g.challenge.key && !g.challenge.untimed) {
    const s = G.score(g), k = `tg-daily-${g.challenge.key}`, old = store.get(k);
    if (!old || s.points > old.points) store.set(k, { points: s.points, stars: s.stars });
  }
  render();
  if (!g.over) { if (routeCity()) fitRoutes(); else frame(); }
}

function start() {
  const base = ALL_CHALLENGES.find((c) => c.id === ui.challenge), free = ui.mode === 'free';
  const ch = free ? { ...base, untimed: true } : base;
  world = createWorld(EUROPE, ch.modes, ch);
  showNetwork();
  // With no time limit everyone gets the same disruption, so times can be compared.
  g = G.newGame(world, ch, params.get('seed') || (free ? `free-${timesKey(ch)}` : ch.seed) || undefined);
  $('toasts').innerHTML = '';
  Object.assign(ui, { open: null, filter: 'all', peek: null, busy: false, modal: 'tickets', seenNews: 0, keep: [0], coach: null, saved: null });
  if (free) {
    afterMove([`${fmtDay(G.here(g).tz, g.clock)}, 08:00. ${ch.targets.length} stamps, ${money(ch.budget)}, no time limit. Fastest home wins.`]);
    return;
  }
  render();
  frame();
}

function startTraining() {
  world = createWorld(EUROPE, TRAINING.modes, TRAINING);
  showNetwork();
  g = G.newGame(world, TRAINING, TRAINING.seed);
  $('toasts').innerHTML = '';
  Object.assign(ui, { open: null, filter: 'all', peek: null, busy: false, seenNews: 0, keep: [], coach: { intro: true, routes: false } });
  afterMove();
}

function depart() {
  const ch = g.challenge;
  g.tickets = ui.keep.map((i) => g.offer[i]);
  afterMove([`${fmtDay(G.here(g).tz, g.clock)}, 08:00. ${ch.targets.length} stamps, ${ch.hours} hours, ${money(ch.budget)}. Go!`]);
}

async function go(legId, flex = false, credit = 0, confirmed = false) {
  const row = G.board(g).find((r) => r.leg.id === legId);
  if (!row || !(row.bookable || row.tight) || ui.busy) return;
  if (gentle() && !confirmed && G.stampCities(g).includes(g.city) && !g.collected.includes(g.city)) {
    ui.pending = { legId, flex, credit, to: row.leg.to };
    ui.modal = 'leaving';
    popup?.remove();
    render();
    return;
  }
  popup?.remove();
  ui.routes = null;
  sfx.unlock();
  ui.modal = null;
  if (!G.runSucceeds(g, row)) {
    const out = G.book(g, row, { flex });
    // Flexible: line up the next departure you can comfortably make; if there is none, refund.
    const next = flex ? G.board(g).find((r) => r.leg.to === row.leg.to && r.bookable && r.total - out.credit <= G.remaining(g)) : null;
    if (flex && !next) G.refund(g, out.credit);
    ui.missed = { row, flex, out, next };
    afterMove([], 'missed');
    return;
  }
  const from = G.here(g), to = world.cities.get(row.divertTo ?? row.leg.to);
  ui.busy = true; ui.open = row.leg.to;
  render();
  map.fitBounds(new maplibregl.LngLatBounds([from.lon, from.lat], [from.lon, from.lat]).extend([to.lon, to.lat]),
    { padding: 90, maxZoom: 6, duration: 500 });
  await travel(from, to, row);
  const out = G.book(g, row, { flex, credit });
  ui.left = out.skipped;
  afterMove(out.notes, out.skipped && !gentle() ? 'left' : null);
}

const actions = {
  pick: (id) => { ui.challenge = id; },
  start,
  keep: (i) => { i = +i; ui.keep = ui.keep.includes(i) ? ui.keep.filter((x) => x !== i) : [...ui.keep, i].sort(); },
  depart,
  again: () => { g = null; ui.modal = 'start'; popup?.remove(); $('toasts').innerHTML = ''; },
  open: (id) => { ui.open = ui.open === id ? null : id; },
  filter: (id) => { ui.filter = id; ui.open = null; ui.routes = null; ui.flip = true; popup?.remove(); if (id === 'routes' && ui.coach) ui.coach.routes = true; },
  routesfrom: (id) => { popup?.remove(); ui.filter = 'routes'; ui.open = null; ui.flip = true; ui.routes = id === g.city ? null : id; },
  train: startTraining,
  clocks: () => { ui.modal = 'clocks'; },
  clockstyle: (id) => { store.set('tg-clock', id); },
  noroutes: () => { ui.routes = null; ui.filter = 'all'; ui.flip = true; },
  sound: () => sfx.toggle(),
  mode: (id) => { ui.mode = id; },
  times: () => { ui.modal = 'times'; },
  savetime: () => {
    const name = ($('who').value.trim() || 'Traveller').replace(/[<>&]/g, '').slice(0, 14), s = G.score(g);
    store.set('tg-name', name);
    ui.saved = { name, mins: Math.round(s.hours * 60), spent: s.spent, at: Date.now() };
    addTime(g.challenge, ui.saved);
  },
  journeys: () => { ui.modal = 'start'; },
  help: () => { ui.modal = 'splash'; },
  coachnext: () => { ui.coach.intro = false; },
  go: (id) => go(id),
  goflex: (id) => go(id, true),
  leaveanyway: () => go(ui.pending.legId, ui.pending.flex, ui.pending.credit, true),
  rebook: () => go(ui.missed.next.leg.id, false, ui.missed.out.credit),
  refund: () => { G.refund(g, ui.missed.out.credit); ui.modal = G.isNight(g) && G.visitPlan(g).why ? 'night' : null; },
  visit: () => {
    ui.stamped = g.city;
    afterMove(G.visit(g), 'stamp');
  },
  night: () => { ui.modal = 'night'; },
  sleep: () => { const c = G.here(g); G.sleep(g); afterMove([`Good morning from ${c.name}. It is 06:00.`]); },
  peek: (id) => { if (G.usePeek(g, id)) { ui.peek = id; ui.pinned = id; ui.open = null; ui.flip = true; popup?.remove(); } },
  unpeek: () => { ui.peek = null; ui.open = null; ui.flip = true; },
  passport: () => { ui.modal = 'passport'; },
  log: () => { ui.modal = 'log'; },
  close: () => { ui.modal = ['stamp', 'missed', 'left'].includes(ui.modal) && G.isNight(g) && G.visitPlan(g).why ? 'night' : null; },
  menu: () => { popup?.remove(); ui.modal = 'menu'; },
  quit: () => { g.over = 'quit'; ui.modal = 'end'; $('toasts').innerHTML = ''; },
  share: async (_, el) => {
    try { await navigator.clipboard.writeText(shareText(G.score(g))); el.textContent = 'Copied ✓'; }
    catch { el.textContent = 'Copy not allowed here'; }
  },
};

const SELF_RENDERING = ['start', 'train', 'depart', 'go', 'goflex', 'rebook', 'leaveanyway', 'visit', 'sleep', 'share'];

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  await actions[act](el.dataset.id, el);
  if (!SELF_RENDERING.includes(act)) render();
  if (['filter', 'routesfrom', 'noroutes'].includes(act) && g && !g.over) { if (routeCity()) fitRoutes(); else frame(); }
  if (act === 'open') scrollToOpen();
});

initMap();
render();
if (params.has('debug')) window.tg = { get g() { return g; }, get map() { return map; }, G, ui, render, sfx };
