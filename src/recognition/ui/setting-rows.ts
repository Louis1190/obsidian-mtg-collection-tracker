// The settings row of the card recognition (beta, PRIVATE like src/recognition/), moved out of setting-tab.ts so that its texts do not ship in the public build
// (docs/history/public-stubs-plan.md). The tab spreads what src/card-recognition-entry.ts gives it into the "Interface" group, where this row always sat.

import type { CardRecognitionSettingRow } from "../../card-recognition-types";
import type MTGCollectionPlugin from "../../plugin";
import { cardRecognitionAvailable } from "../availability";
import { stopSharedCardRecognition } from "../shared";
import { stopFingerprintBase } from "./fingerprint-base";

export function cardRecognitionSettingRows(plugin: MTGCollectionPlugin): CardRecognitionSettingRow[] {
	return [
		// Beta, private channel only: the engine and the card names are inside this plugin, so nothing is downloaded; the photo never leaves the
		// device (only the names of the proposed cards go to Scryfall, as for any search) and the plugin lets go of it as soon as it has been read. On by default (2026-11-18): the button shows, but nothing is loaded
		// or downloaded until the first tap on it. Phones, tablets and computers with a webcam (availability.ts): on a computer without one the row is neither shown nor found by the settings search.
		{
			name: "Card recognition (beta)",
			desc: "Add a card from a photo: a camera button appears in \"Add cards\". The photo is read on this device (nothing is uploaded) and is let go as soon as it has been read. You choose among up to three proposed cards, nothing is added by itself. On a computer the button opens its webcam, and this setting is shown only where a webcam is found. The first photo takes a few seconds while the reader starts. Works best with the card flat on a plain surface; a dark card on a dark table may not be found.",
			aliases: ["photo", "camera", "scan", "ocr", "recognise", "recognize", "picture"],
			visible: () => cardRecognitionAvailable(),
			searchable: () => cardRecognitionAvailable(),
			render: (setting) => {
				setting.addToggle((toggle) =>
					toggle.setValue(plugin.settings.cardRecognitionEnabled).onChange(async (value) => {
						plugin.settings.cardRecognitionEnabled = value;
						await plugin.saveSettings();
						if (!value) {
							void stopSharedCardRecognition();
							stopFingerprintBase(plugin);
						}
					})
				);
			},
		},
	];
}
