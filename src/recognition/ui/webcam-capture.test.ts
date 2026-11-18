// @vitest-environment jsdom
// The window that shows a computer's webcam for the camera button (webcam-capture.ts). Obsidian's Modal and the modal chrome are faked; the camera, the video and the frame are fakes too
// (a test has no webcam), so what is pinned here is the window's own behaviour: when the camera is on and when it is OFF, what a photo is, what happens when the camera does not open.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Photo } from "../scan";

vi.mock("obsidian", () => ({
	Modal: class {
		contentEl = document.createElement("div");
		modalEl = document.createElement("div");
		opened = false;
		constructor(public app: unknown) {}
		open() {
			this.opened = true;
			(this as unknown as { onOpen(): void }).onOpen();
		}
		close() {
			this.opened = false;
			(this as unknown as { onClose(): void }).onClose();
		}
	},
}));
vi.mock("../../ui/modal-animation", () => ({
	applyModalOpenAnimation: vi.fn(),
	addModalCloseButton: vi.fn(),
	// the real one waits for the closing animation; by default it closes at once, a test can hold the end of the animation back
	closeModalAnimated: vi.fn((_modal: unknown, superClose: () => void) => superClose()),
}));

import { WEBCAM_CONSTRAINTS, WebcamCaptureModal, browserWebcam, describeCameraError, grabVideoFrame, stopStream, type WebcamDeps } from "./webcam-capture";

// The helpers Obsidian adds to HTMLElement that the file uses, on jsdom.
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		if (o?.text) e.textContent = o.text;
		this.appendChild(e);
		return e;
	};
	const create = (tag: string) =>
		function (this: HTMLElement, o?: { cls?: string; text?: string }) {
			return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl(tag, o);
		};
	proto.createDiv = create("div");
	proto.addClass = function (this: HTMLElement, c: string) {
		for (const part of c.split(" ")) this.classList.add(part);
	};
	proto.setText = function (this: HTMLElement, t: string) {
		this.textContent = t;
	};
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	(HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play = async () => {};
});

/** Whether the faked Modal is open: the fake keeps that flag, the real one does not expose it. */
const isOpen = (modal: object) => (modal as unknown as { opened: boolean }).opened;

const PHOTO: Photo = { rgba: new Uint8ClampedArray(16), w: 2, h: 2 };

function fakeStream() {
	const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
	return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function setup(opts: { stream?: ReturnType<typeof fakeStream>; openStream?: () => Promise<MediaStream>; grab?: () => Photo | null } = {}) {
	const made = opts.stream ?? fakeStream();
	const deps: WebcamDeps = {
		openStream: opts.openStream ?? (async () => made.stream),
		grabFrame: vi.fn(opts.grab ?? (() => PHOTO)),
	};
	const onPhoto = vi.fn();
	const onChooseFile = vi.fn();
	const modal = new WebcamCaptureModal({} as never, { onPhoto, onChooseFile, deps });
	modal.open();
	const el = modal.contentEl;
	const button = (cls: string) => el.querySelector(`.${cls}`) as HTMLButtonElement;
	return { modal, made, deps, onPhoto, onChooseFile, el, take: button("mtg-scan-webcam-take"), choose: button("mtg-scan-webcam-choose"), cancel: button("mtg-scan-webcam-cancel"), video: el.querySelector("video") as HTMLVideoElement, status: el.querySelector(".mtg-scan-webcam-status") as HTMLElement };
}
const settle = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};
const allStopped = (tracks: { stop: ReturnType<typeof vi.fn> }[]) => tracks.every((t) => t.stop.mock.calls.length >= 1);
const noneStopped = (tracks: { stop: ReturnType<typeof vi.fn> }[]) => tracks.every((t) => t.stop.mock.calls.length === 0);

