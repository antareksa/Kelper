import { colors, card } from './theme';

function HppBiaya() {
  return (
    <div style={{ color: colors.text }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4, fontFamily: 'var(--heading)' }}>HPP & Biaya</div>
      <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 16 }}>
        Kelola HPP dan biaya per SKU — belum ada data.
      </div>
      <div style={{ ...card(), textAlign: 'center', padding: '40px 20px' }}>
        <p style={{ color: colors.textDim, margin: 0 }}>Belum ada data HPP. Fitur input/edit HPP menyusul.</p>
      </div>
    </div>
  );
}

export default HppBiaya;
