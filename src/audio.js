// Background music, generated in the browser with Web Audio.
// Every city gets its own eight-bar tune, composed from the city's id in the
// musical style of its country (scale, metre, tempo, instrument). Nothing is
// downloaded, so there is nothing to license. Swap `play()` for recorded
// tracks later without touching the rest of the game.

import { rand } from './engine/util.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], DORIAN = [0, 2, 3, 5, 7, 9, 10];
const HARMONIC = [0, 2, 3, 5, 7, 8, 11], PHRYGIAN_DOM = [0, 1, 4, 5, 7, 8, 10], PENTA = [0, 2, 4, 7, 9];

// steps = eighth notes per bar; accents = steps that carry the accompaniment
const STYLES = {
  british:  { root: 62, scale: PENTA,        bpm: 96,  steps: 8, accents: [0, 4],       voice: 'pluck', density: 0.5 },
  celtic:   { root: 62, scale: DORIAN,       bpm: 116, steps: 6, accents: [0, 3],       voice: 'pluck', density: 0.85 },   // jig
  french:   { root: 60, scale: MAJOR,        bpm: 138, steps: 6, accents: [0, 2, 4],    voice: 'reed',  density: 0.45 },   // musette waltz
  lowland:  { root: 65, scale: MAJOR,        bpm: 92,  steps: 8, accents: [0, 4],       voice: 'bell',  density: 0.4 },
  german:   { root: 67, scale: MAJOR,        bpm: 108, steps: 4, accents: [0, 2],       voice: 'reed',  density: 0.6 },    // polka
  alpine:   { root: 60, scale: MAJOR,        bpm: 120, steps: 6, accents: [0, 2, 4],    voice: 'reed',  density: 0.5 },    // ländler
  iberian:  { root: 64, scale: PHRYGIAN_DOM, bpm: 104, steps: 6, accents: [0, 3, 4],    voice: 'pluck', density: 0.7 },
  fado:     { root: 62, scale: MINOR,        bpm: 84,  steps: 8, accents: [0, 3, 6],    voice: 'pluck', density: 0.55 },
  italian:  { root: 57, scale: HARMONIC,     bpm: 144, steps: 6, accents: [0, 3],       voice: 'pluck', density: 0.9 },    // tarantella
  nordic:   { root: 62, scale: DORIAN,       bpm: 66,  steps: 6, accents: [0],          voice: 'pad',   density: 0.35 },
  baltic:   { root: 64, scale: MINOR,        bpm: 76,  steps: 8, accents: [0, 4],       voice: 'bell',  density: 0.4 },
  slavic:   { root: 62, scale: HARMONIC,     bpm: 118, steps: 4, accents: [0, 2],       voice: 'reed',  density: 0.65 },
  balkan:   { root: 62, scale: PHRYGIAN_DOM, bpm: 150, steps: 7, accents: [0, 3, 5],    voice: 'reed',  density: 0.75 },   // 7/8
  greek:    { root: 62, scale: HARMONIC,     bpm: 126, steps: 7, accents: [0, 3, 5],    voice: 'pluck', density: 0.8 },    // kalamatianos
  turkish:  { root: 62, scale: PHRYGIAN_DOM, bpm: 100, steps: 8, accents: [0, 3, 6],    voice: 'pluck', density: 0.65 },
};

const BY_COUNTRY = {
  GB: 'british', IE: 'celtic', FR: 'french', NL: 'lowland', BE: 'lowland', LU: 'lowland', DE: 'german',
  CH: 'alpine', AT: 'alpine', SI: 'alpine', ES: 'iberian', PT: 'fado', IT: 'italian', MT: 'italian',
  DK: 'nordic', SE: 'nordic', NO: 'nordic', FI: 'nordic', IS: 'nordic', EE: 'baltic', LV: 'baltic', LT: 'baltic',
  PL: 'slavic', CZ: 'slavic', HU: 'slavic', RO: 'balkan', BG: 'balkan', RS: 'balkan', HR: 'balkan',
  GR: 'greek', TR: 'turkish',
};
const OVERRIDE = { EDI: 'celtic' };

const BARS = 8, VOLUME = 0.2;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

let ctx, master, wet, timer, tune = null, step = 0, nextTime = 0;
let muted = false;
try { muted = localStorage.getItem('tg-muted') === '1'; } catch { /* private mode */ }

