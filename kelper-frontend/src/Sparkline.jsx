import { colors } from './theme';

export function Sparkline({ data, height = 32, color = colors.green, dashed = true }) {
  if (!data || data.length < 2) return null;
  const width = 100;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pad = 3;
  const coords = data.map((v, i) => [i * stepX, height - pad - ((v - min) / range) * (height - pad * 2)]);
  const points = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: 'block' }}>
      {dashed && (
        <line x1="0" y1={height - pad} x2={width} y2={height - pad} stroke={colors.border} strokeWidth="1" strokeDasharray="2 3" />
      )}
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="2.6" fill={color} />
    </svg>
  );
}
