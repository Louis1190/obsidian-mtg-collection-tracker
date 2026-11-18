
import { Platform } from "obsidian";

/** What the look needs of `navigator.mediaDevices`: a test hands in a fake. */
export interface CameraDevices {
	enumerateDevices(): Promise<ReadonlyArray<{ kind: string }>>;
	addEventListener?(type: "devicechange", listener: () => void): void;
	removeEventListener?(type: "devicechange", listener: () => void): void;
}

let webcamFound = false;

/** The browser's own list of devices, or nothing where there is none (a test under Node, an old WebView). */
function browserDevices(): CameraDevices | undefined {
	return typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
}

export function cardRecognitionAvailable(): boolean {
	return Platform.isMobileApp || webcamFound;
}

/**
 * The camera button opens the COMPUTER's webcam (webcam-capture.ts) instead of handing over to the system's camera app, which is what a phone or tablet does. True on a computer where a
 * webcam is found.
 */
export function usesWebcam(): boolean {
	return !Platform.isMobileApp && webcamFound;
}

/** Looks for a camera once: true when the device list holds a video input. A failure counts as none. */
export async function lookForWebcam(devices: CameraDevices | undefined = browserDevices()): Promise<boolean> {
	try {
		const list = await devices?.enumerateDevices();
		webcamFound = !!list?.some((d) => d.kind === "videoinput");
	} catch {
		webcamFound = false;
	}
	return webcamFound;
}

/**
 * Looks now, then again whenever a camera is plugged in or out. Returns what stops the watching (the plugin hands it to `register`, so it ends with the plugin). Phones and tablets use the
 * system's camera app: nothing to look for, nothing to watch.
 */
export function watchWebcam(devices: CameraDevices | undefined = browserDevices()): () => void {
	if (Platform.isMobileApp || !devices) return () => {};
	const look = () => void lookForWebcam(devices);
	look();
	devices.addEventListener?.("devicechange", look);
	return () => devices.removeEventListener?.("devicechange", look);
}

/** For tests only: forgets what the last look found. */
export function resetWebcamForTests(): void {
	webcamFound = false;
}
