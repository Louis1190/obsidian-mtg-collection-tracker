// Image fingerprint of a card: three small descriptors of its ARTWORK, computed on the card straightened to 96 x 134 pixels (see warp.ts). Pure (typed arrays in, typed arrays out): no canvas,
// no DOM, nothing Obsidian. PRIVATE like the rest of src/recognition/ (docs/history/card-recognition-fingerprint-plan.md).
//
// The descriptors are a port of the measurement kit's (tools/android/probes/card-scan/fingerprint/fp-lib.mjs, the code every result of docs/history/card-recognition-spike.md was
// measured with); `fingerprint.golden.json`, written by that kit's golden.mjs, keeps the two in step: change one, change the other, then rerun golden.mjs. The DATA JOB that builds the
// downloaded base computes the same descriptors with the kit's code, so a change here is a change of the base's format (bump the index version).
//
//   hog      gradient orientation histogram of the luminance, 6 x 4 cells x 8 orientations, square-rooted and normalised   (192 values)
//   tinylum  the luminance as a 20 x 14 picture, standardised                                                               (280 values)
//   dct      a 8 x 8 DCT of the luminance (32 x 24) and 5 x 5 of Cb and Cr (16 x 12), each part normalised, DC dropped    (111 values)
//
// All three are compared with a plain L2 distance and fused (database.ts). The artwork region is the same fraction of every card, so it does not depend on the frame's era.

export const CARD_W = 96;
export const CARD_H = 134;
export type DescriptorName = "hog" | "tinylum" | "dct";
export const DESCRIPTORS: readonly DescriptorName[] = ["hog", "tinylum", "dct"];
export const DESCRIPTOR_DIMS: Readonly<Record<DescriptorName, number>> = { hog: 192, tinylum: 280, dct: 111 };
export type Descriptors = Record<DescriptorName, Float32Array>;

interface Planes {
	R: Float32Array;
	G: Float32Array;
	B: Float32Array;
}

/** The artwork window of the card, in canvas pixels: x from 10 to 90 %, y from 12.5 to 53.5 % (a little inside every frame's art box, so a few percent of misalignment still lands on art). */
const ART: [number, number, number, number] = [0.1 * CARD_W, 0.125 * CARD_H, 0.9 * CARD_W, 0.535 * CARD_H];

/** The planes of a 96 x 134 RGB picture (3 bytes per pixel, row after row). */
export function planesOf(rgb: Uint8Array): Planes {
	const n = CARD_W * CARD_H;
	const R = new Float32Array(n);
	const G = new Float32Array(n);
	const B = new Float32Array(n);
	for (let i = 0, j = 0; i < n; i++, j += 3) {
		R[i] = rgb[j];
		G[i] = rgb[j + 1];
		B[i] = rgb[j + 2];
	}
	return { R, G, B };
}

/** The same card seen upside down (the finder cannot tell which short side is the top). */
export function turnHalf(p: Planes): Planes {
	return { R: Float32Array.from(p.R).reverse(), G: Float32Array.from(p.G).reverse(), B: Float32Array.from(p.B).reverse() };
}

function mix(p: Planes, a: number, b: number, c: number): Float32Array {
	const out = new Float32Array(CARD_W * CARD_H);
	for (let i = 0; i < out.length; i++) out[i] = a * p.R[i] + b * p.G[i] + c * p.B[i];
	return out;
}

/** The average of the pixels each of the ow x oh cells covers in the window [x0, x1] x [y0, y1] (fractional edges weighted). */
function resample(p: Float32Array, x0: number, y0: number, x1: number, y1: number, ow: number, oh: number): Float32Array {
	const out = new Float32Array(ow * oh);
	for (let j = 0; j < oh; j++) {
		const sy0 = y0 + ((y1 - y0) * j) / oh;
		const sy1 = y0 + ((y1 - y0) * (j + 1)) / oh;
		for (let i = 0; i < ow; i++) {
			const sx0 = x0 + ((x1 - x0) * i) / ow;
			const sx1 = x0 + ((x1 - x0) * (i + 1)) / ow;
			let acc = 0;
			let wsum = 0;
			for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) {
				const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
				for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
					const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
					acc += p[Math.min(CARD_H - 1, Math.max(0, y)) * CARD_W + Math.min(CARD_W - 1, Math.max(0, x))] * wx * wy;
					wsum += wx * wy;
				}
			}
			out[j * ow + i] = acc / wsum;
		}
	}
	return out;
}

function standardize(v: Float32Array): Float32Array {
	let m = 0;
	for (const x of v) m += x;
	m /= v.length;
	let s = 0;
	for (const x of v) s += (x - m) ** 2;
	s = Math.sqrt(s / v.length) || 1;
	return v.map((x) => (x - m) / s);
}

function unit(v: Float32Array): Float32Array {
	let s = 0;
	for (const x of v) s += x * x;
	s = Math.sqrt(s) || 1;
	return v.map((x) => x / s);
}

