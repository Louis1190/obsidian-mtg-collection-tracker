import { describe, expect, it } from "vitest";
import type { Quad } from "../card-finder";
import { cardCorners } from "../__tests__/scenes";
import { CARD_H, CARD_W } from "./descriptors";
import { renderCanvas, renderPhoto } from "./__tests__/fingerprint-scenes";
import { warpCard } from "./warp";

const W = 480;
const H = 640;
const quadOf = (c: ReturnType<typeof cardCorners>): Quad => [c[0], c[1], c[2], c[3]];
const meanAbs = (a: Uint8Array, b: Uint8Array): number => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
	return s / a.length;
};

describe("warpCard", () => {
	it("straightens a turned, slanted card back to the picture it was drawn from", () => {
		const corners = cardCorners(240, 320, 280, 391, 7);
		corners[2][0] += 12; // a little perspective
		corners[3][0] -= 7;
		const photo = renderPhoto(5, quadOf(corners), W, H);
		const out = warpCard(photo, quadOf(corners), 0);
		expect(out.length).toBe(CARD_W * CARD_H * 3);
		// the photo is drawn at about 3 times the picture's size with hard edges: a few grey levels of difference is the resampling, not a misplacement
		expect(meanAbs(out, renderCanvas(5))).toBeLessThan(8);
	});

	it("a card turned half a turn gives the picture turned half a turn", () => {
		const corners = cardCorners(240, 320, 280, 391, 0);
		const upright = warpCard(renderPhoto(6, quadOf(corners), W, H), quadOf(corners), 0);
		// the same card, drawn turned by 180 degrees, straightened with the corners in the order the finder would give them (TL of the picture first)
		const turned = cardCorners(240, 320, 280, 391, 180);
		const photo = renderPhoto(6, [turned[2], turned[3], turned[0], turned[1]], W, H);
		const out = warpCard(photo, quadOf(turned), 0);
		const flipped = new Uint8Array(upright.length);
		for (let i = 0; i < CARD_W * CARD_H; i++) flipped.set(upright.subarray((CARD_W * CARD_H - 1 - i) * 3, (CARD_W * CARD_H - i) * 3), i * 3);
		expect(meanAbs(out, flipped)).toBeLessThan(8);
	});

	it("expand reaches past the card's edge: more of the table at the borders, the same card in the middle", () => {
		const corners = cardCorners(240, 320, 280, 391, 0);
		const photo = renderPhoto(7, quadOf(corners), W, H);
		const tight = warpCard(photo, quadOf(corners), 0);
		const wide = warpCard(photo, quadOf(corners), 0.04);
		const px = (a: Uint8Array, x: number, y: number) => a[(y * CARD_W + x) * 3];
		// the top-left pixel: black border without expansion, the light table with it
		expect(px(tight, 1, 1)).toBeLessThan(40);
		expect(px(wide, 1, 1)).toBeGreaterThan(150);
		// the card is smaller in the wide picture: its centre is still the card's centre
		expect(Math.abs(px(wide, CARD_W >> 1, CARD_H >> 1) - px(tight, CARD_W >> 1, CARD_H >> 1))).toBeLessThan(60);
	});
});
