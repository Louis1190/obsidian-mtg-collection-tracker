import { describe, expect, it } from "vitest";
import { ImagePreloader } from "./image-preload";

// A stand-in for HTMLImageElement: what the preloader sets on it.
function fakeImage() {
	const attrs: Record<string, string> = {};
	return { src: "", decoding: "", attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) } as unknown as HTMLImageElement & { attrs: Record<string, string> };
}

describe("ImagePreloader", () => {
	it("requests each address once, at low priority, with an asynchronous decode", () => {
		const made: (HTMLImageElement & { attrs: Record<string, string> })[] = [];
		const preloader = new ImagePreloader(10, () => {
			const img = fakeImage();
			made.push(img);
			return img;
		});
		preloader.preload(["https://a/1.jpg", "https://a/2.jpg", "https://a/1.jpg"]);
		preloader.preload(["https://a/2.jpg"]);
		expect(made.map((i) => i.src)).toEqual(["https://a/1.jpg", "https://a/2.jpg"]);
		expect(made.every((i) => i.attrs.fetchpriority === "low" && i.decoding === "async")).toBe(true);
	});

	it("keeps a bounded number of pictures, dropping the least recently used first", () => {
		const preloader = new ImagePreloader(3, fakeImage);
		preloader.preload(["u1", "u2", "u3"]);
		preloader.preload(["u1"]); // seen again: now the most recent
		preloader.preload(["u4"]);
		expect(preloader.size).toBe(3);
		expect(preloader.has("u2")).toBe(false); // the oldest after the refresh of u1
		expect(preloader.has("u1") && preloader.has("u3") && preloader.has("u4")).toBe(true);
	});
});
