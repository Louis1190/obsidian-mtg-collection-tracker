import { describe, expect, it } from "vitest";
import type { Point, Quad } from "./card-finder";
import { catmullRom, encodeBmp, extractStrip, gaussianBlur, homography, stripVariant, toChannel, toGray, type GrayImage } from "./strips";

function image(w: number, h: number, f: (x: number, y: number) => number): GrayImage {
	const data = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
	return { data, w, h };
}
const mean = (a: ArrayLike<number>) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i];
	return s / a.length;
};
const row = (img: GrayImage, y: number) => img.data.subarray(y * img.w, (y + 1) * img.w);

describe("toChannel", () => {
	// a red, a green, a blue and a white pixel (RGBA)
	const px = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
	it("is one colour channel of the pixels, with no weighting", () => {
		expect(Array.from(toChannel(px, 4, 1, "R").data)).toEqual([255, 0, 0, 255]);
		expect(Array.from(toChannel(px, 4, 1, "G").data)).toEqual([0, 255, 0, 255]);
		expect(Array.from(toChannel(px, 4, 1, "B").data)).toEqual([0, 0, 255, 255]);
	});
	it("is the luminance for L, the very picture toGray gives", () => {
		expect(toChannel(px, 4, 1, "L")).toEqual(toGray(px, 4, 1));
	});
	it("keeps the size and ignores the alpha", () => {
		const g = toChannel([10, 20, 30, 0, 40, 50, 60, 7], 2, 1, "G");
		expect([g.w, g.h]).toEqual([2, 1]);
		expect(Array.from(g.data)).toEqual([20, 50]);
	});
	it("tells apart what the luminance cannot: dark text on a red bar keeps its contrast in the red channel and loses it in the blue", () => {
		const bar = [200, 40, 40, 255]; // the bar
		const text = [90, 15, 15, 255]; // the text on it
		const px2 = [...bar, ...text];
		const spread = (c: "L" | "R" | "G" | "B"): number => {
			const d = toChannel(px2, 2, 1, c).data;
			return Math.abs(d[0] - d[1]);
		};
		expect(spread("R")).toBe(110);
		expect(spread("R")).toBeGreaterThan(spread("L") * 1.5);
		expect(spread("B")).toBeLessThan(spread("R") / 3);
	});
});

describe("toGray", () => {
	it("weights red, green and blue as luminance", () => {
		const g = toGray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255], 4, 1);
		expect(Array.from(g.data)).toEqual([76, 150, 29, 255]);
	});
});

describe("homography", () => {
	it("sends the four given points to their images, and a point inside where perspective says", () => {
		const from: Point[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
		const to: Point[] = [[10, 20], [110, 30], [100, 160], [5, 150]];
		const H = homography(from, to);
		for (let i = 0; i < 4; i++) {
			const d = H[6] * from[i][0] + H[7] * from[i][1] + 1;
			expect((H[0] * from[i][0] + H[1] * from[i][1] + H[2]) / d).toBeCloseTo(to[i][0], 6);
			expect((H[3] * from[i][0] + H[4] * from[i][1] + H[5]) / d).toBeCloseTo(to[i][1], 6);
		}
	});
});

describe("catmullRom", () => {
	const weights = (t: number) => {
		const w = [0, 0, 0, 0];
		catmullRom(t, w);
		return w;
	};
	it("passes through the pixels it samples exactly, and its weights always add up to 1", () => {
		expect(weights(0).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, 0, 0]);
		expect(weights(1).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1, 0]);
		for (const t of [0.1, 0.25, 0.5, 0.8]) expect(weights(t).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
	});
	it("has the cubic's negative side lobes that keep an edge sharp (a linear blend would have none)", () => {
		const w = weights(0.25);
		expect(w[0]).toBeCloseTo(-0.0703, 3);
		expect(w[1]).toBeCloseTo(0.8672, 3);
		expect(w[2]).toBeCloseTo(0.2266, 3);
		expect(w[3]).toBeCloseTo(-0.0234, 3);
	});
});

