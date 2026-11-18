// What a reading is given (photo-input.ts): a file is decoded, pixels already in hand (a webcam frame) are used as they are.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDecodedPhoto, photoFromSource } from "./photo-input";
import type { Photo } from "./scan";

const globals = globalThis as unknown as { createImageBitmap?: unknown; createEl?: unknown };
afterEach(() => {
	delete globals.createImageBitmap;
	delete globals.createEl;
});

const PIXELS: Photo = { rgba: new Uint8ClampedArray(16), w: 2, h: 2 };

describe("photoFromSource", () => {
	it("takes decoded pixels as they are: nothing is decoded, copied or resized", async () => {
		const decode = vi.fn();
		globals.createImageBitmap = decode;
		const photo = await photoFromSource(PIXELS);
		expect(photo).toBe(PIXELS);
		expect(decode).not.toHaveBeenCalled();
	});

	it("decodes a file through the canvas, brought to at most the long side asked for", async () => {
		const close = vi.fn();
		globals.createImageBitmap = vi.fn(async () => ({ width: 4000, height: 3000, close }));
		const data = new Uint8ClampedArray(8);
		const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data })) };
		globals.createEl = () => ({ width: 0, height: 0, getContext: () => ctx });
		const photo = await photoFromSource(new Blob(["x"]), 1000);
		expect([photo.w, photo.h]).toEqual([1000, 750]);
		expect(photo.rgba).toBe(data);
		expect(close).toHaveBeenCalledTimes(1);
	});
});

describe("isDecodedPhoto", () => {
	it("tells pixels from a file", () => {
		expect(isDecodedPhoto(PIXELS)).toBe(true);
		expect(isDecodedPhoto(new Blob(["x"]))).toBe(false);
		expect(isDecodedPhoto(new File(["x"], "a.jpg"))).toBe(false);
	});
});
