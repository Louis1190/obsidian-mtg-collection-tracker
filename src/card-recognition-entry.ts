// The card-recognition entry: the one door from the rest of the plugin into src/recognition/ (docs/history/public-stubs-plan.md). Nothing outside that folder
// may import it any other way (src/__tests__/recognition-seam.test.ts fails otherwise). Until 2026-11-18 the public copy replaced this file with card-recognition-entry.stub.ts; it no longer does.
// The names are listed one by one (never `export *`) so that an export cannot become reachable by accident: the stub (kept in case the feature has to be held back again) must offer every name used here.

export { createAddCardsScan, cardRecognitionSettingRows, startCardRecognition, stopCardRecognition, FINGERPRINT_BASE_URL } from "./recognition/entry";
