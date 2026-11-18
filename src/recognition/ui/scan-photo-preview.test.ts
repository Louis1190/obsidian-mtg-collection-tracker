// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Quad } from "../card-finder";
import type { Photo } from "../scan";
import { outlinePoints, PREVIEW_MAX_SIDE, renderPhotoPreview } from "./scan-photo-preview";

// The helpers Obsidian adds to HTMLElement that the file uses, on jsdom, and a 2D canvas that remembers what was painted.
const painted: { w: number; h: number }[] = [];
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createDiv = function (this: HTMLElement, o?: { cls?: string }) {
		const d = document.createElement("div");
		if (o?.cls) d.className = o.cls;
		this.appendChild(d);
		return d;
	};
	proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		this.appendChild(e);
		return e;
	};
	painted.length = 0;
	(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ({
		createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
		putImageData: (image: { width: number; height: number }) => painted.push({ w: image.width, h: image.height }),
	});
	document.body.innerHTML = "";
});

const photo = (w: number, h: number): Photo => ({ rgba: new Uint8ClampedArray(w * h * 4), w, h });
const QUAD: Quad = [
	[10.04, 20],
	[90, 20.06],
	[90, 140],
	[10, 140],
];

describe("outlinePoints", () => {
	it("lists the four corners, rounded to a tenth of a pixel", () => {
		expect(outlinePoints(QUAD)).toBe("10,20 90,20.1 90,140 10,140");
	});
	it("answers null when a corner is not a finite number, or there are not four", () => {
		expect(outlinePoints([[0, 0], [1, NaN], [1, 1], [0, 1]])).toBeNull();
		expect(outlinePoints([[0, 0], [Infinity, 0], [1, 1], [0, 1]])).toBeNull();
		expect(outlinePoints([[0, 0], [1, 0], [1, 1]] as unknown as Quad)).toBeNull();
	});
});

describe("renderPhotoPreview", () => {
	function setup(p: Photo) {
		const panel = document.body.appendChild(document.createElement("div"));
		const bar = panel.appendChild(document.createElement("div"));
		bar.className = "bar";
		return { panel, bar, preview: renderPhotoPreview(panel, bar, p) };
	}

	it("paints the photo at no more than PREVIEW_MAX_SIDE on its long side, whatever its orientation, and places it before the bar", () => {
		const portrait = setup(photo(1440, 1920));
		expect(painted).toEqual([{ w: 360, h: PREVIEW_MAX_SIDE }]);
		expect(Array.from(portrait.panel.children).map((c) => c.className)).toEqual(["mtg-scan-preview", "mtg-scan-hint", "bar"]);
		painted.length = 0;
		setup(photo(1920, 1440));
		expect(painted).toEqual([{ w: PREVIEW_MAX_SIDE, h: 360 }]);
	});

	it("does not enlarge a photo that is already small", () => {
		setup(photo(200, 100));
		expect(painted).toEqual([{ w: 200, h: 100 }]);
	});

	it("draws the outline in the photo's pixels (the viewBox is the photo's, not the picture's) and moves it instead of adding another", () => {
		const { panel, preview } = setup(photo(1440, 1920));
		expect(panel.querySelector(".mtg-scan-outline")).toBeNull();
		preview!.setOutline(QUAD);
		const svg = panel.querySelector(".mtg-scan-outline")!;
		expect(svg.getAttribute("viewBox")).toBe("0 0 1440 1920");
		expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(panel.querySelector(".mtg-scan-outline-line")!.getAttribute("points")).toBe("10,20 90,20.1 90,140 10,140");
		expect(panel.querySelector(".mtg-scan-hint")!.textContent).toMatch(/retake/i);
		preview!.setOutline([[1, 2], [3, 2], [3, 4], [1, 4]]);
		expect(panel.querySelectorAll(".mtg-scan-outline")).toHaveLength(1);
		expect(panel.querySelector(".mtg-scan-outline-line")!.getAttribute("points")).toBe("1,2 3,2 3,4 1,4");
		expect(panel.querySelector(".mtg-scan-outline-shade")!.getAttribute("points")).toBe("1,2 3,2 3,4 1,4");
	});

	it("ignores a quad it cannot draw, and the outline already there stays", () => {
		const { panel, preview } = setup(photo(100, 100));
		preview!.setOutline([[0, 0], [NaN, 0], [1, 1], [0, 1]]);
		expect(panel.querySelector(".mtg-scan-outline")).toBeNull();
		expect(panel.querySelector(".mtg-scan-hint")!.textContent).toBe("");
		preview!.setOutline(QUAD);
		preview!.setOutline([[0, 0], [NaN, 0], [1, 1], [0, 1]]);
		expect(panel.querySelector(".mtg-scan-outline-line")!.getAttribute("points")).toBe("10,20 90,20.1 90,140 10,140");
	});

	it("removes the picture and its hint", () => {
		const { panel, preview } = setup(photo(100, 100));
		preview!.setOutline(QUAD);
		preview!.remove();
		expect(Array.from(panel.children).map((c) => c.className)).toEqual(["bar"]);
	});

	it("makes no preview, and leaves the panel as it was, when there is no 2D canvas", () => {
		(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => null;
		const { panel, preview } = setup(photo(100, 100));
		expect(preview).toBeNull();
		expect(Array.from(panel.children).map((c) => c.className)).toEqual(["bar"]);
	});
});