function compose(city) {
  const style = STYLES[OVERRIDE[city.id] || BY_COUNTRY[city.country] || 'british'];
  const { scale, steps } = style, top = scale.length * 2;
  const melody = [];
  let deg = scale.length;
  for (let i = 0; i < steps * BARS; i++) {
    const accent = style.accents.includes(i % steps);
    const r = rand(`tune|${city.id}|${i}`);
    if (r > (accent ? 0.92 : style.density)) { melody.push(null); continue; }
    deg += [-2, -1, -1, 0, 1, 1, 2][Math.floor(rand(`walk|${city.id}|${i}`) * 7)];
    deg = Math.max(0, Math.min(top, deg));
    if (i >= steps * (BARS - 1) + style.accents.at(-1)) deg = scale.length;      // come home at the end
    melody.push(style.root + 12 * Math.floor(deg / scale.length) + scale[deg % scale.length]);
  }
  return { style, melody, stepDur: 30 / style.bpm };
}

function note(midi, t, dur, voice, vol) {
  const g = ctx.createGain(), f = hz(midi);
  const osc = (type, freq) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.connect(g); o.start(t); return o; };
  let oscs, end;
  if (voice === 'reed') {                // accordion: two detuned saws, held
    oscs = [osc('sawtooth', f * 1.004), osc('sawtooth', f * 0.996)];
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * 0.45, t + 0.03);
    g.gain.setValueAtTime(vol * 0.45, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, end = t + dur);
  } else if (voice === 'pad') {
    oscs = [osc('sine', f), osc('triangle', f * 2)];
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * 0.6, t + dur * 0.5);
    g.gain.linearRampToValueAtTime(0, end = t + dur * 3);
  } else {                               // pluck / bell: struck, ringing off
    oscs = voice === 'bell' ? [osc('sine', f), osc('sine', f * 3)] : [osc('triangle', f), osc('sine', f * 2)];
    const ring = voice === 'bell' ? 1.2 : 0.45;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, end = t + ring);
  }
  g.connect(master); g.connect(wet);
  oscs.forEach((o) => o.stop(end + 0.05));
}

function schedule() {
  if (!tune || ctx.state !== 'running') return;
  if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.05;
  while (nextTime < ctx.currentTime + 0.25) {
    const { style, melody, stepDur } = tune;
    const inBar = step % style.steps, bar = Math.floor(step / style.steps) % BARS;
    const bass = style.root - 24 + (bar === 3 || bar === 6 ? 7 : 0);
    if (inBar === 0) note(bass, nextTime, stepDur * 2, 'pluck', 0.9);
    else if (style.accents.includes(inBar)) {
      note(bass + 12 + 7, nextTime, stepDur, 'pluck', 0.22);
      note(bass + 24 + style.scale[2 % style.scale.length], nextTime, stepDur, 'pluck', 0.18);
    }
    const m = melody[step % melody.length];
    if (m != null) note(m, nextTime, stepDur * 1.6, style.voice, 0.55);
    step++;
    nextTime += stepDur;
  }
}

function init() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass'; tone.frequency.value = 2600;
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(tone).connect(ctx.destination);
  // a little echo for space
  const delay = ctx.createDelay(), fb = ctx.createGain();
  wet = ctx.createGain();
  delay.delayTime.value = 0.31; fb.gain.value = 0.28; wet.gain.value = 0.22;
  wet.connect(delay); delay.connect(fb).connect(delay); delay.connect(master);
  timer = setInterval(schedule, 60);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) ctx.suspend(); else if (!muted && tune) ctx.resume();
  });
}

const fade = (to, secs) => {
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
  master.gain.linearRampToValueAtTime(to, ctx.currentTime + secs);
};

export const music = {
  get muted() { return muted; },
  get playing() { return tune?.city ?? null; },

  // Call from a click: browsers only allow audio to start on a user gesture.
  play(city) {
    if (!ctx) init();
    if (!muted) ctx.resume();
    if (tune?.city === city.id) return;
    const next = { ...compose(city), city: city.id };
    const swap = () => { tune = next; step = 0; nextTime = 0; if (!muted) fade(VOLUME, 0.8); };
    if (tune) { fade(0, 0.5); setTimeout(swap, 550); } else swap();
  },

  stop() {
    if (!ctx) return;
    fade(0, 0.5);
    setTimeout(() => { tune = null; }, 550);
  },

  toggle() {
    muted = !muted;
    try { localStorage.setItem('tg-muted', muted ? '1' : '0'); } catch { /* private mode */ }
    if (!ctx) return;
    if (muted) { fade(0, 0.2); setTimeout(() => muted && ctx.suspend(), 250); }
    else { ctx.resume(); if (tune) fade(VOLUME, 0.4); }
  },
};
