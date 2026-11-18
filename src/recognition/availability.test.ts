import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMobile: false, isMobileApp: false }));
vi.mock("obsidian", () => ({ Platform: platform }));

import { cardRecognitionAvailable, lookForWebcam, resetWebcamForTests, usesWebcam, watchWebcam, type CameraDevices } from "./availability";

/** A device list a test controls: what it holds now, and the `devicechange` listeners it was given. */
function fakeDevices(kinds: string[]) {
	const listeners = new Set<() => void>();
	const devices = {
		kinds,
		enumerateDevices: vi.fn(async () => devices.kinds.map((kind) => ({ kind }))),
		addEventListener: vi.fn((_type: "devicechange", listener: () => void) => void listeners.add(listener)),
		removeEventListener: vi.fn((_type: "devicechange", listener: () => void) => void listeners.delete(listener)),
		plug(kind: string) {
			devices.kinds = [...devices.kinds, kind];
			for (const l of listeners) l();
		},
		unplugAll() {
			devices.kinds = [];
			for (const l of listeners) l();
		},
		listeners,
	};
	return devices satisfies CameraDevices & Record<string, unknown>;
}
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
	platform.isMobile = false;
	platform.isMobileApp = false;
	resetWebcamForTests();
});

describe("cardRecognitionAvailable", () => {
	it("is true in the phone and tablet apps, with no webcam to look for", () => {
		platform.isMobile = true;
		platform.isMobileApp = true;
		expect(cardRecognitionAvailable()).toBe(true);
		expect(usesWebcam()).toBe(false);
	});

	it("is false on a computer that has not found a webcam (before the first look answers, or none)", () => {
		expect(cardRecognitionAvailable()).toBe(false);
		expect(usesWebcam()).toBe(false);
	});

	it("is true on a computer once a webcam is found, and the button then opens the webcam", async () => {
		await lookForWebcam(fakeDevices(["audioinput", "videoinput"]));
		expect(cardRecognitionAvailable()).toBe(true);
		expect(usesWebcam()).toBe(true);
	});

	it("is true in a computer's mobile emulation only if it has a webcam: it is still a computer", async () => {
		platform.isMobile = true;
		expect(cardRecognitionAvailable()).toBe(false);
		await lookForWebcam(fakeDevices(["videoinput"]));
		expect(cardRecognitionAvailable()).toBe(true);
		expect(usesWebcam()).toBe(true);
	});

	it("is read at each call, not once", async () => {
		expect(cardRecognitionAvailable()).toBe(false);
		platform.isMobileApp = true;
		expect(cardRecognitionAvailable()).toBe(true);
		platform.isMobileApp = false;
		await lookForWebcam(fakeDevices(["videoinput"]));
		expect(cardRecognitionAvailable()).toBe(true);
	});
});

describe("lookForWebcam", () => {
	it("finds a video input among the devices", async () => {
		expect(await lookForWebcam(fakeDevices(["audioinput", "audiooutput", "videoinput"]))).toBe(true);
	});

	it("finds none when there are only microphones and speakers, or nothing", async () => {
		expect(await lookForWebcam(fakeDevices(["audioinput", "audiooutput"]))).toBe(false);
		expect(await lookForWebcam(fakeDevices([]))).toBe(false);
	});

	it("takes a list that cannot be read, or that is missing, for no webcam (the feature then stays off)", async () => {
		const broken: CameraDevices = { enumerateDevices: async () => Promise.reject(new Error("no")) };
		expect(await lookForWebcam(broken)).toBe(false);
		expect(await lookForWebcam(undefined)).toBe(false);
	});

	it("a later look replaces an earlier answer (a camera that is gone is no longer found)", async () => {
		await lookForWebcam(fakeDevices(["videoinput"]));
		expect(cardRecognitionAvailable()).toBe(true);
		await lookForWebcam(fakeDevices([]));
		expect(cardRecognitionAvailable()).toBe(false);
	});

	it("asks for nothing but the list: no camera is opened", async () => {
		const devices = fakeDevices(["videoinput"]);
		const getUserMedia = vi.fn();
		await lookForWebcam({ ...devices, enumerateDevices: devices.enumerateDevices, getUserMedia } as unknown as CameraDevices);
		expect(getUserMedia).not.toHaveBeenCalled();
	});
});

describe("watchWebcam", () => {
	it("looks at once, then again each time a camera is plugged in or out", async () => {
		const devices = fakeDevices([]);
		watchWebcam(devices);
		await settle();
		expect(cardRecognitionAvailable()).toBe(false);
		devices.plug("videoinput");
		await settle();
		expect(cardRecognitionAvailable()).toBe(true);
		devices.unplugAll();
		await settle();
		expect(cardRecognitionAvailable()).toBe(false);
	});

	it("finds a camera that was there from the start", async () => {
		watchWebcam(fakeDevices(["videoinput"]));
		await settle();
		expect(usesWebcam()).toBe(true);
	});

	it("returns what stops it: the listener is removed and a camera plugged in afterwards is not noticed", async () => {
		const devices = fakeDevices([]);
		const stop = watchWebcam(devices);
		expect(devices.listeners.size).toBe(1);
		stop();
		expect(devices.listeners.size).toBe(0);
		devices.kinds = ["videoinput"];
		await settle();
		expect(cardRecognitionAvailable()).toBe(false);
	});

	it("does nothing in the phone and tablet apps (they use the system's camera app) and where there is no device list", () => {
		platform.isMobileApp = true;
		const devices = fakeDevices(["videoinput"]);
		watchWebcam(devices)();
		expect(devices.enumerateDevices).not.toHaveBeenCalled();
		expect(devices.addEventListener).not.toHaveBeenCalled();
		platform.isMobileApp = false;
		expect(() => watchWebcam(undefined)()).not.toThrow();
	});
});