function cosines(n: number, k: number): Float32Array[] {
	const table: Float32Array[] = [];
	for (let u = 0; u < k; u++) {
		const row = new Float32Array(n);
		for (let x = 0; x < n; x++) row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
		table.push(row);
	}
	return table;
}
const C32 = cosines(32, 8);
const C24 = cosines(24, 8);
const C16 = cosines(16, 5);
const C12 = cosines(12, 5);

/** The k x k lowest DCT coefficients of a w x h picture, the DC one dropped. */
function dct(img: Float32Array, w: number, h: number, k: number, cw: Float32Array[], ch: Float32Array[]): Float32Array {
	const out: number[] = [];
	for (let v = 0; v < k; v++)
		for (let u = 0; u < k; u++) {
			if (u === 0 && v === 0) continue;
			let acc = 0;
			for (let y = 0; y < h; y++) {
				let row = 0;
				for (let x = 0; x < w; x++) row += img[y * w + x] * cw[u][x];
				acc += row * ch[v][y];
			}
			out.push(acc);
		}
	return Float32Array.from(out);
}

function hog(img: Float32Array, w: number, h: number, cx: number, cy: number, bins: number): Float32Array {
	const out = new Float32Array(cx * cy * bins);
	for (let y = 1; y < h - 1; y++)
		for (let x = 1; x < w - 1; x++) {
			const gx = img[y * w + x + 1] - img[y * w + x - 1];
			const gy = img[(y + 1) * w + x] - img[(y - 1) * w + x];
			const mag = Math.hypot(gx, gy);
			let ang = Math.atan2(gy, gx);
			if (ang < 0) ang += Math.PI;
			if (ang >= Math.PI) ang -= Math.PI;
			const b = Math.min(bins - 1, Math.floor((ang / Math.PI) * bins));
			out[(Math.min(cy - 1, Math.floor((y * cy) / h)) * cx + Math.min(cx - 1, Math.floor((x * cx) / w))) * bins + b] += mag;
		}
	return unit(out.map((v) => Math.sqrt(v)));
}

function concat(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((n, v) => n + v.length, 0));
	let k = 0;
	for (const v of parts) {
		out.set(v, k);
		k += v.length;
	}
	return out;
}

/** The three descriptors of the planes of a card. */
export function describePlanes(p: Planes): Descriptors {
	const L = mix(p, 0.299, 0.587, 0.114);
	const Cb = mix(p, -0.1687, -0.3313, 0.5);
	const Cr = mix(p, 0.5, -0.4187, -0.0813);
	const l = dct(resample(L, ...ART, 32, 24), 32, 24, 8, C32, C24);
	const a = dct(resample(Cb, ...ART, 16, 12), 16, 12, 5, C16, C12);
	const b = dct(resample(Cr, ...ART, 16, 12), 16, 12, 5, C16, C12);
	return {
		hog: hog(resample(L, ...ART, 48, 34), 48, 34, 6, 4, 8),
		tinylum: standardize(resample(L, ...ART, 20, 14)),
		dct: concat(
			unit(l),
			unit(a).map((x) => x * Math.SQRT1_2),
			unit(b).map((x) => x * Math.SQRT1_2),
		),
	};
}

/**
 * The "look" of the WHOLE card: gradient histogram of the luminance over the card minus a 3 % rim, 6 x 8 cells x 8 orientations (384 values). The artwork is the same on every printing that
 * reuses it, so what tells those printings apart is the frame, the border, the colours and the text box, which is what this sees (docs/history/card-recognition-spike.md, "L'empreinte d'image
 * et l'édition": 8/8 on the modern printings with 2-3 candidates, the border colour right on 10 of 14 old cards judged by eye).
 */
const FULL: [number, number, number, number] = [0.03 * CARD_W, 0.02 * CARD_H, 0.97 * CARD_W, 0.98 * CARD_H];
export const LOOK_DIM = 384;

export function lookOfPlanes(p: Planes): Float32Array {
	return hog(resample(mix(p, 0.299, 0.587, 0.114), ...FULL, 48, 68), 48, 68, 6, 8, 8);
}

/** The look of a straightened card (96 x 134 RGB). */
export function lookOfCard(rgb: Uint8Array): Float32Array {
	return lookOfPlanes(planesOf(rgb));
}

/** The look of the card as it lies and turned half a turn. */
export function lookBothWays(rgb: Uint8Array): [Float32Array, Float32Array] {
	const p = planesOf(rgb);
	return [lookOfPlanes(p), lookOfPlanes(turnHalf(p))];
}

/** The descriptors of a straightened card (96 x 134 RGB). */
export function describeCard(rgb: Uint8Array): Descriptors {
	return describePlanes(planesOf(rgb));
}

/** The descriptors of the card as it lies and as it would read turned half a turn: the two orientations a photo can have. */
export function describeBothWays(rgb: Uint8Array): [Descriptors, Descriptors] {
	const p = planesOf(rgb);
	return [describePlanes(p), describePlanes(turnHalf(p))];
}
