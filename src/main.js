// Web prototype UI: map on one side, departure board on the other.
/* global maplibregl */

import { EUROPE } from './data/europe.js';
import { CHALLENGES, dailyChallenge } from './data/challenges.js';
import { POSTCARDS } from './data/postcards.js';
import { createWorld, MODES } from './engine/world.js';
import * as G from './engine/game.js';
import { legStatus } from './engine/events.js';
import { routeOptions } from './engine/planner.js';
import { arc, hash, local, fmtTime, fmtDay, fmtDur, MIN } from './engine/util.js';

// Swap for a Mapbox style URL + access token when moving to the Mapbox SDK.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const $ = (id) => document.getElementById(id);
const money = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;
const params = new URLSearchParams(location.search);
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const ALL_CHALLENGES = [dailyChallenge(createWorld(EUROPE)), ...CHALLENGES];

let world, g, map, popup;
const pins = new Map();
const ui = { open: null, filter: 'all', peek: null, busy: false, modal: 'start', challenge: ALL_CHALLENGES[0].id,
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
    el.innerHTML = `<i>${c.emoji}</i><span>${c.name}</span>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); pinClick(c.id); });
    pins.set(c.id, { el, marker: new maplibregl.Marker({ element: el }).setLngLat([c.lon, c.lat]).addTo(map) });
  }
}

// How dark it is at a local time: 0 by day, 1 at night, with dawn and dusk between.
function darkness(tz, ms) {
  const m = local(tz, ms).minutes;
  if (m < 300 || m >= 1260) return 1;
  if (m < 420) return 1 - (m - 300) / 120;
  if (m >= 1080) return (m - 1080) / 180;
  return 0;
}

function shade(tz, ms) {
  const d = darkness(tz, ms);
  if (map.getLayer('night')) map.setPaintProperty('night', 'background-opacity', d * 0.55);
  $('stage').classList.toggle('dark', d > 0.5);
}

const byRail = () => !world.modes.includes('air');

// In a rail game, draw the rail map so the player can see where the tracks go.
function showNetwork() {
  if (!world || !map.getSource('network')) return;
  const features = [...world.services.values()].flat().filter((s) => s.mode !== 'air' && s.from < s.to)
    .map((s) => line(world.cities.get(s.from), world.cities.get(s.to), s.mode));
  map.getSource('network').setData({ type: 'FeatureCollection', features });
}

const line = (a, b, mode) => ({ type: 'Feature', properties: { mode }, geometry: { type: 'LineString', coordinates: arc(a, b) } });

function renderMap() {
  if (!g) return;
  const reach = new Set(G.board(g).filter((r) => r.bookable).map((r) => r.leg.to));
  const wanted = G.stampCities(g);
  for (const [id, { el }] of pins) {
    const cls = ['pin'];
    if (!world.services.get(id).length) cls.push('off');
    if (id === g.challenge.home) cls.push('home');
    if (wanted.includes(id)) cls.push('target');
    if (g.collected.includes(id)) cls.push('done');
    if (id === g.city) cls.push('here');
    if (reach.has(id)) cls.push('reach');
    if (id === ui.open) cls.push('open');
    el.className = cls.join(' ');
    el.firstChild.textContent = id === g.challenge.home ? '🏠' : world.cities.get(id).emoji;
  }
  if (!map.getSource('path')) return;
  const city = (id) => world.cities.get(id);
  shade(G.here(g).tz, g.clock);
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
      if (left) left.textContent = fmtDur((g.deadline - clock) / MIN);
      if (ms < dur) requestAnimationFrame(step); else end();
    };
    requestAnimationFrame(step);
    setTimeout(end, dur + 500);     // rAF is paused in background tabs
  });
}

function pinClick(id) {
  if (!g || g.over || ui.busy || ui.modal) return;
  const c = world.cities.get(id);
  const onList = G.stampCities(g).includes(id);
  const cost = c.idx >= 1.3 ? 'Expensive' : c.idx >= 0.9 ? 'Mid-priced' : 'Cheap';
  const status = id === g.city ? 'You are here.'
    : onList ? (g.collected.includes(id) ? 'Passport stamped.' : 'On your list: stamp needed.')
    : id === g.challenge.home ? 'Home. Finish here.' : 'Not on your list.';
  const peek = id === g.city ? ''
    : `<button class="btn" data-act="peek" data-id="${id}" ${g.lookups ? '' : 'disabled'}>Look up departures (${g.lookups} left today)</button>`;
  popup?.remove();
  popup = new maplibregl.Popup({ offset: 16, closeButton: false, maxWidth: '260px' })
    .setLngLat([c.lon, c.lat])
    .setHTML(`<h3>${c.emoji} ${c.name}</h3><p>${status}<br>${cost} city · ${byRail() ? 'station in the centre' : `${c.xfer} min from ${c.apt} to the centre`}</p>${peek}`)
    .addTo(map);
  if (!ui.peek && id !== g.city) { ui.open = id; ui.filter = 'all'; render(); scrollToOpen(); }
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

const TICKS = Array.from({ length: 12 }, (_, i) =>
  `<line x1="50" y1="${i % 3 ? 9 : 7}" x2="50" y2="${i % 3 ? 13 : 16}" transform="rotate(${i * 30} 50 50)"/>`).join('');

const clockHTML = () => `<div class="clock" id="clock"><svg viewBox="0 0 100 100" role="img">
  <circle class="face" cx="50" cy="50" r="47"/><g class="ticks">${TICKS}</g>
  <line class="hour" x1="50" y1="54" x2="50" y2="27"/><line class="minute" x1="50" y1="56" x2="50" y2="13"/>
  <circle class="hub" cx="50" cy="50" r="3.5"/></svg><b></b><small></small></div>`;

// Point the hands at a local time. The face turns dark at night, since an
// analogue dial cannot tell 8 in the morning from 8 in the evening.
function setClock(tz, ms) {
  const el = $('clock');
  if (!el) return;
  const p = local(tz, ms);
  el.querySelector('.hour').setAttribute('transform', `rotate(${(p.minutes / 2) % 360} 50 50)`);
  el.querySelector('.minute').setAttribute('transform', `rotate(${p.min * 6} 50 50)`);
  el.classList.toggle('night', darkness(tz, ms) > 0.5);
  el.querySelector('svg').setAttribute('aria-label', `${fmtTime(tz, ms)} local time`);
  el.querySelector('b').textContent = fmtTime(tz, ms);
  el.querySelector('small').textContent = p.h < 12 ? 'morning' : p.h < 18 ? 'afternoon' : p.h < 22 ? 'evening' : 'night';
}

// ------------------------------------------------------------------ passport

const INKS = ['#b4322a', '#1f5fa8', '#1f7a5c', '#6a3d9a'];

function stampHTML(id, big = false) {
  const c = world.cities.get(id), t = g.stampAt[id];
  if (!t) return `<div class="ink blank ${big ? 'big' : ''}"><i>${c.emoji}</i><small>${c.name}</small></div>`;
  const p = local(c.tz, t), h = hash(`ink|${id}`);
  const date = `${String(p.d).padStart(2, '0')}·${String(p.m).padStart(2, '0')}·${p.y}`;
  return `<div class="ink ${big ? 'big' : ''}" style="--ink:${INKS[h % 4]};--r:${(h % 25) - 12}deg">
    <small>${c.name}</small><i>${c.emoji}</i><small>${date} · ${c.country}</small></div>`;
}

// ------------------------------------------------------------------ panel

function render() {
  $('app').classList.toggle('busy', ui.busy);
  renderModal();
  if (!g) { $('panel').innerHTML = ''; $('hud').innerHTML = ''; return; }
  renderHud();
  renderPanel();
  renderMap();
  if (ui.flip) { ui.flip = false; flipBoard(); }
}

function renderHud() {
  const left = (g.deadline - g.clock) / MIN, cash = G.remaining(g);
  const got = g.challenge.targets.filter((t) => g.collected.includes(t)).length;
  const pill = (label, value, warn) => `<div class="pill ${warn ? 'warn' : ''}"><small>${label}</small><b>${value}</b></div>`;
  $('hud').innerHTML =
    pill('Time left', fmtDur(left), left < 8 * 60) +
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
    return `<div class="slot ${g.collected.includes(id) ? 'done' : ''}"><i>${t.emoji}</i>${t.name}</div>`;
  }).join('');
  const tickets = G.tickets(g).map((t) =>
    `<span class="tkt ${t.status}" title="${t.text}">${t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '🎫'} ${t.name}</span>`).join('');

  // Rebuilding the panel resets its scroll, so carry the position over unless the board itself is new.
  const keep = ui.flip ? null : { rows: document.querySelector('.rows')?.scrollTop, panel: $('panel').scrollTop };
  $('panel').innerHTML = `
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
      <button class="act primary" data-act="visit" ${plan.why ? 'disabled' : ''}>
        <b>${c.emoji} Get passport stamped</b>
        <small>${plan.why || `${fmtDur(plan.mins)} · ${money(plan.cost)}${plan.transfer ? ' incl. transfer' : plan.shuttle ? ' · free shuttle into town' : ''}`}</small>
      </button>
      <button class="act" data-act="night">
        <b>🛏 Stay the night</b>
        <small>Hotel ${money(G.hotelCost(g).total)} · wake at 06:00</small>
      </button>
    </div>
    ${renderBoard()}
    <div class="foot"><button data-act="log">Journey log</button><button data-act="menu">End journey</button></div>`;
  setClock(tz, g.clock);
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
      : lead.tight && !ui.peek && !later ? '<span class="st-delayed">RUN FOR IT</span> · ' : '';
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
    ? `<button class="back" data-act="unpeek">← Back to ${G.here(g).name}</button><h2>${c.name}</h2>`
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
    return `<div class="rt-city"><h3>${d.emoji} ${d.name}</h3>${cards}</div>`;
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
  if (leg.mode === 'ferry') notes.push(`${leg.port} to ${leg.portTo}`);
  if (!readOnly && r.lead.shuttle) notes.push(`free shuttle ${fmtDur(r.lead.shuttle)}`);
  if (leg.berth) notes.push(`${leg.sleeper ? 'sleeper: ' : ''}berth included, no hotel`);
  if (leg.seats) notes.push(`${leg.seats} seat${leg.seats > 1 ? 's' : ''} left`);
  if (!readOnly && r.tight) notes.push(`<span class="st-delayed">${Math.round(r.tight.p * 100)}% chance you make it</span>`);
  else if (!readOnly && r.why === 'late') notes.push(`Needs ${fmtDur(r.lead.min)} to make it`);
  if (!readOnly && r.why === 'funds') notes.push('Over budget');
  let btn = `<b>${money(leg.fare)}</b>`;
  if (!readOnly && r.tight) {
    btn = `<span class="pair">
      <button class="go run" data-act="go" data-id="${leg.id}" title="Miss it and the fare is lost">Run ${money(r.total)}</button>
      <button class="go flex" data-act="goflex" data-id="${leg.id}" title="Miss it and the fare is refunded" ${r.flexTotal > G.remaining(g) ? 'disabled' : ''}>Flex ${money(r.flexTotal)}</button></span>`;
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

const SHEETS = { menu: menuSheet, start: startSheet, tickets: ticketSheet, night: nightSheet, stamp: stampSheet, passport: passportSheet, end: endSheet, log: logSheet };

function renderModal() {
  const el = $('modal');
  if (!ui.modal) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="sheet ${ui.modal}">${SHEETS[ui.modal]()}</div>`;
}

