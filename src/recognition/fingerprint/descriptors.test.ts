import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARD_H, CARD_W, DESCRIPTORS, DESCRIPTOR_DIMS, LOOK_DIM, describeBothWays, describeCard, lookBothWays, lookOfCard, planesOf, turnHalf, type DescriptorName } from "./descriptors";
import { syntheticCard } from "./__tests__/fingerprint-scenes";

// Written by tools/android/probes/card-scan/fingerprint/golden.mjs with the MEASUREMENT KIT's descriptors (fp-lib.mjs, the code every result of docs/history/card-recognition-spike.md was
// measured with and the code the data job runs): three synthetic cards and their hog / tinylum / dct vectors. The plugin's port must give the same numbers.
const golden = JSON.parse(readFileSync(new URL("./fingerprint.golden.json", import.meta.url), "utf8")) as {
	cards: ({ seed: number; look: number[] } & Record<DescriptorName, number[]>)[];
};

describe("descriptors (port of the kit's fp-lib)", () => {
	it("gives the sizes the base's format counts on", () => {
		const d = describeCard(syntheticCard(1));
		for (const name of DESCRIPTORS) expect(d[name].length).toBe(DESCRIPTOR_DIMS[name]);
		expect(DESCRIPTOR_DIMS).toEqual({ hog: 192, tinylum: 280, dct: 111 });
	});

	it("gives the kit's numbers on the golden cards", () => {
		expect(golden.cards.length).toBe(3);
		for (const g of golden.cards) {
			const d = describeCard(syntheticCard(g.seed));
			for (const name of DESCRIPTORS) {
				expect(d[name].length).toBe(g[name].length);
				let worst = 0;
				for (let i = 0; i < g[name].length; i++) worst = Math.max(worst, Math.abs(d[name][i] - g[name][i]));
				expect(worst, `card ${g.seed} ${name}`).toBeLessThan(1e-4);
			}
		}
	});

	it("gives the kit's whole-card look on the golden cards (the printings of one artwork are told apart by it)", () => {
		for (const g of golden.cards) {
			const look = lookOfCard(syntheticCard(g.seed));
			expect(look.length).toBe(LOOK_DIM);
			let worst = 0;
			for (let i = 0; i < LOOK_DIM; i++) worst = Math.max(worst, Math.abs(look[i] - g.look[i]));
			expect(worst, `card ${g.seed} look`).toBeLessThan(1e-4);
		}
		const [up, down] = lookBothWays(syntheticCard(1));
		expect(up.length).toBe(LOOK_DIM);
		expect(Math.max(...up.map((x, i) => Math.abs(x - down[i])))).toBeGreaterThan(0.01);
	});

	it("normalises what it should: the gradient histogram and the DCT parts are unit length, the 20 x 14 luminance has mean 0 and variance 1", () => {
		const d = describeCard(syntheticCard(2));
		const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
		expect(norm(d.hog)).toBeCloseTo(1, 4);
		expect(norm(d.dct.subarray(0, 63))).toBeCloseTo(1, 4);
		expect(norm(d.dct.subarray(63, 87))).toBeCloseTo(Math.SQRT1_2, 4);
		expect(norm(d.dct.subarray(87))).toBeCloseTo(Math.SQRT1_2, 4);
		const mean = d.tinylum.reduce((s, x) => s + x, 0) / d.tinylum.length;
		const variance = d.tinylum.reduce((s, x) => s + (x - mean) ** 2, 0) / d.tinylum.length;
		expect(mean).toBeCloseTo(0, 4);
		expect(variance).toBeCloseTo(1, 4);
	});

	it("describes the card turned half a turn as the card read upside down: not the same numbers as upright, the same as describing the turned picture", () => {
		const rgb = syntheticCard(3);
		const [up, down] = describeBothWays(rgb);
		const turned = new Uint8Array(rgb.length);
		for (let i = 0; i < CARD_W * CARD_H; i++) turned.set(rgb.subarray((CARD_W * CARD_H - 1 - i) * 3, (CARD_W * CARD_H - i) * 3), i * 3);
		const direct = describeCard(turned);
		let differs = 0;
		let worst = 0;
		for (let i = 0; i < up.hog.length; i++) {
			differs = Math.max(differs, Math.abs(up.hog[i] - down.hog[i]));
			worst = Math.max(worst, Math.abs(down.hog[i] - direct.hog[i]));
		}
		expect(differs).toBeGreaterThan(0.01);
		expect(worst).toBeLessThan(1e-5);
	});

	it("turnHalf twice is the identity", () => {
		const p = planesOf(syntheticCard(4));
		const back = turnHalf(turnHalf(p));
		expect(Array.from(back.G)).toEqual(Array.from(p.G));
	});
});
