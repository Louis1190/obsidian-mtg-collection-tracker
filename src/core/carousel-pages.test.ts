import { describe, expect, it } from "vitest";
import { nearestPage, pageOffsets } from "./carousel-pages";

// A 365px row of 82 %-wide tiles with an 8px gap: tile starts at 0, 307.3, 614.6, 921.9.
const TILE = 299.3;
const GAP = 8;
const lefts = (n: number) => Array.from({ length: n }, (_, i) => 100 + i * (TILE + GAP));
const maxFor = (n: number) => n * TILE + (n - 1) * GAP - 365;

describe("pageOffsets", () => {
	it("starts every page at its tile, relative to the first", () => {
		const offsets = pageOffsets(lefts(4), 10_000);
		expect(offsets[0]).toBe(0);
		expect(offsets[1]).toBeCloseTo(TILE + GAP);
		expect(offsets[2]).toBeCloseTo(2 * (TILE + GAP));
	});

	it("stops the last page at the end of the scroll range", () => {
		const max = maxFor(4);
		const offsets = pageOffsets(lefts(4), max);
		expect(offsets[3]).toBe(max);
		// the middle pages stay on their own tile, not spread evenly over the range
		expect(offsets[1]).toBeCloseTo(TILE + GAP);
		expect(offsets[1]).not.toBeCloseTo(max / 3, 0);
	});

	it("with two tiles is the start and the end, as the even split gave", () => {
		const max = maxFor(2);
		expect(pageOffsets(lefts(2), max)).toEqual([0, max]);
	});

	it("is empty without tiles and never negative", () => {
		expect(pageOffsets([], 100)).toEqual([]);
		expect(pageOffsets([50, 40], 100)).toEqual([0, 0]);
	});
});

describe("nearestPage", () => {
	const offsets = pageOffsets(lefts(4), maxFor(4));

	it("reads each page at its own start", () => {
		offsets.forEach((offset, page) => expect(nearestPage(offset, offsets)).toBe(page));
	});

	it("rounds to the closest start", () => {
		expect(nearestPage(offsets[1] - 20, offsets)).toBe(1);
		expect(nearestPage(offsets[1] + 20, offsets)).toBe(1);
		expect(nearestPage(offsets[1] + 0.6 * (offsets[2] - offsets[1]), offsets)).toBe(2);
	});

	it("is the first page when there is nothing to scroll", () => {
		expect(nearestPage(0, [0, 0, 0])).toBe(0);
		expect(nearestPage(0.4, [0, 0.5])).toBe(0);
		expect(nearestPage(0, [])).toBe(0);
	});

	it("puts the end of the range on the last page when several pages clamp to it", () => {
		expect(nearestPage(500, [0, 300, 500, 500])).toBe(3);
	});
});
