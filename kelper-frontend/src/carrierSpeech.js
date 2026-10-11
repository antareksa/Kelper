// Shipping Mode speaks the expedition's name when a parcel is confirmed picked up
// (client-requested 2026-10-12), so the operator hears where it goes without
// looking at the screen. Uses the browser's built-in speech (the PC's own voices):
// no audio files and nothing to install, but it needs a voice on that PC, which
// every Windows has.

// Shopee gives the carrier as free text ("SPX Express", "J&T Express", "JNE
// Reguler", ...). The expedition's name is kept and the service name dropped.
// Letters are spaced out where a voice would otherwise mangle them.
const RULES = [
  [/spx|shopee\s*x?press/i, 'S P X'],
  [/j\s*&\s*t|\bjnt\b|j\s*and\s*t/i, 'J and T'],
  [/\bjne\b/i, 'J N E'],
  [/si\s*cepat/i, 'Si Cepat'],
  [/anter\s*aja/i, 'Anter Aja'],
  [/ninja/i, 'Ninja'],
  [/\bid\s*express\b|idexpress/i, 'I D Express'],
  [/lion/i, 'Lion Parcel'],
  [/\bpos\b/i, 'Pos Indonesia'],
  [/tiki/i, 'Tiki'],
  [/wahana/i, 'Wahana'],
];

// What to say for a carrier string; instant orders are announced as such first.
export function spokenCarrier(carrier, isInstant = false) {
  const raw = String(carrier || '').trim();
  let name = '';
  if (raw) {
    const hit = RULES.find(([re]) => re.test(raw));
    name = hit ? hit[1] : raw.replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  }
  // "Instant" is said once, up front, so "Gojek Instant" is just "Instant, Gojek".
  if (isInstant) name = name.replace(/\b(instant|same\s*day)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!name) return isInstant ? 'Instant' : 'Ekspedisi tidak diketahui';
  return isInstant ? `Instant, ${name}` : name;
}

export function speakCarrier(carrier, isInstant = false) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(spokenCarrier(carrier, isInstant));
    utterance.lang = 'id-ID'; // a hint: the PC falls back to its default voice if it has no Indonesian one
    utterance.rate = 0.95;
    window.speechSynthesis.cancel(); // fast scanning: say the latest one, never a backlog
    window.speechSynthesis.speak(utterance);
  } catch {
    // Sound is a convenience; a failure must never get in the way of a pickup scan.
  }
}
