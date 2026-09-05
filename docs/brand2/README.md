# Brand assets

The Nanodeploy logo, built as **true vector pixels**: every block is an SVG
`<rect>`, so it stays crisp at any size instead of blurring when scaled. Colour
is OpenAI dark blue `#03224c` on cream `#F4ECD8`. The letterforms come from
[Departure Mono](https://departuremono.com), sampled onto a coarse grid.

| Format | File | Use |
|---|---|---|
| Wordmark | `wordmark-C.svg` / `.png` | primary logo, README banner |
| Landscape 2:1 | `landscape-C.svg` / `.png` | GitHub social preview |
| Square | `square-C.svg` / `.png` | `nano` / `deploy` stacked |
| Icon | `icon-C.svg` / `.png` | `nd` monogram, used as the favicon |

PNGs are exported at 2x. Prefer the PNG when embedding in Markdown: GitHub
sanitises inline SVGs. These SVGs are plain rectangles with no embedded font, so
they render everywhere the sanitiser allows.

Departure Mono is licensed under the SIL Open Font License 1.1. Credit:
Departure Mono by Helena Zhang. Only its shapes were sampled here; the font
itself is not redistributed.
