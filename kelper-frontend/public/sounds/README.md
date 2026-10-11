# Expedition sounds (Shipping Mode)

When a parcel is confirmed picked up in Shipping Mode, the station plays the sound
of its expedition. Put one sound file per expedition in THIS folder, named exactly
as below. Any of `.mp3`, `.m4a`, `.mp4` (audio only), `.wav` or `.ogg` works.

| File name (without extension) | Plays for carriers like |
|---|---|
| `spx` | SPX Express, SPX Hemat, Shopee Xpress |
| `jnt` | J&T Express, J&T Economy |
| `jne` | JNE Reguler, JNE YES |
| `sicepat` | SiCepat REG, SiCepat Halu |
| `anteraja` | AnterAja |
| `ninja` | Ninja Xpress |
| `idexpress` | ID Express |
| `lion` | Lion Parcel |
| `pos` | POS Indonesia |
| `tiki` | Tiki |
| `wahana` | Wahana |
| `instant` | played FIRST for an instant order, then the expedition's sound |
| `unknown` | played when the order has no carrier on it |

Tips: keep each one short (about 1-2 seconds, just the name) and at a similar volume.

If a file is missing, the station says that expedition's name with the PC's own voice
instead, so a missing file is never silence. An expedition not in the table is always
said with the voice. Tell the developer if another expedition needs its own file.

After adding or changing files, they reach the stations on the next deploy; reload
the station page afterwards.
