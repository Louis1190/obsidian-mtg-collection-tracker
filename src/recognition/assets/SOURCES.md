# What is in this folder, where it comes from, how to make it again

These files are embedded in `main.js` by the `embed:` plugin of `esbuild.config.mjs`
(`src/recognition/assets.ts` imports them).

| File | What | Source | Licence | Made with |
|---|---|---|---|---|
| `eng.traineddata.gz` | the English LSTM model of Tesseract (`tessdata_fast`), gzipped | `https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata`, downloaded 2026-11-07; **raw file sha-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`**, 4 113 088 bytes | Apache-2.0 | `gzip -9 -n -c eng.traineddata > eng.traineddata.gz` |
| `catalogue-snapshot.tsv.gz` | the card names, English + French (the other columns empty), gzipped | MTGJSON `AtomicCards.json.xz` build of 2026-11-17 (`catalogue-snapshot-info.ts` has the exact version, counts and sha-256 of this file) | MIT (MTGJSON) | `tools/android/probes/card-scan/build-catalogue.mjs` then `make-snapshot.mjs` |

The OCR engine itself (the worker script and the WebAssembly core) is NOT kept here: it comes from the pinned npm packages `tesseract.js` and `tesseract.js-core` (5.1.1,
both Apache-2.0) and is embedded at build time from `node_modules`. Anything published later must credit Tesseract, Tesseract.js, tessdata_fast and MTGJSON in the README.