function menuSheet() {
  const got = g.challenge.targets.filter((t) => g.collected.includes(t)).length;
  return `
    <h2>${g.challenge.name}</h2>
    <p>${got} of ${g.challenge.targets.length} stamps · ${fmtDur((g.deadline - g.clock) / MIN)} left · ${money(G.remaining(g))} left</p>
    <div class="menu-list">
      <button class="btn big" data-act="close">Keep playing</button>
      <button class="btn ghost" data-act="passport">Passport</button>
      <button class="btn ghost" data-act="log">Journey log</button>
      <button class="btn ghost" data-act="quit">End this journey and see my score</button>
      <button class="btn ghost" data-act="again">Abandon and return to the start screen</button>
    </div>`;
}

function startSheet() {
  const card = (ch) => {
    const cities = ch.targets.map((id) => EUROPE.cities.find((c) => c.id === id));
    const best = ch.key && store.get(`tg-daily-${ch.key}`);
    const from = ch.home === 'LON' ? '' : `From ${EUROPE.cities.find((c) => c.id === ch.home).name}: `;
    return `<button class="card ${ui.challenge === ch.id ? 'on' : ''}" data-act="pick" data-id="${ch.id}">
      <b>${ch.name}</b><span class="lvl">${ch.level}</span>
      <small>${ch.blurb}</small>
      <span class="meta">${ch.rail ? `${ch.rail === 'international' ? `International${ch.domestic ? ` + ${ch.domestic.map((c) => EUROPE.countryNames[c].replace('the ', '')).join(', ')}` : ''}` : `${EUROPE.countryNames[ch.rail].replace('the ', '')} only`} · ` : ''}${cities.map((c) => c.emoji).join(' ')} · ${ch.hours}h · ${money(ch.budget)}${best ? ` · best ${best.points}` : ''}</span>
      <small>${from}${cities.map((c) => c.name).join(', ')}</small>
    </button>`;
  };
  const pack = (id) => ALL_CHALLENGES.filter((ch) => ch.pack === id).map(card).join('');
  return `
    <h1>Viag<span>gi</span></h1>
    <div class="tagline">The Great Race</div>
    <p>Race round Europe on a realistic transport network. Get your passport stamped in every city on your list and be home before the clock and the money run out.</p>
    <div class="packhead first"><b>✈ By air</b><span>Fly between 45 cities. Airports are out of town, so allow for transfers.</span></div>
    <div class="cards">${pack('air')}</div>
    <div class="packhead"><b>🚆 Rail and sail</b><span>No flying. International journeys show cross-border trains between major cities; single-country journeys show that country’s network. Ferries offer a slower, cheaper way round: a free shuttle links each port with the station, and an overnight sailing or a sleeper train is your bed for the night.</span></div>
    <div class="cards">${pack('rail')}</div>
    <button class="btn big" data-act="start">Start the journey</button>`;
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
    <p>${left ? `${left} more stamp${left > 1 ? 's' : ''} to collect.` : `That’s the full set. Now get home to ${world.cities.get(g.challenge.home).name}.`}</p>
    <button class="btn big" data-act="close">Back to the journey</button>`;
}

function passportSheet() {
  return `
    <div class="booklet"><b>PASSPORT</b><span>Viaggi · ${g.challenge.name}</span></div>
    <div class="page grid">${G.stampCities(g).map((id) => stampHTML(id)).join('')}</div>
    <div class="row-btns"><button class="btn" data-act="close">Close</button></div>`;
}

function logItems() {
  return g.log.map((l) => `<li><time>${fmtDay(l.tz, l.t).slice(0, 3)} ${fmtTime(l.tz, l.t)}</time><span>${l.icon}</span><span>${l.text}</span><span class="c">${l.cost ? money(l.cost) : ''}</span></li>`).join('');
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

function endSheet() {
  const s = G.score(g), ch = g.challenge;
  const title = s.won ? 'Home with a full passport!' : g.over === 'timeout' ? 'Out of time' : g.over === 'broke' ? 'Out of money' : 'Journey abandoned';
  const got = ch.targets.filter((t) => g.collected.includes(t)).length;
  const sub = s.won ? `${ch.name} complete.` : `${g.over === 'broke' ? 'You could not pay for a hotel room. ' : ''}${got} of ${ch.targets.length} stamps collected.`;
  const star = (on) => `<span class="${on ? 'on' : ''}">★</span>`;
  const best = ch.key && store.get(`tg-daily-${ch.key}`);
  return `
    <h2>${title}</h2><p>${sub}</p>
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
      <button class="btn" data-act="again">Play again</button>
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
  if (g.over) $('toasts').innerHTML = '';
  else notes.forEach((n) => toast(n));
  const all = G.news(g);
  if (!g.over) all.slice(ui.seenNews).forEach((e) => toast(e.text, 'news'));
  ui.seenNews = all.length;
  ui.open = null; ui.peek = null; ui.busy = false; ui.flip = true;
  popup?.remove();
  ui.modal = g.over ? 'end' : modal || (G.isNight(g) ? 'night' : null);
  if (g.over && g.challenge.key) {
    const s = G.score(g), k = `tg-daily-${g.challenge.key}`, old = store.get(k);
    if (!old || s.points > old.points) store.set(k, { points: s.points, stars: s.stars });
  }
  render();
  if (!g.over) frame();
}

