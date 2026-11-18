// Title strips: cut the strip of a card that holds its title out of a photo, straightened, and make the variants the OCR is given. Pure (no DOM, no
// Obsidian): typed arrays in, typed arrays out, so that nothing here goes through a canvas (`toBlob` costs 4 s on a phone WebView).
//
// The kit (tools/android/probes/card-scan/) did this with PIL in two resamplings (a bicubic warp of the whole card, then a Lanczos resize of the strip);
// here the strip is sampled straight from the photo through the card's perspective in ONE bicubic pass. The reading results of the two were compared
// on the 17 real photos (docs/history/card-recognition-spike.md).
//
// Card coordinates: (0,0) is the top-left corner of the quad found by the finder, (1,1) the bottom-right, y measured in shares of the quad's height.
// A strip is a window of the card, [x0,x1] x [y0,y1]; y may be negative (the frame found by the finder can stop inside the card: the strip then
// reaches above it, through the same perspective).

import type { Point, Quad } from "./card-finder";

export interface GrayImage {
	data: Uint8Array;
	w: number;
	h: number;
}

/** Luminance as PIL's "L" conversion (0.299 R + 0.587 G + 0.114 B), from the pixels of an ImageData. */
export function toGray(rgba: ArrayLike<number>, w: number, h: number): GrayImage {
	const data = new Uint8Array(w * h);
	for (let i = 0, j = 0; i < w * h; i++, j += 4) data[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
	return { data, w, h };
}

/** What a strip is cut from: the luminance (what the title readings were made of until the colour experiment of Round 8) or ONE colour channel of the photo. */
export type Channel = "L" | "R" | "G" | "B";

/**
 * One colour channel of the pixels of an ImageData as an image (`L`: the luminance, as `toGray`). A title in dark text on a COLOURED bar (the frames of 1993: Lightning Bolt, Llanowar
 * Elves, Nicol Bolas) loses most of its contrast in the luminance, which mixes the channels, and keeps it in one of them: the red channel of a dark red title on a red bar, the blue one of
 * a dark text on a yellow one.
 */
export function toChannel(rgba: ArrayLike<number>, w: number, h: number, channel: Channel): GrayImage {
	if (channel === "L") return toGray(rgba, w, h);
	const offset = channel === "R" ? 0 : channel === "G" ? 1 : 2;
	const data = new Uint8Array(w * h);
	for (let i = 0, j = offset; i < w * h; i++, j += 4) data[i] = rgba[j];
	return { data, w, h };
}

/**
 * The 8 coefficients (a..h) of the perspective map (x, y) -> ((a x + b y + c) / (g x + h y + 1), (d x + e y + f) / (g x + h y + 1)) that sends each
 * `from[i]` to `to[i]` (four pairs): Gauss elimination of the 8x8 system, as in the kit.
 */
export function homography(from: Point[], to: Point[]): number[] {
	const rows: number[][] = [];
	for (let i = 0; i < 4; i++) {
		const [x, y] = from[i];
		const [u, v] = to[i];
		rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
		rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
	}
	for (let c = 0; c < 8; c++) {
		let piv = c;
		for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[piv][c])) piv = r;
		[rows[c], rows[piv]] = [rows[piv], rows[c]];
		for (let r = 0; r < 8; r++) {
			if (r === c) continue;
			const f = rows[r][c] / rows[c][c];
			for (let k = c; k < 9; k++) rows[r][k] -= f * rows[c][k];
		}
	}
	return rows.map((row, i) => row[8] / row[i]);
}

