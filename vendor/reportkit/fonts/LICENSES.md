# Report fonts

Static woff2 files (one weight per file — Chrome embeds variable fonts in
PDFs as Type 3, which some printers render badly) from Fontsource
(https://fontsource.org). Used by the report designer and, via
`npm run sync:reportkit`, by the backend's PDF printer, so the editor and
the PDF lay text out identically.

| Family | License |
|---|---|
| Mulish, Inter, Open Sans, Lato, Source Serif 4, Libre Baskerville, Noto Naskh Arabic | SIL Open Font License 1.1 |
| Tinos (metric-compatible with Times New Roman) | Apache License 2.0 |

The family list lives in `src/reportkit/fonts.ts`.
