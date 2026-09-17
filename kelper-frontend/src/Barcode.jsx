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
