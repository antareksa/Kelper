// Which marketplace an order came from (2026-11-07): a small coloured tag.
// Rows without a platform are Shopee: only the TikTok Shop / Tokopedia rows
// carry the field (routes/packing.js).
export const PLATFORM_META = {
  shopee: { label: 'Shopee', color: '#ee4d2d' },
  tiktok: { label: 'TikTok', color: '#111111' },
  tokopedia: { label: 'Tokopedia', color: '#03ac0e' },
};

export function PlatformTag({ platform }) {
  const meta = PLATFORM_META[platform || 'shopee'];
  if (!meta) return null;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: '#ffffff', background: meta.color, padding: '1px 6px', borderRadius: 4 }}>
      {meta.label}
    </span>
  );
}
