// Scenes drawn in the tests (no photo in the repository): a card is a convex quad with a border colour and an inner frame colour on a background.
// NOT a test file: shared by card-finder.test.ts and scan.test.ts, in a __tests__ folder so that the directory's scanner skips it.
import type { Point } from "../card-finder";

export function inside(poly: Point[], x: number, y: number): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % 4];
		const z = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
		if (sign === 0) sign = Math.sign(z);
		else if (z !== 0 && Math.sign(z) !== sign) return false;
	}
	return true;
}

/** A rectangle w x h centred at (cx, cy), turned by `deg`, as clockwise corners TL TR BR BL. */
export function cardCorners(cx: number, cy: number, w: number, h: number, deg: number): Point[] {
	const a = (deg * Math.PI) / 180;
	return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as Point[]).map(([x, y]): Point => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]);
}

export interface SceneOptions {
	bg: number;
	border: number;
	frame: number;
	corners: Point[];
	borderWidth?: number;
	paint?: (x: number, y: number, v: number) => number;
	/** picture size, 240 x 320 by default */
	w?: number;
	h?: number;
}

/** Grey RGBA pixels of the scene. */
export function scene(opts: SceneOptions): Uint8ClampedArray {
	const W = opts.w ?? 240;
	const H = opts.h ?? 320;
	const px = new Uint8ClampedArray(W * H * 4);
	const c = opts.corners;
	const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4;
	const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
	const k = 1 - (2 * (opts.borderWidth ?? 8)) / Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
	const innerCorners = c.map(([x, y]): Point => [cx + (x - cx) * k, cy + (y - cy) * k]);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			// a faint gradient and a little texture, so that the picture is not perfectly flat
			let v = opts.bg + (x / W) * 12 + ((x * 7 + y * 13) % 5) - 2;
			if (inside(c, x, y)) v = inside(innerCorners, x, y) ? opts.frame + (((x >> 2) + (y >> 2)) % 2 ? 10 : -10) : opts.border;
			if (opts.paint) v = opts.paint(x, y, v);
			const i = (y * W + x) * 4;
			px[i] = px[i + 1] = px[i + 2] = v;
			px[i + 3] = 255;
		}
	return px;
}