function apply(H: number[], x: number, y: number): Point {
	const d = H[6] * x + H[7] * y + 1;
	return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

export interface StripOptions {
	/** window of the card, in card coordinates; the defaults are the title strip measured on real cards */
	x0?: number;
	x1?: number;
	y0?: number;
	y1?: number;
	/** width of the strip in pixels (the OCR reads best around 1100) */
	outW?: number;
	/** 2: read the card upside down (start the quad at the opposite corner); the finder cannot tell which short side is the top */
	roll?: 0 | 2;
}

/** Catmull-Rom weights of the four pixels around a sample at fraction t (0..1) between the middle two. */
/** Exported for the tests only. */
export function catmullRom(t: number, out: number[]): void {
	const t2 = t * t;
	const t3 = t2 * t;
	out[0] = -0.5 * t3 + t2 - 0.5 * t;
	out[1] = 1.5 * t3 - 2.5 * t2 + 1;
	out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
	out[3] = 0.5 * t3 - 0.5 * t2;
}

/** The title strip of a standard card: from 4 % to 84 % of its width, from 3.5 % to 10.5 % of its height. */
export const TITLE_STRIP = { x0: 0.04, x1: 0.84, y0: 0.035, y1: 0.105, outW: 1100 };
/** The tall strip read as sparse text: from 5 % above the quad's top to 19 % below it (the title wherever the frame found put it). */
export const TALL_STRIP = { x0: 0.04, x1: 0.84, y0: -0.05, y1: 0.19, outW: 1100 };

/** Physical card: 63 x 88 mm. The strip's height in pixels follows from its window so that letters keep their shape. */
const CARD_W_MM = 63;
const CARD_H_MM = 88;

/**
 * The strip of a card cut out of a photo, as luminance. `quad` is in the photo's pixels, TL TR BR BL, as findCard answers it (long side vertical).
 * Sampled bicubically (Catmull-Rom) through the card's perspective; outside the photo the nearest edge pixel is used.
 */
export function extractStrip(photo: GrayImage, quad: Quad, opts: StripOptions = {}): GrayImage {
	const o = { ...TITLE_STRIP, ...opts };
	const roll = opts.roll ?? 0;
	const q: Point[] = roll ? [quad[2], quad[3], quad[0], quad[1]] : [quad[0], quad[1], quad[2], quad[3]];
	const H = homography(
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
		q,
	);
	const outH = Math.max(8, Math.round((o.outW * (o.y1 - o.y0) * CARD_H_MM) / ((o.x1 - o.x0) * CARD_W_MM)));
	const out = new Uint8Array(o.outW * outH);
	const { data, w, h } = photo;
	const sample = (x: number, y: number): number => data[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
	const wx = [0, 0, 0, 0];
	const wy = [0, 0, 0, 0];
	for (let v = 0; v < outH; v++) {
		const cy = o.y0 + ((o.y1 - o.y0) * (v + 0.5)) / outH;
		for (let u = 0; u < o.outW; u++) {
			const cx = o.x0 + ((o.x1 - o.x0) * (u + 0.5)) / o.outW;
			const [px, py] = apply(H, cx, cy);
			const fx = px - 0.5;
			const fy = py - 0.5;
			const x0 = Math.floor(fx);
			const y0 = Math.floor(fy);
			catmullRom(fx - x0, wx);
			catmullRom(fy - y0, wy);
			// bicubic: a 4 x 4 neighbourhood, edge pixels repeated outside the photo (bilinear softened the letters by about 15 % against PIL's bicubic + Lanczos)
			let acc = 0;
			for (let j = 0; j < 4; j++) {
				const yy = y0 - 1 + j;
				acc += wy[j] * (wx[0] * sample(x0 - 1, yy) + wx[1] * sample(x0, yy) + wx[2] * sample(x0 + 1, yy) + wx[3] * sample(x0 + 2, yy));
			}
			out[v * o.outW + u] = acc <= 0 ? 0 : acc >= 255 ? 255 : Math.round(acc);
		}
	}
	return { data: out, w: o.outW, h: outH };
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Box blur of the given radius along rows then columns, edge pixels repeated (a running sum: the cost does not depend on the radius). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	const size = 2 * r + 1;
	for (let y = 0; y < h; y++) {
		const row = y * w;
		let sum = 0;
		for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
		for (let x = 0; x < w; x++) {
			tmp[row + x] = sum / size;
			sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
		}
	}
	for (let x = 0; x < w; x++) {
		let sum = 0;
		for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
		for (let y = 0; y < h; y++) {
			out[y * w + x] = sum / size;
			sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
		}
	}
	return out;
}

/** Gaussian blur of standard deviation `sigma` as three box blurs (what PIL's GaussianBlur does too). */
export function gaussianBlur(img: GrayImage, sigma: number): Float32Array {
	// box widths whose three passes have the variance of a Gaussian (the classic "boxes for gauss" construction)
	const n = 3;
	const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
	let wl = Math.floor(wIdeal);
	if (wl % 2 === 0) wl--;
	const wu = wl + 2;
	const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
	let cur: Float32Array = Float32Array.from(img.data);
	for (let i = 0; i < n; i++) cur = boxBlur(cur, img.w, img.h, ((i < m ? wl : wu) - 1) / 2);
	return cur;
}

export type StripVariant = "asis" | "inv" | "thlight" | "thdark" | "thabs";
/** In the order they are worth trying first (measured: `asis` and `thabs` cover most photos between them). */
export const STRIP_VARIANTS: StripVariant[] = ["asis", "thabs", "inv", "thlight", "thdark"];

const BLUR_SIGMA = 18;

/**
 * The versions of a strip the OCR is given. The OCR wants dark text on a light ground, and cannot read an EMBOSSED title (a light edge on one side
 * of each letter, a dark one on the other: it sees half letters), so besides the strip as it is:
 *   inv     inverted, contrast 1.3 (light letters on a dark banner become dark on light);
 *   thlight each pixel against the blurred picture around it, letters LIGHTER than their surroundings -> dark;
 *   thdark  the same for letters DARKER than their surroundings;
 *   thabs   |pixel - local mean|, inverted: merges the light edge and the dark edge of an embossed letter into one stroke.
 */
export function stripVariant(strip: GrayImage, variant: StripVariant): GrayImage {
	const { data, w, h } = strip;
	const out = new Uint8Array(w * h);
	if (variant === "asis") {
		out.set(data);
	} else if (variant === "inv") {
		for (let i = 0; i < out.length; i++) out[i] = clamp255(Math.round((255 - data[i] - 127.5) * 1.3 + 127.5));
	} else {
		const bg = gaussianBlur(strip, BLUR_SIGMA);
		// PIL works on integers: the blurred picture is rounded to a byte before the comparison
		for (let i = 0; i < out.length; i++) {
			const g = data[i];
			const b = Math.round(bg[i]);
			if (variant === "thlight") out[i] = 255 - clamp255(128 + 4 * (g - b));
			else if (variant === "thdark") out[i] = 255 - clamp255(128 + 4 * (b - g));
			else out[i] = 255 - clamp255(4 * Math.abs(g - b));
		}
	}
	return { data: out, w, h };
}

/**
 * An uncompressed 8-bit BMP (with a grey palette) of a luminance image: the OCR engine reads it from memory, so the picture never has to be
 * encoded by a canvas. Rows are padded to 4 bytes and stored bottom-up, as the format wants.
 */
export function encodeBmp(img: GrayImage): Uint8Array {
	const { data, w, h } = img;
	const rowSize = (w + 3) & ~3;
	const pixelOffset = 14 + 40 + 256 * 4;
	const out = new Uint8Array(pixelOffset + rowSize * h);
	const dv = new DataView(out.buffer);
	out[0] = 0x42;
	out[1] = 0x4d;
	dv.setUint32(2, out.length, true);
	dv.setUint32(10, pixelOffset, true);
	dv.setUint32(14, 40, true); // BITMAPINFOHEADER
	dv.setInt32(18, w, true);
	dv.setInt32(22, h, true); // positive: bottom-up
	dv.setUint16(26, 1, true);
	dv.setUint16(28, 8, true);
	dv.setUint32(34, rowSize * h, true);
	dv.setUint32(46, 256, true);
	for (let i = 0; i < 256; i++) {
		const o = 54 + i * 4;
		out[o] = out[o + 1] = out[o + 2] = i;
	}
	for (let y = 0; y < h; y++) out.set(data.subarray(y * w, (y + 1) * w), pixelOffset + (h - 1 - y) * rowSize);
	return out;
}
