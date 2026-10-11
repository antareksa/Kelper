// Shipping Mode announces the expedition when a parcel is confirmed picked up
// (client-requested 2026-10-12), so the operator hears where it goes without
// looking at the screen.
//
// The client provides the recordings: one sound file per expedition in
// kelper-frontend/public/sounds/ (see the README there for the exact names, e.g.
// jnt.mp3, jne.mp3, spx.mp3). An instant order plays instant.* first. If any file
// the announcement needs is missing, the whole thing is spoken with the PC's own
// voice instead, so a missing file never means silence.

// [pattern for Shopee's free-text carrier ("SPX Express", "J&T Economy", ...),
//  file name without extension, text for the voice fallback]
const RULES = [
  [/spx|shopee\s*x?press/i, 'spx', 'S P X'],
  [/j\s*&\s*t|\bjnt\b|j\s*and\s*t/i, 'jnt', 'J and T'],
  [/\bjne\b/i, 'jne', 'J N E'],
  [/si\s*cepat/i, 'sicepat', 'Si Cepat'],
  [/anter\s*aja/i, 'anteraja', 'Anter Aja'],
  [/ninja/i, 'ninja', 'Ninja'],
  [/\bid\s*express\b|idexpress/i, 'idexpress', 'I D Express'],
  [/lion/i, 'lion', 'Lion Parcel'],
  [/\bpos\b/i, 'pos', 'Pos Indonesia'],
  [/tiki/i, 'tiki', 'Tiki'],
  [/wahana/i, 'wahana', 'Wahana'],
];

// Besides the expedition files: 'instant' and 'unknown', and the station's own
// event sounds (start_packing: every item of an order is scanned, time to pack).
export const SOUND_KEYS = [...RULES.map((r) => r[1]), 'instant', 'unknown', 'start_packing', 'wrong_item'];

// Which expedition file a carrier maps to; null = a carrier we have no file for.
export function carrierKey(carrier) {
  const raw = String(carrier || '').trim();
  if (!raw) return 'unknown';
  const hit = RULES.find(([re]) => re.test(raw));
  return hit ? hit[1] : null;
}

// What the voice says for a carrier string; instant orders are announced as such first.
export function spokenCarrier(carrier, isInstant = false) {
  const raw = String(carrier || '').trim();
  let name = '';
  if (raw) {
    const hit = RULES.find(([re]) => re.test(raw));
    name = hit ? hit[2] : raw.replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  }
  // "Instant" is said once, up front, so "Gojek Instant" is just "Instant, Gojek".
  if (isInstant) name = name.replace(/\b(instant|same\s*day)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!name) return isInstant ? 'Instant' : 'Ekspedisi tidak diketahui';
  return isInstant ? `Instant, ${name}` : name;
}

// The files an announcement plays, in order; a null entry = no file for that part.
export function soundKeysFor(carrier, isInstant = false) {
  const raw = String(carrier || '').trim();
  const keys = [];
  if (isInstant) keys.push('instant');
  if (raw || !isInstant) keys.push(carrierKey(carrier)); // an instant order with no carrier is just "instant"
  return keys;
}

// ---------------------------------------------------------------- the files
const EXTENSIONS = ['mp3', 'm4a', 'mp4', 'wav', 'ogg']; // .mp4 / .m4a = audio-only AAC, e.g. from a phone recorder
const BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
const loaded = new Map(); // key -> a ready HTMLAudioElement, or null when there is no usable file
let preloading = null;
let playing = null; // the element currently playing, so a new scan can cut it off

// A missing file is detected by the audio element failing to load it, not by the
// HTTP status: a single-page app answers an unknown path with its own HTML page.
function probe(key) {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= EXTENSIONS.length) return resolve(null);
      const audio = new Audio();
      audio.preload = 'auto';
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.oncanplaythrough = null;
        audio.onerror = null;
        if (ok) resolve(audio); else tryNext();
      };
      const timer = setTimeout(() => done(false), 4000);
      audio.oncanplaythrough = () => done(true);
      audio.onerror = () => done(false);
      audio.src = `${BASE}sounds/${key}.${EXTENSIONS[i]}`;
      i += 1;
      audio.load();
    };
    tryNext();
  });
}

// Loads every expedition file once (call it when Shipping Mode opens), so the sound
// starts the instant a parcel is confirmed. Safe to call again.
export function preloadCarrierSounds() {
  if (!preloading) {
    preloading = Promise.all(SOUND_KEYS.map(async (key) => { loaded.set(key, await probe(key)); }));
  }
  return preloading;
}

function playFiles(elements) {
  if (playing) { try { playing.pause(); } catch { /* nothing to stop */ } playing.onended = null; }
  const playAt = (i) => {
    if (i >= elements.length) { playing = null; return; }
    const el = elements[i];
    playing = el;
    el.currentTime = 0;
    el.onended = () => playAt(i + 1);
    const started = el.play();
    if (started && started.catch) started.catch(() => { playing = null; });
  };
  playAt(0);
}

function speak(text) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID'; // a hint: the PC falls back to its default voice if it has no Indonesian one
    utterance.rate = 0.95;
    window.speechSynthesis.cancel(); // fast scanning: say the latest one, never a backlog
    window.speechSynthesis.speak(utterance);
  } catch {
    // Sound is a convenience; a failure must never get in the way of a pickup scan.
  }
}

// A single event sound by file name (e.g. 'start_packing'); the PC's voice says
// `fallbackText` if the file is not there, nothing if there is none.
export function playSound(key, fallbackText) {
  try {
    const element = loaded.get(key);
    if (element) return playFiles([element]);
  } catch {
    // fall through to the voice
  }
  if (fallbackText) speak(fallbackText);
}

// The client's recordings when every file is there, otherwise the PC's voice.
export function speakCarrier(carrier, isInstant = false) {
  try {
    const elements = soundKeysFor(carrier, isInstant).map((key) => (key ? loaded.get(key) : null));
    if (elements.length > 0 && elements.every(Boolean)) return playFiles(elements);
  } catch {
    // fall through to the voice
  }
  speak(spokenCarrier(carrier, isInstant));
}
