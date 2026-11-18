// A card of a photo straightened to the 96 x 134 picture the descriptors are computed on. Pure: typed arrays in, typed arrays out (no canvas). PRIVATE like the rest of src/recognition/.
// Port of the measurement kit's `rectify.mjs` / `phone-bench.mjs` `warp` (the code the results of docs/history/card-recognition-spike.md were measured with).

import type { Quad } from "../card-finder";
import type { Photo } from "../scan";
import { homography } from "../strips";
import { CARD_H, CARD_W } from "./descriptors";

/** Taps per output pixel along each axis: 4 x 4 bilinear samples, i.e. the average of the ~12 x 13 photo pixels a 96 x 134 pixel covers (a plain bilinear sample would alias). */
const TAPS = 4;

/**
 * The card inside `quad` (TL TR BR BL in the photo's pixels, as the finder answers it) as 96 x 134 RGB, bytes row after row. `expand` is the share of the card's width and height added on each
 * side: 0 is the quad as found; 0.04 reaches out to the card's own edge when the finder framed the picture INSIDE the black border (the plan tries both, `database.ts`).
 */
export function warpCard(photo: Photo, quad: Quad, expand: number): Uint8Array {
	const H = homography(
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
		quad,
	);
	const d = photo.rgba;
	const { w, h } = photo;
	const out = new Uint8Array(CARD_W * CARD_H * 3);
	const span = 1 + 2 * expand;
	const taps = TAPS * TAPS;
	for (let v = 0; v < CARD_H; v++)
		for (let u = 0; u < CARD_W; u++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (let sy = 0; sy < TAPS; sy++)
				for (let sx = 0; sx < TAPS; sx++) {
					const cx = -expand + (span * (u + (sx + 0.5) / TAPS)) / CARD_W;
					const cy = -expand + (span * (v + (sy + 0.5) / TAPS)) / CARD_H;
					const q = H[6] * cx + H[7] * cy + 1;
					const px = (H[0] * cx + H[1] * cy + H[2]) / q;
					const py = (H[3] * cx + H[4] * cy + H[5]) / q;
					// bilinear, the edge pixels repeated outside the photo
					const fx = Math.min(w - 1.001, Math.max(0, px - 0.5));
					const fy = Math.min(h - 1.001, Math.max(0, py - 0.5));
					const x0 = Math.floor(fx);
					const y0 = Math.floor(fy);
					const ax = fx - x0;
					const ay = fy - y0;
					const i = (y0 * w + x0) * 4;
					const j = i + w * 4;
					const w00 = (1 - ax) * (1 - ay);
					const w10 = ax * (1 - ay);
					const w01 = (1 - ax) * ay;
					const w11 = ax * ay;
					r += d[i] * w00 + d[i + 4] * w10 + d[j] * w01 + d[j + 4] * w11;
					g += d[i + 1] * w00 + d[i + 5] * w10 + d[j + 1] * w01 + d[j + 5] * w11;
					b += d[i + 2] * w00 + d[i + 6] * w10 + d[j + 2] * w01 + d[j + 6] * w11;
				}
			const o = (v * CARD_W + u) * 3;
			out[o] = Math.round(r / taps);
			out[o + 1] = Math.round(g / taps);
			out[o + 2] = Math.round(b / taps);
		}
	return out;
}