describe("the camera", () => {
	it("is asked for up to full HD with no sound", () => {
		expect(WEBCAM_CONSTRAINTS).toEqual({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
	});

	it("the real dependency opens it through getUserMedia with exactly those constraints", async () => {
		const getUserMedia = vi.fn(async () => ({}) as MediaStream);
		Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
		await browserWebcam.openStream();
		expect(getUserMedia).toHaveBeenCalledWith(WEBCAM_CONSTRAINTS);
	});

	it("is switched on when the window opens, and the person cannot take a photo before it answers", () => {
		const { take, status, made } = setup();
		expect(take.disabled).toBe(true);
		expect(status.textContent).toBe("Starting the camera…");
		expect(noneStopped(made.tracks)).toBe(true);
	});

	it("shows the live image and offers the photo once the camera plays", async () => {
		const { take, status, video, made } = setup();
		await settle();
		expect((video as unknown as { srcObject: unknown }).srcObject).toBe(made.stream);
		expect(video.muted).toBe(true);
		expect(take.disabled).toBe(false);
		expect(status.textContent).toMatch(/Hold the card flat/);
		expect(noneStopped(made.tracks)).toBe(true);
	});
});

describe("taking a photo", () => {
	it("hands over the frame's pixels, switches the camera off and closes the window", async () => {
		const { take, onPhoto, deps, made, modal, video } = setup();
		await settle();
		take.click();
		expect(deps.grabFrame).toHaveBeenCalledWith(video);
		expect(onPhoto).toHaveBeenCalledTimes(1);
		expect(onPhoto).toHaveBeenCalledWith(PHOTO);
		expect(allStopped(made.tracks)).toBe(true);
		expect(isOpen(modal)).toBe(false);
	});

	it("switches the camera off BEFORE the closing animation ends (its light must not wait for it)", async () => {
		const { take, made, modal } = setup();
		await settle();
		// the animation finishes only when the test says so
		const { closeModalAnimated } = await import("../../ui/modal-animation");
		let finish: () => void = () => {};
		vi.mocked(closeModalAnimated).mockImplementationOnce((_m, superClose) => void (finish = superClose));
		take.click();
		expect(allStopped(made.tracks)).toBe(true);
		expect(isOpen(modal)).toBe(true);
		finish();
		expect(isOpen(modal)).toBe(false);
	});

	it("keeps the window and the camera when the camera has sent no image yet", async () => {
		const { take, onPhoto, status, made, modal } = setup({ grab: () => null });
		await settle();
		take.click();
		expect(onPhoto).not.toHaveBeenCalled();
		expect(status.textContent).toMatch(/has not sent an image yet/);
		expect(noneStopped(made.tracks)).toBe(true);
		expect(isOpen(modal)).toBe(true);
	});
});

describe("leaving without a photo", () => {
	it("Cancel switches the camera off and takes nothing", async () => {
		const { cancel, onPhoto, onChooseFile, made, modal } = setup();
		await settle();
		cancel.click();
		expect(allStopped(made.tracks)).toBe(true);
		expect(onPhoto).not.toHaveBeenCalled();
		expect(onChooseFile).not.toHaveBeenCalled();
		expect(isOpen(modal)).toBe(false);
	});

	it("\"Choose a photo…\" asks for the file chooser, switches the camera off and takes nothing", async () => {
		const { choose, onPhoto, onChooseFile, made, modal } = setup();
		await settle();
		choose.click();
		expect(onChooseFile).toHaveBeenCalledTimes(1);
		expect(allStopped(made.tracks)).toBe(true);
		expect(onPhoto).not.toHaveBeenCalled();
		expect(isOpen(modal)).toBe(false);
	});

	it("closing it any other way (Escape, the cross) switches the camera off too, and empties the window", async () => {
		const { modal, made, el, video } = setup();
		await settle();
		modal.close();
		expect(allStopped(made.tracks)).toBe(true);
		expect(el.childElementCount).toBe(0);
		expect((video as unknown as { srcObject: unknown }).srcObject).toBeNull();
	});
});

describe("when the camera does not open", () => {
	it("says why, keeps the window for the file chooser, and the photo cannot be taken", async () => {
		const { take, status, choose, onChooseFile } = setup({ openStream: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) });
		await settle();
		expect(status.textContent).toBe("Could not use the camera: access to the camera was refused. You can choose a photo instead.");
		expect(status.classList.contains("is-error")).toBe(true);
		expect(take.disabled).toBe(true);
		choose.click();
		expect(onChooseFile).toHaveBeenCalledTimes(1);
	});

	it("switches the stream off when the video cannot play", async () => {
		(HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play = () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }));
		const { take, status, made } = setup();
		await settle();
		expect(allStopped(made.tracks)).toBe(true);
		expect(take.disabled).toBe(true);
		expect(status.textContent).toMatch(/in use by another application/);
	});

	it("a camera that answers after the window closed is switched off at once and shown nowhere", async () => {
		const late = fakeStream();
		let answer: (s: MediaStream) => void = () => {};
		const { modal, video } = setup({ openStream: () => new Promise<MediaStream>((r) => (answer = r)) });
		modal.close();
		answer(late.stream);
		await settle();
		expect(allStopped(late.tracks)).toBe(true);
		expect((video as unknown as { srcObject?: unknown }).srcObject ?? null).toBeNull();
	});
});

describe("describeCameraError", () => {
	it("tells a refusal, a missing camera, a busy one, and anything else", () => {
		expect(describeCameraError({ name: "NotAllowedError" })).toBe("access to the camera was refused");
		expect(describeCameraError({ name: "SecurityError" })).toBe("access to the camera was refused");
		expect(describeCameraError({ name: "NotFoundError" })).toBe("no camera was found");
		expect(describeCameraError({ name: "OverconstrainedError" })).toBe("no camera was found");
		expect(describeCameraError({ name: "NotReadableError" })).toBe("the camera is in use by another application");
		expect(describeCameraError(new Error("boom"))).toBe("it did not start");
		expect(describeCameraError(null)).toBe("it did not start");
	});
});

describe("stopStream", () => {
	it("stops every track, may be repeated, and takes no stream", () => {
		const { stream, tracks } = fakeStream();
		stopStream(stream);
		stopStream(stream);
		expect(tracks.every((t) => t.stop.mock.calls.length === 2)).toBe(true);
		expect(() => stopStream(null)).not.toThrow();
	});
});

describe("grabVideoFrame", () => {
	function withCanvas(ctx: unknown) {
		const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx) };
		(globalThis as unknown as { createEl: unknown }).createEl = () => canvas;
		return canvas;
	}
	const video = (w: number, h: number) => ({ videoWidth: w, videoHeight: h }) as HTMLVideoElement;

	it("is the video's pixels at its own size, read once through a canvas (never encoded)", () => {
		const data = new Uint8ClampedArray(1280 * 720 * 4);
		const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data })) };
		const canvas = withCanvas(ctx);
		const v = video(1280, 720);
		const photo = grabVideoFrame(v);
		// never `toEqual` on the pixels: a failing diff of 3.6 MB never finishes
		expect(photo?.rgba).toBe(data);
		expect([photo?.w, photo?.h]).toEqual([1280, 720]);
		expect(canvas.width).toBe(1280);
		expect(canvas.height).toBe(720);
		expect(ctx.drawImage).toHaveBeenCalledWith(v, 0, 0, 1280, 720);
		expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 1280, 720);
	});

	it("is nothing before the video has a size, and nothing without a 2D canvas", () => {
		withCanvas({ drawImage: vi.fn(), getImageData: vi.fn() });
		expect(grabVideoFrame(video(0, 0))).toBeNull();
		withCanvas(null);
		expect(grabVideoFrame(video(640, 480))).toBeNull();
	});
});
