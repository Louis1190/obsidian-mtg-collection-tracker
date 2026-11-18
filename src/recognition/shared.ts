// The one CardRecognition of the plugin: made when the first photo is given (so a plugin whose feature is off, or never used, builds nothing and holds no
// engine), stopped when the setting is turned off and when the plugin unloads. The engine inside stops by itself after a minute without a reading.

import { CardRecognition } from "./service";

let shared: CardRecognition | null = null;

export function sharedCardRecognition(): CardRecognition {
	if (!shared) shared = new CardRecognition();
	return shared;
}

export async function stopSharedCardRecognition(): Promise<void> {
	const running = shared;
	shared = null;
	if (running) await running.stop();
}

/** The person tapped the camera button: the engine and the catalogue start now (while the photo is taken) and stay up, between photos, for as long as the window is open. */
export function prepareSharedCardRecognition(): void {
	const recognition = sharedCardRecognition();
	recognition.pin();
	void recognition.prepare();
}

/** The window that scans closed: the engine stops after the usual idle time. Builds nothing when nothing was ever started. */
export function releaseSharedCardRecognition(): void {
	shared?.release();
}