function start() {
  const ch = ALL_CHALLENGES.find((c) => c.id === ui.challenge);
  world = createWorld(EUROPE, ch.modes, ch);
  showNetwork();
  g = G.newGame(world, ch, params.get('seed') || ch.seed || undefined);
  $('toasts').innerHTML = '';
  Object.assign(ui, { open: null, filter: 'all', peek: null, busy: false, modal: 'tickets', seenNews: 0, keep: [0] });
  render();
  frame();
}

function depart() {
  const ch = g.challenge;
  g.tickets = ui.keep.map((i) => g.offer[i]);
  afterMove([`${fmtDay(G.here(g).tz, g.clock)}, 08:00. ${ch.targets.length} stamps, ${ch.hours} hours, ${money(ch.budget)}. Go!`]);
}

async function go(legId, flex = false) {
  const row = G.board(g).find((r) => r.leg.id === legId);
  if (!row || !(row.bookable || row.tight) || ui.busy) return;
  popup?.remove();
  if (!G.runSucceeds(g, row)) { afterMove(G.book(g, row, { flex }).notes); return; }
  const from = G.here(g), to = world.cities.get(row.divertTo ?? row.leg.to);
  ui.busy = true; ui.open = row.leg.to;
  render();
  map.fitBounds(new maplibregl.LngLatBounds([from.lon, from.lat], [from.lon, from.lat]).extend([to.lon, to.lat]),
    { padding: 90, maxZoom: 6, duration: 500 });
  await travel(from, to, row);
  afterMove(G.book(g, row, { flex }).notes);
}

