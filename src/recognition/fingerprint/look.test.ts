import { describe, expect, it } from "vitest";
import type { Quad } from "../card-finder";
import { cardCorners } from "../__tests__/scenes";
import { LOOK_DIM, lookOfCard } from "./descriptors";
import { lookDistance, lookQueries, rankByLook } from "./look";
import { renderCanvas, renderPhoto } from "./__tests__/fingerprint-scenes";

describe("look", { timeout: 60_000 }, () => {
	const c = cardCorners(240, 320, 280, 391, 3);
	const quad: Quad = [c[0], c[1], c[2], c[3]];
	const photo = renderPhoto(11, quad, 480, 640);

	it("makes one look per alignment hypothesis and orientation", () => {
		const q = lookQueries(photo, quad);
		expect(q.length).toBe(4);
		for (const look of q) expect(look.length).toBe(LOOK_DIM);
		expect(lookQueries(photo, quad, [0]).length).toBe(2);
	});

	it("measures the smallest distance to the photo's looks", () => {
		const a = Float32Array.from([1, 0, 0]);
		const b = Float32Array.from([0, 1, 0]);
		expect(lookDistance([a, b], Float32Array.from([0, 1, 0]))).toBe(0);
		expect(lookDistance([a], Float32Array.from([0, 1, 0]))).toBeCloseTo(Math.SQRT2, 6);
	});

	it("puts the printing that looks like the photo first, the ones with no picture last in their own order, and keeps ties in order", () => {
		const queries = lookQueries(photo, quad);
		const same = renderCanvas(11, 0);
		const other = renderCanvas(11, 1);
		const ranked = rankByLook(queries, [
			{ item: "no-picture-1", rgb: null },
			{ item: "other", rgb: other },
			{ item: "same", rgb: same },
			{ item: "no-picture-2", rgb: null },
			{ item: "same-again", rgb: same },
		]);
		expect(ranked).toEqual(["same", "same-again", "other", "no-picture-1", "no-picture-2"]);
		// nothing to compare with: everything keeps its place
		expect(rankByLook([], [{ item: "x", rgb: same }, { item: "y", rgb: other }])).toEqual(["x", "y"]);
	});

	it("looks of two different printings of one artwork are not the same", () => {
		const a = lookOfCard(renderCanvas(11, 0));
		const b = lookOfCard(renderCanvas(11, 1));
		expect(lookDistance([a], b)).toBeGreaterThan(0.05);
	});
});