describe("extractStrip", () => {
	// a 400 x 500 photo; the card is the axis-aligned quad (50,60)-(250,60+280) whose pixels are a vertical ramp from 0 (top) to 255 (bottom)
	const quad: Quad = [[50, 60], [250, 60], [250, 340], [50, 340]];
	const ramp = image(400, 500, (_x, y) => ((y - 60) / 280) * 255);

	it("cuts the title strip: the right size, and the part of the card at 3.5 % to 10.5 % of its height", () => {
		const s = extractStrip(ramp, quad);
		expect(s.w).toBe(1100);
		expect(s.h).toBeGreaterThan(125);
		expect(s.h).toBeLessThan(145);
		expect(row(s, 0)[10]).toBeGreaterThan(255 * 0.035 - 3);
		expect(row(s, 0)[10]).toBeLessThan(255 * 0.035 + 3);
		expect(row(s, s.h - 1)[10]).toBeGreaterThan(255 * 0.105 - 3);
		expect(row(s, s.h - 1)[10]).toBeLessThan(255 * 0.105 + 3);
		expect(mean(row(s, 5))).toBeCloseTo(row(s, 5)[500], 0); // no change along a row of this ramp
	});

	it("reads the card upside down when asked (the quad starts at the opposite corner)", () => {
		const s = extractStrip(ramp, quad, { roll: 2 });
		expect(row(s, 0)[10]).toBeGreaterThan(255 * (1 - 0.035) - 3);
		expect(row(s, s.h - 1)[10]).toBeLessThan(255 * (1 - 0.105) + 3);
	});

	it("follows a card turned by 15 degrees: along the strip the ramp does not change", () => {
		const a = (15 * Math.PI) / 180;
		const c = [150, 250];
		const corners = ([[-100, -140], [100, -140], [100, 140], [-100, 140]] as Point[]).map(([x, y]): Point => [c[0] + x * Math.cos(a) - y * Math.sin(a), c[1] + x * Math.sin(a) + y * Math.cos(a)]);
		// intensity = position along the card's own long axis
		const turned = image(400, 500, (x, y) => (((x - c[0]) * Math.sin(-a) + (y - c[1]) * Math.cos(-a) + 140) / 280) * 255);
		const s = extractStrip(turned, corners as Quad);
		const r = row(s, 40);
		expect(Math.max(...Array.from(r)) - Math.min(...Array.from(r))).toBeLessThanOrEqual(2);
	});

	it("can reach above the quad's top through the same perspective", () => {
		// above the card's top edge the photo is white, inside it black: a strip from 5 % above to 4 % below must be white at the top, black at the bottom
		const card = image(400, 500, (_x, y) => (y < 60 ? 255 : 0));
		const s = extractStrip(card, quad, { y0: -0.05, y1: 0.04 });
		expect(row(s, 0)[10]).toBe(255);
		expect(row(s, s.h - 1)[10]).toBe(0);
	});

	it("uses the nearest edge pixel when the window leaves the photo", () => {
		// the photo's pixel value is its x position (0..99); a card whose left half hangs outside the photo reads 0 there, never a wrapped-around value
		const s = extractStrip(image(100, 100, (x) => x), [[-50, 30], [40, 30], [40, 90], [-50, 90]]);
		let lo = 255;
		let hi = 0;
		for (const v of s.data) {
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		expect(lo).toBe(0);
		expect(hi).toBeLessThanOrEqual(40);
	});
});

describe("gaussianBlur", () => {
	it("keeps a flat picture flat and spreads an impulse symmetrically, without losing it", () => {
		expect(Array.from(new Set(Array.from(gaussianBlur(image(60, 20, () => 90), 5)).map(Math.round)))).toEqual([90]);
		const imp = image(201, 1, (x) => (x === 100 ? 255 : 0));
		const b = gaussianBlur(imp, 10);
		expect(b[100 - 7]).toBeCloseTo(b[100 + 7], 4);
		expect(Array.from(b).reduce((s, v) => s + v, 0)).toBeCloseTo(255, 0);
	});
	it("has about the spread asked for", () => {
		const imp = image(401, 1, (x) => (x === 200 ? 255 : 0));
		const b = gaussianBlur(imp, 18);
		let m2 = 0;
		let total = 0;
		for (let x = 0; x < 401; x++) {
			m2 += b[x] * (x - 200) * (x - 200);
			total += b[x];
		}
		expect(Math.sqrt(m2 / total)).toBeGreaterThan(16);
		expect(Math.sqrt(m2 / total)).toBeLessThan(20);
		// and the bell shape of a Gaussian, not the flat top of one box: the peak is about e^0.5 = 1.65 times the value one sigma away
		expect(b[200] / b[218]).toBeGreaterThan(1.4);
		expect(b[200] / b[218]).toBeLessThan(1.9);
	});
});

describe("stripVariant", () => {
	const flat = image(200, 40, () => 100);

	it("asis changes nothing, inv inverts and raises the contrast by 1.3", () => {
		expect(Array.from(stripVariant(flat, "asis").data.slice(0, 3))).toEqual([100, 100, 100]);
		expect(stripVariant(flat, "inv").data[0]).toBe(163); // (255 - 100 - 127.5) * 1.3 + 127.5
	});
	it("a flat picture has no local contrast: the three local-contrast versions come out white (or mid grey for the one-sided pair)", () => {
		expect(stripVariant(flat, "thabs").data[0]).toBe(255);
		expect(stripVariant(flat, "thlight").data[0]).toBe(127);
		expect(stripVariant(flat, "thdark").data[0]).toBe(127);
	});
	it("makes a lighter-than-its-surroundings mark dark in thlight, and a darker one dark in thdark", () => {
		const dot = image(200, 40, (x, y) => (Math.abs(x - 100) < 4 && Math.abs(y - 20) < 4 ? 220 : 100));
		const dark = image(200, 40, (x, y) => (Math.abs(x - 100) < 4 && Math.abs(y - 20) < 4 ? 20 : 100));
		expect(stripVariant(dot, "thlight").data[20 * 200 + 100]).toBeLessThan(40);
		expect(stripVariant(dot, "thdark").data[20 * 200 + 100]).toBeGreaterThan(200);
		expect(stripVariant(dark, "thdark").data[20 * 200 + 100]).toBeLessThan(40);
		expect(stripVariant(dark, "thlight").data[20 * 200 + 100]).toBeGreaterThan(200);
	});
	it("thabs turns BOTH edges of an embossed letter (a light stripe beside a dark one) into dark strokes", () => {
		const embossed = image(200, 40, (x) => (x >= 98 && x < 102 ? 190 : x >= 102 && x < 106 ? 30 : 100));
		const t = stripVariant(embossed, "thabs");
		expect(t.data[20 * 200 + 100]).toBeLessThan(60); // the light stripe
		expect(t.data[20 * 200 + 104]).toBeLessThan(60); // the dark stripe
		expect(t.data[20 * 200 + 10]).toBe(255); // the ground
		// whereas thlight only keeps the light one
		const l = stripVariant(embossed, "thlight");
		expect(l.data[20 * 200 + 100]).toBeLessThan(60);
		expect(l.data[20 * 200 + 104]).toBeGreaterThan(160);
	});
});

describe("encodeBmp", () => {
	it("writes a valid uncompressed 8-bit file: header, grey palette, rows padded to 4 bytes and stored bottom-up", () => {
		const b = encodeBmp({ data: Uint8Array.from([1, 2, 3, 4, 5, 10, 20, 30, 40, 50]), w: 5, h: 2 });
		const dv = new DataView(b.buffer);
		expect(String.fromCharCode(b[0], b[1])).toBe("BM");
		expect(dv.getUint32(2, true)).toBe(b.length);
		expect(dv.getInt32(18, true)).toBe(5);
		expect(dv.getInt32(22, true)).toBe(2);
		expect(dv.getUint16(28, true)).toBe(8);
		expect(b[54 + 77 * 4]).toBe(77); // grey palette
		const off = dv.getUint32(10, true);
		expect(b.length).toBe(off + 8 * 2);
		expect(Array.from(b.slice(off, off + 5))).toEqual([10, 20, 30, 40, 50]); // the LAST row of the picture comes first
		expect(Array.from(b.slice(off + 8, off + 13))).toEqual([1, 2, 3, 4, 5]);
	});
});