const actions = {
  pick: (id) => { ui.challenge = id; },
  start,
  keep: (i) => { i = +i; ui.keep = ui.keep.includes(i) ? ui.keep.filter((x) => x !== i) : [...ui.keep, i].sort(); },
  depart,
  again: () => { g = null; ui.modal = 'start'; popup?.remove(); $('toasts').innerHTML = ''; },
  open: (id) => { ui.open = ui.open === id ? null : id; },
  filter: (id) => { ui.filter = id; ui.open = null; ui.flip = true; },
  go: (id) => go(id),
  goflex: (id) => go(id, true),
  visit: () => {
    ui.stamped = g.city;
    afterMove(G.visit(g), 'stamp');
  },
  night: () => { ui.modal = 'night'; },
  sleep: () => { const c = G.here(g); G.sleep(g); afterMove([`Good morning from ${c.name}. It is 06:00.`]); },
  peek: (id) => { if (G.usePeek(g)) { ui.peek = id; ui.open = null; ui.flip = true; popup?.remove(); } },
  unpeek: () => { ui.peek = null; ui.open = null; ui.flip = true; },
  passport: () => { ui.modal = 'passport'; },
  log: () => { ui.modal = 'log'; },
  close: () => { ui.modal = ui.modal === 'stamp' && G.isNight(g) ? 'night' : null; },
  menu: () => { popup?.remove(); ui.modal = 'menu'; },
  quit: () => { g.over = 'quit'; ui.modal = 'end'; $('toasts').innerHTML = ''; },
  share: async (_, el) => {
    try { await navigator.clipboard.writeText(shareText(G.score(g))); el.textContent = 'Copied ✓'; }
    catch { el.textContent = 'Copy not allowed here'; }
  },
};

const SELF_RENDERING = ['start', 'depart', 'go', 'goflex', 'visit', 'sleep', 'share'];

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  await actions[act](el.dataset.id, el);
  if (!SELF_RENDERING.includes(act)) render();
  if (act === 'open') scrollToOpen();
});

initMap();
render();
if (params.has('debug')) window.tg = { get g() { return g; }, get map() { return map; }, G, ui, render };
