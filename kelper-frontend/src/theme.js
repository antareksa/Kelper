export const colors = {
  pageBg: '#ececec',
  bg: '#101012',
  card: '#18181b',
  cardAlt: '#202024',
  cardHover: '#242428',
  border: '#28282d',
  text: '#f4f4f6',
  textDim: '#8c8c96',
  textFaint: '#5a5a63',
  green: '#22c55e',
  greenDim: 'rgba(34, 197, 94, 0.14)',
  red: '#ef4444',
  redDim: 'rgba(239, 68, 68, 0.14)',
  orange: '#f97316',
  orangeDim: 'rgba(249, 115, 22, 0.14)',
  blue: '#3b82f6',
};

export function card(extra = {}) {
  return {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    padding: 18,
    boxSizing: 'border-box',
    ...extra,
  };
}
