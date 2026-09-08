export const colors = {
  bg: '#0d0d12',
  card: '#1a1a22',
  cardAlt: '#20202a',
  border: '#2e2e38',
  text: '#e9e9ef',
  textDim: '#8f8fa3',
  blue: '#428fdc',
  red: '#e2454f',
  orange: '#e9730c',
  green: '#37b24d',
};

export function card(extra = {}) {
  return {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 16,
    ...extra,
  };
}
