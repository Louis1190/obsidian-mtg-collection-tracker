// The PUBLIC build's card-recognition entry: the feature does not exist there (it is private, see docs/history/public-stubs-plan.md). tools/publish-public.mjs copies THIS file
// over src/card-recognition-entry.ts in the public copy and leaves the real one and src/recognition/ out, so nothing in the public bundle can reach the private code.
// It sits in src/ (not in tools/) so that `tsc` checks it at every build and its relative import is the same wherever it ends up.

import type { CardRecognitionEntry } from "./card-recognition-types";

export const createAddCardsScan: CardRecognitionEntry["createAddCardsScan"] = () => null;
export const cardRecognitionSettingRows: CardRecognitionEntry["cardRecognitionSettingRows"] = () => [];
export const stopCardRecognition: CardRecognitionEntry["stopCardRecognition"] = () => {};
export const FINGERPRINT_BASE_URL: CardRecognitionEntry["FINGERPRINT_BASE_URL"] = "";
