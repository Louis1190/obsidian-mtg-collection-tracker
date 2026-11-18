// The real implementation of what src/card-recognition-entry.ts offers the rest of the plugin (typed against src/card-recognition-types.ts, like the public stub).
// Until 2026-11-18 the public build left this file out and shipped a stub instead (docs/history/public-stubs-plan.md); it now carries it.

import type { CardRecognitionEntry } from "../card-recognition-types";
import { watchWebcam } from "./availability";
import { FINGERPRINT_BASE_URL as CONFIGURED_BASE_URL } from "./fingerprint/config";
import { stopSharedCardRecognition } from "./shared";
import { AddCardsScan } from "./ui/add-cards-scan";
import { stopFingerprintBase } from "./ui/fingerprint-base";
import { cardRecognitionSettingRows as rows } from "./ui/setting-rows";

export const createAddCardsScan: CardRecognitionEntry["createAddCardsScan"] = (host) => new AddCardsScan(host);

export const cardRecognitionSettingRows: CardRecognitionEntry["cardRecognitionSettingRows"] = (plugin) => rows(plugin);

// A computer's webcam is looked for once the plugin has loaded, and again when a camera is plugged in or out (availability.ts: no permission is asked, no camera is switched on). `register`
// runs the stop when the plugin unloads.
export const startCardRecognition: CardRecognitionEntry["startCardRecognition"] = (plugin) => {
	plugin.register(watchWebcam());
};

// The card reader (beta, a worker holding ~80 MB while it runs) and the base of fingerprints end with the plugin, or when the setting goes off.
export const stopCardRecognition: CardRecognitionEntry["stopCardRecognition"] = (plugin) => {
	void stopSharedCardRecognition();
	stopFingerprintBase(plugin);
};

export const FINGERPRINT_BASE_URL: CardRecognitionEntry["FINGERPRINT_BASE_URL"] = CONFIGURED_BASE_URL;
