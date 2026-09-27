const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };

export function IconGrid({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconBox({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M1.5 4.5 8 1.5l6.5 3-6.5 3-6.5-3Z" />
      <path d="M1.5 4.5v7L8 14.5m0 0 6.5-3v-7M8 14.5V7.5" />
    </svg>
  );
}

export function IconMonitor({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" />
      <path d="M5.5 14.5h5M8 11v3.5" />
    </svg>
  );
}

export function IconBell({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M4 6.5a4 4 0 0 1 8 0c0 3 1 3.8 1 4.3H3c0-.5 1-1.3 1-4.3Z" />
      <path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" />
    </svg>
  );
}

export function IconSettings({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.5M8 12.7v1.5M14.2 8h-1.5M3.3 8H1.8M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1M12.2 12.2l-1.1-1.1M4.9 4.9 3.8 3.8" />
    </svg>
  );
}

export function IconPower({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 1.8v5.4" />
      <path d="M11.8 4a5.6 5.6 0 1 1-7.6 0" />
    </svg>
  );
}

export function IconUser({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="8" cy="5.2" r="2.7" />
      <path d="M2.8 14c.5-2.6 2.6-4.2 5.2-4.2s4.7 1.6 5.2 4.2" />
    </svg>
  );
}

export function IconSearch({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m13.5 13.5-3-3" />
    </svg>
  );
}

export function IconRefresh({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M2.7 8a5.3 5.3 0 0 1 9.1-3.7l1 1M13.3 8a5.3 5.3 0 0 1-9.1 3.7l-1-1" />
      <path d="M12.8 2.7v2.6h-2.6M3.2 13.3v-2.6h2.6" />
    </svg>
  );
}

export function IconUpload({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 11V2.5M8 2.5 4.8 5.7M8 2.5l3.2 3.2" />
      <path d="M2.7 10.7v1.6a1.3 1.3 0 0 0 1.3 1.3h8a1.3 1.3 0 0 0 1.3-1.3v-1.6" />
    </svg>
  );
}

export function IconEdit({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M9.8 3.2 12.8 6.2 5.6 13.4 2.2 13.8 2.6 10.4Z" />
    </svg>
  );
}

export function IconStore({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M2 6.2 2.7 2.5h10.6l.7 3.7" />
      <path d="M2 6.2a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0" />
      <path d="M3 6.5V13h10V6.5" />
    </svg>
  );
}

export function IconHistory({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M2.7 8A5.3 5.3 0 1 0 4 4.2" />
      <path d="M2 3v3h3" />
      <path d="M8 5.5V8l1.8 1.2" />
    </svg>
  );
}

export function IconTag({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8.7 2.5h3.8a1 1 0 0 1 1 1v3.8a1 1 0 0 1-.3.7l-6 6a1 1 0 0 1-1.4 0L2.3 10.5a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 .4-.6Z" />
      <circle cx="10.8" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Order tags (Order Lists panel) — Instant Shipping, Order from Yesterday,
// Stuck in Ready to Check.
export function IconBolt({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8.8 1.5 3 9h3.7l-.5 5.5L13 7H9.3l.5-5.5Z" />
    </svg>
  );
}

export function IconMoon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z" />
    </svg>
  );
}

export function IconAlertTriangle({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 2.2 14.5 13.5h-13Z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Courier pickup failed, needs re-arrange (RETRY_SHIP) — a circular retry
// arrow, distinct from the generic alert triangle above.
export function IconRotateCcw({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M13 8A5 5 0 1 1 8 3c1.6 0 3 .7 4 1.8" />
      <path d="M12.5 1.5v3.5H9" />
    </svg>
  );
}

export function IconChevronDown({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M4 6.5 8 10.5 12 6.5" />
    </svg>
  );
}

export function IconArrowUpRight({ size = 13, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color || 'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12 12 4M5.5 4H12v6.5" />
    </svg>
  );
}
