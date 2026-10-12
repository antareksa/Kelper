// Minimal Code 39 encoder/renderer — no external barcode library needed.
// Code 39 is supported out of the box by virtually every keyboard-wedge
// barcode scanner, and only needs digits/uppercase letters/a few symbols,
// which is all this app ever needs to print (test values, internal codes).

const CODE39_PATTERNS = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000',
  '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101',
  '8': '100100100', '9': '001100100', 'A': '100001001', 'B': '001001001',
  'C': '101001000', 'D': '000011001', 'E': '100011000', 'F': '001011000',
  'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
  'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011',
  'O': '100010010', 'P': '001010010', 'Q': '000000111', 'R': '100000110',
  'S': '001000110', 'T': '000010110', 'U': '110000001', 'V': '011000001',
  'W': '111000000', 'X': '010010001', 'Y': '110010000', 'Z': '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100',
};

// Code 128 (character sets B and C) -- compact enough for the 33 x 15 mm temp label:
// 'B12345678' is 101 modules, against 232 for the same value in Code 39. Symbol
// patterns 0..106 (106 = stop) as module strings, 1 = bar, 0 = space.
const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '1100011101011',
];
const START_B = 104;
const START_C = 105;
const SWITCH_TO_C = 99;
const SWITCH_TO_B = 100;
const STOP = 106;

function digitRun(text, i) {
  let n = 0;
  while (i + n < text.length && text[i + n] >= '0' && text[i + n] <= '9') n += 1;
  return n;
}

// Symbol values for a text: set B for ordinary characters, set C (digit pairs)
// for runs of four or more digits, switching as needed.
function code128Values(text) {
  const values = [];
  let i = 0;
  let setC = false;
  if (digitRun(text, 0) >= 4 && digitRun(text, 0) % 2 === 0) { values.push(START_C); setC = true; } else values.push(START_B);
  while (i < text.length) {
    if (setC) {
      if (digitRun(text, i) >= 2) { values.push(Number(text.slice(i, i + 2))); i += 2; } else { values.push(SWITCH_TO_B); setC = false; }
    } else if (digitRun(text, i) >= 4) {
      if (digitRun(text, i) % 2 === 1) { values.push(text.charCodeAt(i) - 32); i += 1; } // odd run: the first digit stays in set B
      values.push(SWITCH_TO_C);
      setC = true;
    } else {
      const code = text.charCodeAt(i) - 32;
      if (code < 0 || code > 95) throw new Error(`Code 128 cannot encode "${text[i]}"`);
      values.push(code);
      i += 1;
    }
  }
  const checksum = values.reduce((sum, v, idx) => sum + (idx === 0 ? v : v * idx), 0) % 103;
  values.push(checksum, STOP);
  return values;
}

// The whole barcode as a string of modules (1 = bar, 0 = space), no quiet zone.
export function code128Modules(text) {
  return code128Values(String(text)).map((v) => CODE128_PATTERNS[v]).join('');
}

// Returns a self-contained <svg> markup string (a plain string, not a React
// element) so it can be embedded directly into the print iframe's srcdoc
// HTML, which is built as a template literal rather than rendered by React.
export function renderCode39Svg(value, { height = 60, narrow = 2 } = {}) {
  const wide = narrow * 2.5;
  const full = `*${value.toUpperCase()}*`;
  let x = 0;
  const bars = [];

  for (const char of full) {
    const pattern = CODE39_PATTERNS[char];
    if (!pattern) continue; // unsupported character — skip rather than break the whole barcode
    for (let i = 0; i < pattern.length; i += 1) {
      const isBar = i % 2 === 0;
      const w = pattern[i] === '1' ? wide : narrow;
      if (isBar) {
        bars.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="#000"/>`);
      }
      x += w;
    }
    x += narrow; // inter-character gap
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} ${height}" width="${x}" height="${height}">${bars.join('')}</svg>`;
}
