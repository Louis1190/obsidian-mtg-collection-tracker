// Card finder: the four corners of a Magic card in a photo. Pure (no DOM, no Obsidian), no library, no network: it takes the pixels of a
// small picture (about 360 px wide, from a canvas `getImageData`; never `toBlob`, which costs 4 s on a phone WebView) and answers corners.
//
// Ported from the measurement kit (tools/android/probes/card-scan/card-finder.js, same operations in the same order: the port is proven
// identical on the real photos and the synthetic set, see docs/history/card-recognition-spike.md). Do not "improve" a threshold here without
// re-running the kit's benches: every constant below was measured.
//
//   const r = findCard(rgba, w, h);
//   r === null            too few edges in the picture
//   r.quad === null       edges but no card-shaped rectangle
//   r.quad                TL, TR, BR, BL in the pixels of the picture given, the card seen upright if its long side is vertical (a card lying
//                         on its side is turned a quarter; a card upside down is NOT detected here: the title strip decides that)
//   r.polarity "out"      the card's edge is DARKER than what surrounds it (a dark border on a lighter table); "in": brighter
//   r.score               NOT a reliable "is there a card" signal (measured: a quad on 5 of 12 empty pictures, the scores overlap)
//
// How: luminance -> Sobel -> thin edges (non-maximum suppression) -> a Hough transform that keeps the SIGN of the gradient (every pixel votes
// only for lines whose normal is its own gradient direction, so a line has a polarity: the card's four sides all point away from the card, or all
// toward it) -> the strongest lines -> every set of two parallel pairs that are perpendicular to each other and shaped like a card (four real
// lines), or three real lines and a fourth DEDUCED from the card's 63x88 shape (a side that hardly shows) -> each side is scored by how much of it
// sits on a real edge of the right sign -> a quad whose sides go on past its corners is discounted (it stops short of the card: the picture box,
// the text box) -> the best distinct candidates have their sides re-fitted on the pixels they cover -> when a clearly bigger quad around the
// winner is nearly as good, it wins (the card's edge rather than the frame inside its border) -> when the winner is a frame INSIDE a dark border
// (polarity "in"), the card's own edge is looked for a little further out.

export type Point = [number, number];
/** Corners in the order TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];
export type Polarity = "out" | "in";

export const CARD_ASPECT = 63 / 88;

/** Every threshold was measured on real photos and synthetic composites; see the kit's history before touching one. */
export const FINDER_CONFIG = {
	edgeMinMag: 8, // Sobel/4: grey levels per pixel (a 60-level border blurred over 3 px reads ~20)
	edgeKeep: 0.2, // keep thin edges above this fraction of the 99th percentile of the thin edges
	thetaSpread: 6, // degrees around its own gradient direction a pixel votes for
	maxLines: 40,
	houghMagCap: 20, // an edge votes with at most this strength (grey levels per pixel; the edge floor is ~20): a white text box on black (100+) must not outvote a longer, fainter outline, which is what made it the answer
	houghMinVote: 0.07, // a line needs this share of the strongest line's votes: a card's own edge against a textured mat gets only 6 to 10 % of what a white text box on black does
	parallelTol: 14, // degrees: opposite sides
	perpTol: 20, // degrees: adjacent sides
	aspectMin: 0.69, // the card is 0.716 and the real photos' right quads measure 0.70-0.76; a modern card's text box (0.60-0.62, the strongest rectangle of the picture, whose re-fit may drift up to 0.02) won at 0.62
	aspectMax: 0.81,
	areaMin: 0.06, // of the picture
	areaMax: 0.92,
	margin: 0.03, // a corner may sit this far (of the width/height) outside the picture
	searchR: 3, // pixels, each side of a candidate line, where the real edge is looked for
	sideMinSupport: 0.4,
	refineTop: 12,
	outerMin: 0.012, // the card's edge is looked for from this share of its width outside the frame found...
	outerMax: 0.12, // ...to this one
	outerSupport: 0.6, // share of a side that must show it
	outerSpread: 0.04, // the border is about as wide on every side
	extendStrength: 0.5, // an edge past a corner must be this share as strong as the side to say the side goes on...
	extendStrengthRetry: 0.8, // ...and this much when that found no card (see findCard)
	encloseMaxRatio: 1.8, // a quad around the best one counts as the card when it is at most this much bigger...
	encloseKeep: 0.8, // ...and scores at least this share of it
	aspectSlack: 0.03, // a quad is not marked down for being this far from the card's own proportions (0.716)...
	aspectPenalty: 1.5, // ...beyond it, its score loses this much per unit of aspect: the strongest rectangle inside a card (the picture box under the title bar: 0.79 and wider) must not beat the card itself
};
const CFG = FINDER_CONFIG;

interface Edge {
	x: number;
	y: number;
	mag: number;
	phi: number;
}
interface Analysis {
	gx: Float32Array;
	gy: Float32Array;
	mag: Float32Array;
	edges: Edge[];
	w: number;
	h: number;
}
/** n.p = rho with n = (cos theta, sin theta) the direction of the GRADIENT (so the line has a sign). */
interface Line {
	nx: number;
	ny: number;
	rho: number;
	theta: number;
	votes: number;
}
interface SideSupport {
	frac: number;
	found: Point[];
	strength: number;
}
interface Candidate {
	L: Line[];
	polarity: Polarity;
	/** index of the deduced side in L, or -1 when the four lines are real */
	syn: number;
	D?: number;
	pol?: number;
}
interface Rating {
	P: Point[];
	fr: number[];
	mean: number;
	min: number;
	area: number;
	cut: boolean;
	final: number;
}
interface Refined extends Rating {
	polarity: Polarity;
	synthetic: boolean;
}

export interface FindCardResult {
	quad: Quad | null;
	score?: number;
	sides?: number[];
	aspect?: number;
	polarity?: Polarity;
	synthetic?: boolean;
	extended?: boolean;
	cut?: boolean;
	candidates: number;
	lines: number;
	edges: number;
	ms: number;
}

function blur121(src: Float32Array, w: number, h: number): Float32Array {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const l = src[x > 0 ? i - 1 : i];
			const r = src[x < w - 1 ? i + 1 : i];
			tmp[i] = (l + 2 * src[i] + r) / 4;
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const u = tmp[y > 0 ? i - w : i];
			const d = tmp[y < h - 1 ? i + w : i];
			out[i] = (u + 2 * tmp[i] + d) / 4;
		}
	return out;
}

/** Exported for the tests only. */
export function analyse(rgba: ArrayLike<number>, w: number, h: number): Analysis {
	const n = w * h;
	let g: Float32Array = new Float32Array(n);
	for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
	g = blur121(g, w, h);
	const gx = new Float32Array(n);
	const gy = new Float32Array(n);
	const mag = new Float32Array(n);
	for (let y = 1; y < h - 1; y++)
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const sx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
			const sy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
			gx[i] = sx / 4;
			gy[i] = sy / 4;
			mag[i] = Math.hypot(gx[i], gy[i]);
		}
	const thin: Edge[] = [];
	for (let y = 2; y < h - 2; y++)
		for (let x = 2; x < w - 2; x++) {
			const i = y * w + x;
			const m = mag[i];
			if (m < CFG.edgeMinMag) continue;
			const a = Math.atan2(gy[i], gx[i]) * (180 / Math.PI);
			const q = Math.abs(a);
			let o1: number;
			let o2: number;
			if (q < 22.5 || q > 157.5) {
				o1 = i - 1;
				o2 = i + 1;
			} else if (q > 67.5 && q < 112.5) {
				o1 = i - w;
				o2 = i + w;
			} else if ((a > 0 && a <= 90) || (a < -90 && a >= -180)) {
				o1 = i - w - 1;
				o2 = i + w + 1;
			} else {
				o1 = i - w + 1;
				o2 = i + w - 1;
			}
			if (m >= mag[o1] && m > mag[o2]) thin.push({ x, y, mag: m, phi: (a + 360) % 360 });
		}
	const sorted = thin.map((e) => e.mag).sort((p, q) => p - q);
	const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;
	const floor = Math.max(CFG.edgeMinMag, CFG.edgeKeep * p99);
	return { gx, gy, mag, edges: thin.filter((e) => e.mag >= floor), w, h };
}

const COS = new Float32Array(360);
const SIN = new Float32Array(360);
for (let t = 0; t < 360; t++) {
	COS[t] = Math.cos((t * Math.PI) / 180);
	SIN[t] = Math.sin((t * Math.PI) / 180);
}

function houghLines(A: Analysis): Line[] {
	const { w, h, edges } = A;
	const diag = Math.ceil(Math.hypot(w, h));
	const R = 2 * diag + 1;
	const acc = new Float32Array(360 * R);
	const S = CFG.thetaSpread;
	for (const e of edges) {
		const base = Math.round(e.phi);
		for (let d = -S; d <= S; d++) {
			const t = (base + d + 360) % 360;
			const rho = Math.round(e.x * COS[t] + e.y * SIN[t]) + diag;
			acc[t * R + rho] += Math.min(e.mag, CFG.houghMagCap) * (1 - Math.abs(d) / (S + 2));
		}
	}
	// 3-wide sum along rho (a pixel of rounding in rho must not split a peak), then greedy non-maximum suppression
	let top = 0;
	for (let t = 0; t < 360; t++)
		for (let r = 1; r < R - 1; r++) {
			const v = acc[t * R + r - 1] + acc[t * R + r] + acc[t * R + r + 1];
			if (v > top) top = v;
		}
	const minVote = top * CFG.houghMinVote;
	const kept: { t: number; r: number; v: number }[] = [];
	for (let t = 0; t < 360; t++)
		for (let r = 1; r < R - 1; r++) {
			const v = acc[t * R + r - 1] + acc[t * R + r] + acc[t * R + r + 1];
			if (v >= minVote) kept.push({ t, r, v });
		}
	kept.sort((a, b) => b.v - a.v);
	const lines: Line[] = [];
	for (const c of kept) {
		let near = false;
		for (const l of lines) {
			const dt = Math.min(Math.abs(l.theta - c.t), 360 - Math.abs(l.theta - c.t));
			if (dt <= 6 && Math.abs(l.rho - (c.r - diag)) <= 8) {
				near = true;
				break;
			}
		}
		if (near) continue;
		lines.push({ theta: c.t, rho: c.r - diag, nx: COS[c.t], ny: SIN[c.t], votes: c.v });
		if (lines.length >= CFG.maxLines) break;
	}
	return lines;
}

function angDiff(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}
function intersect(a: Line, b: Line): Point | null {
	const det = a.nx * b.ny - a.ny * b.nx;
	if (Math.abs(det) < 0.15) return null;
	return [(a.rho * b.ny - a.ny * b.rho) / det, (a.nx * b.rho - a.rho * b.nx) / det];
}
/** > 0 when b lies on the side OPPOSITE to a's normal (normals point away from the card), < 0 when on the same side. */
function signedGap(a: Line, b: Line): number {
	return a.rho - b.rho * (a.nx * b.nx + a.ny * b.ny);
}
function polyArea(P: Point[]): number {
	let s = 0;
	for (let i = 0; i < P.length; i++) {
		const [x0, y0] = P[i];
		const [x1, y1] = P[(i + 1) % P.length];
		s += x0 * y1 - x1 * y0;
	}
	return s / 2;
}
function insideConvex(P: Point[], pt: Point): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = P[i];
		const b = P[(i + 1) % 4];
		const z = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
		if (sign === 0) sign = Math.sign(z);
		else if (z !== 0 && Math.sign(z) !== sign) return false;
	}
	return true;
}
function convex(P: Point[]): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = P[i];
		const b = P[(i + 1) % 4];
		const c = P[(i + 2) % 4];
		const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
		if (z === 0) return false;
		if (sign === 0) sign = Math.sign(z);
		else if (Math.sign(z) !== sign) return false;
	}
	return true;
}
const sideLengths = (P: Point[]): number[] => [0, 1, 2, 3].map((i) => Math.hypot(P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]));
/** short side pair over long side pair, whichever is which */
const pairAspect = (sl: number[]): number => Math.min(sl[0] + sl[2], sl[1] + sl[3]) / Math.max(sl[0] + sl[2], sl[1] + sl[3]);

/** Support of one side: share of its length that sits on an edge whose gradient points the way the line says. */
function sideSupport(A: Analysis, line: Line, p0: Point, p1: Point, T: number, margin?: number, step?: number): SideSupport {
	const { w, h, gx, gy, mag } = A;
	const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
	const N = Math.max(8, Math.floor(L / (step || 1.5)));
	const R = CFG.searchR;
	const m = margin === undefined ? 0.03 : margin;
	let hit = 0;
	let total = 0;
	const found: Point[] = [];
	const strengths: number[] = [];
	for (let s = 0; s < N; s++) {
		const t = m + ((1 - 2 * m) * s) / (N - 1);
		const px = p0[0] + (p1[0] - p0[0]) * t;
		const py = p0[1] + (p1[1] - p0[1]) * t;
		total++;
		let best = 0;
		let bestK = 0;
		for (let k = -R; k <= R; k++) {
			const x = Math.round(px + line.nx * k);
			const y = Math.round(py + line.ny * k);
			if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
			const i = y * w + x;
			const proj = gx[i] * line.nx + gy[i] * line.ny;
			if (proj > best && proj >= 0.7 * mag[i]) {
				best = proj;
				bestK = k;
			}
		}
		if (best >= T) {
			hit++;
			strengths.push(best);
			found.push([px + line.nx * bestK, py + line.ny * bestK]);
		}
	}
	strengths.sort((a, b) => a - b);
	return { frac: hit / total, found, strength: strengths.length ? strengths[strengths.length >> 1] : 0 };
}

/** Orthogonal regression of a list of points; keeps the normal's sign of `like`. */
function fitLine(pts: Point[], like: Line): Line {
	let mx = 0;
	let my = 0;
	for (const p of pts) {
		mx += p[0];
		my += p[1];
	}
	mx /= pts.length;
	my /= pts.length;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (const p of pts) {
		const dx = p[0] - mx;
		const dy = p[1] - my;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}
	const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the line
	let nx = -Math.sin(ang);
	let ny = Math.cos(ang);
	if (nx * like.nx + ny * like.ny < 0) {
		nx = -nx;
		ny = -ny;
	}
	return { nx, ny, rho: nx * mx + ny * my, theta: (Math.atan2(ny, nx) * 180) / Math.PI, votes: like.votes };
}

/**
 * L = [a, c, b, d]: a and b opposite, c and d opposite, in cyclic order. Corner k = L[k] ^ L[k+1], so the line L[k] runs between corner k-1
 * and corner k.
 */
function cornersOf(L: Line[]): Point[] | null {
	const P = [intersect(L[0], L[1]), intersect(L[1], L[2]), intersect(L[2], L[3]), intersect(L[3], L[0])];
	const out: Point[] = [];
	for (const p of P) {
		if (!p) return null;
		out.push(p);
	}
	return out;
}

/** The side opposite to `c`, D away from it on the card's side (pol 1: normals point away from the card). */
function synthLine(c: Line, D: number, pol: number): Line {
	return { nx: -c.nx, ny: -c.ny, rho: pol > 0 ? -c.rho + D : -c.rho - D, theta: (c.theta + 180) % 360, votes: 0 };
}

/**
 * A card side that goes on past a corner means the quad stops short of the card (the picture box, the text box, a shadow...): a card's own
 * edges end at its corners. Probes a stretch of the line beyond each end of the side.
 */
function truncated(A: Analysis, line: Line, p0: Point, p1: Point, T: number, strength: number, extend: number): boolean {
	const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
	if (L < 1) return false;
	const ux = (p1[0] - p0[0]) / L;
	const uy = (p1[1] - p0[1]) / L;
	const inside = (x: number, y: number) => x > 3 && y > 3 && x < A.w - 4 && y < A.h - 4;
	const ends: [number, number, number][] = [
		[p1[0], p1[1], 1],
		[p0[0], p0[1], -1],
	];
	for (const [sx, sy, dir] of ends) {
		const a: Point = [sx + dir * ux * 0.03 * L, sy + dir * uy * 0.03 * L];
		let b: Point = [sx + dir * ux * 0.3 * L, sy + dir * uy * 0.3 * L];
		for (let f = 1; f > 0 && !inside(b[0], b[1]); f -= 0.1) b = [a[0] + (b[0] - a[0]) * 0.9, a[1] + (b[1] - a[1]) * 0.9];
		if (!inside(a[0], a[1]) || !inside(b[0], b[1])) continue;
		if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 14) continue;
		// only an edge about as strong as the side itself counts: a wood grain or a printed pattern has plenty of weak ones
		if (sideSupport(A, line, a, b, Math.max(T, extend * strength), 0).frac >= 0.6) return true;
	}
	return false;
}

/** Re-fit each real side on the pixels it covers, twice; a deduced side (index `syn`, or -1) is rebuilt from its opposite. */
function refine(A: Analysis, L: Line[], T: number, syn: number, D: number | undefined, pol: number | undefined): Line[] | null {
	let cur = L;
	for (let it = 0; it < 2; it++) {
		const P = cornersOf(cur);
		if (!P) return null;
		const next: Line[] = [];
		for (let k = 0; k < 4; k++) {
			if (k === syn) {
				next.push(cur[k]);
				continue;
			}
			const s = sideSupport(A, cur[k], P[(k + 3) % 4], P[k], T);
			if (s.found.length < 8) return null;
			let line = fitLine(s.found, cur[k]);
			// drop the worst 20 % of points, fit again
			const res = s.found.map((p) => ({ p, d: Math.abs(line.nx * p[0] + line.ny * p[1] - line.rho) }));
			res.sort((a, b) => a.d - b.d);
			line = fitLine(res.slice(0, Math.ceil(res.length * 0.8)).map((r) => r.p), cur[k]);
			next.push(line);
		}
		if (syn >= 0) next[syn] = synthLine(next[(syn + 2) % 4], D as number, pol as number);
		cur = next;
	}
	return cur;
}

/**
 * One number for a candidate, before and after the re-fit. A deduced side counts for little (it is a guess from the card's shape), a quad that
 * is cut short at a corner is heavily discounted, a bigger quad is slightly preferred (outer edge, not the frame inside the border).
 */
function rate(A: Analysis, cand: Candidate, T: number, imgArea: number, early: boolean, extend: number): Rating | null {
	const P = cornersOf(cand.L);
	if (!P) return null;
	const minReal = early ? (cand.syn >= 0 ? 0.6 : CFG.sideMinSupport) : 0;
	const sides: SideSupport[] = [];
	// most candidates are not cards: a quick look every 6 px first, and only what survives it is measured every 1.5 px
	if (early)
		for (let k = 0; k < 4; k++) {
			if (k === cand.syn) continue;
			if (sideSupport(A, cand.L[k], P[(k + 3) % 4], P[k], T, 0.03, 6).frac < 0.8 * minReal) return null;
		}
	// the real sides first and the deduced one last, so that a weak side ends the work early
	for (let k = 0; k < 4; k++) {
		if (k === cand.syn) continue;
		sides[k] = sideSupport(A, cand.L[k], P[(k + 3) % 4], P[k], T);
		if (sides[k].frac < minReal) return null;
	}
	if (cand.syn >= 0) sides[cand.syn] = sideSupport(A, cand.L[cand.syn], P[(cand.syn + 3) % 4], P[cand.syn], T);
	const fr = sides.map((s) => s.frac);
	const real = fr.filter((_, k) => k !== cand.syn);
	const mn = Math.min(...real);
	const mean = cand.syn >= 0 ? 0.85 * (real.reduce((a, v) => a + v, 0) / 3) + 0.15 * fr[cand.syn] : fr.reduce((a, v) => a + v, 0) / 4;
	const area = Math.abs(polyArea(P));
	let cut = false;
	for (let k = 0; k < 4 && !cut; k++) if (k !== cand.syn && truncated(A, cand.L[k], P[(k + 3) % 4], P[k], T, sides[k].strength, extend)) cut = true;
	const final = mean * (0.6 + 0.4 * Math.min(1, mn / 0.7)) * (0.85 + 0.15 * Math.sqrt(area / imgArea)) * (cut ? 0.55 : 1);
	return { P, fr, mean, min: mn, area, cut, final };
}

/**
 * A card with a dark border on a lighter table: the frame INSIDE the border is the strongest rectangle (polarity "in": dark outside, light
 * inside), while the card's own edge sits a little further out and has the OPPOSITE sign (dark inside, lighter outside). Scans outward from each
 * side of the quad for the nearest such edge; with three sides found at a consistent distance the quad is moved onto it. When the border is as dark
 * as the table there is no such edge and the quad is left alone (a black card on a black table).
 */
/** Exported for the tests only. */
export function outerEdge(A: Analysis, P: Point[]): Point[] | null {
	const cx = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4;
	const cy = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;
	const cardW = Math.min(...sideLengths(P));
	const kMin = Math.max(2, Math.round(CFG.outerMin * cardW));
	const kMax = Math.round(CFG.outerMax * cardW);
	const { w, h, gx, gy, mag } = A;
	const sides: { nx: number; ny: number; a: Point; k: number }[] = [];
	for (let i = 0; i < 4; i++) {
		const a = P[i];
		const b = P[(i + 1) % 4];
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const L = Math.hypot(dx, dy);
		let nx = dy / L;
		let ny = -dx / L;
		if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) {
			nx = -nx;
			ny = -ny;
		}
		const N = Math.max(10, Math.floor(L / 4));
		// seen[s][k]: sample s has an edge of the right sign at distance k
		const seen: Uint8Array[] = [];
		for (let s = 0; s < N; s++) {
			const t = 0.12 + (0.76 * s) / (N - 1);
			const px = a[0] + dx * t;
			const py = a[1] + dy * t;
			const row = new Uint8Array(kMax + 2);
			for (let k = kMin; k <= kMax; k++) {
				const x = Math.round(px + nx * k);
				const y = Math.round(py + ny * k);
				if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
				const i2 = y * w + x;
				const proj = gx[i2] * nx + gy[i2] * ny;
				if (proj >= CFG.edgeMinMag && proj >= 0.7 * mag[i2]) row[k] = 1;
			}
			seen.push(row);
		}
		let found = 0;
		for (let k = kMin; k <= kMax && !found; k++) {
			let hits = 0;
			for (const row of seen) if (row[k - 1] || row[k] || row[k + 1]) hits++;
			if (hits / N >= CFG.outerSupport) found = k;
		}
		sides.push({ nx, ny, a, k: found });
	}
	const ks = sides.filter((q) => q.k).map((q) => q.k);
	if (ks.length < 3) return null;
	const med = ks.slice().sort((p, q) => p - q)[ks.length >> 1];
	if (Math.max(...ks) - Math.min(...ks) > CFG.outerSpread * cardW) return null;
	const lines: Line[] = sides.map((q) => {
		const d = q.k || med;
		return { nx: q.nx, ny: q.ny, rho: q.nx * q.a[0] + q.ny * q.a[1] + d, theta: ((Math.atan2(q.ny, q.nx) * 180) / Math.PI + 360) % 360, votes: 0 };
	});
	const Q: Point[] = [];
	for (let i = 0; i < 4; i++) {
		const p = intersect(lines[i], lines[(i + 1) % 4]);
		if (!p) return null;
		Q.push(p);
	}
	// Q[i] is where side i meets side i+1, i.e. the corner P[i+1]
	return [Q[3], Q[0], Q[1], Q[2]];
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * `rgba`: the pixels of a picture about 360 px wide, 4 values per pixel (a canvas's ImageData.data).
 * Looks for the card with the usual rule for a side that "goes on past a corner"; when that finds no card at all, once more with `extendStrengthRetry`: on a woven mat
 * the weave's edges beyond a corner pass for the card's own side going on, every quad of the card is marked down and the answer is "no card" (a photo of a card alone on
 * a grey woven mat, taken with perspective). Never used when the first pass answers: stronger sides change which of the card's quads wins (the card's own edge instead of
 * the frame inside its border), which is more exact but gives the reader a bigger strip to read.
 */
export function findCard(rgba: ArrayLike<number>, w: number, h: number): FindCardResult | null {
	const first = search(rgba, w, h, CFG.extendStrength);
	if (first?.quad) return first;
	const retry = search(rgba, w, h, CFG.extendStrengthRetry);
	return retry?.quad ? retry : first;
}

function search(rgba: ArrayLike<number>, w: number, h: number, extend: number): FindCardResult | null {
	const t0 = now();
	const A = analyse(rgba, w, h);
	if (A.edges.length < 100) return null;
	const lines = houghLines(A);
	const T = CFG.edgeMinMag;
	const imgArea = w * h;
	const cands: Candidate[] = [];
	// opposite pairs
	const pairs: { i: number; j: number; polarity: number; width: number }[] = [];
	for (let i = 0; i < lines.length; i++)
		for (let j = i + 1; j < lines.length; j++) {
			if (Math.abs(angDiff(lines[i].theta, lines[j].theta) - 180) > CFG.parallelTol) continue;
			const gap = signedGap(lines[i], lines[j]);
			if (Math.abs(gap) < 0.15 * Math.min(w, h)) continue;
			pairs.push({ i, j, polarity: gap > 0 ? 1 : -1, width: Math.abs(gap) });
		}
	// every geometric test a quad must pass whatever its sides are made of; returns the polarity or null
	const accept = (L: Line[]): Polarity | null => {
		const corners = cornersOf(L);
		if (!corners || !convex(corners)) return null;
		const area = Math.abs(polyArea(corners));
		if (area < CFG.areaMin * imgArea || area > CFG.areaMax * imgArea) return null;
		const mx = CFG.margin * w;
		const my = CFG.margin * h;
		if (corners.some(([x, y]) => x < -mx || y < -my || x > w + mx || y > h + my)) return null;
		// the polarity must agree with the real position: every normal points away from the centroid, or every one toward it
		const cx = corners.reduce((s2, c2) => s2 + c2[0], 0) / 4;
		const cy = corners.reduce((s2, c2) => s2 + c2[1], 0) / 4;
		if (L.every((l) => l.nx * cx + l.ny * cy < l.rho)) return "out";
		if (L.every((l) => l.nx * cx + l.ny * cy > l.rho)) return "in";
		return null;
	};
	// four real lines
	for (let p = 0; p < pairs.length; p++)
		for (let q = p + 1; q < pairs.length; q++) {
			const P = pairs[p];
			const Q = pairs[q];
			if (P.polarity !== Q.polarity) continue;
			if (P.i === Q.i || P.i === Q.j || P.j === Q.i || P.j === Q.j) continue;
			if (Math.abs(angDiff(lines[P.i].theta, lines[Q.i].theta) - 90) > CFG.perpTol) continue;
			const asp = Math.min(P.width, Q.width) / Math.max(P.width, Q.width);
			if (asp < CFG.aspectMin || asp > CFG.aspectMax) continue;
			const L = [lines[P.i], lines[Q.i], lines[P.j], lines[Q.j]]; // cyclic: a, c, b, d
			const pol = accept(L);
			if (pol) cands.push({ L, polarity: pol, syn: -1 });
		}
	// three real lines and a fourth deduced from the card's shape (a side that hardly shows: dark card on a dark table)
	for (const P of pairs)
		for (let ci = 0; ci < lines.length; ci++) {
			if (ci === P.i || ci === P.j) continue;
			if (Math.abs(angDiff(lines[P.i].theta, lines[ci].theta) - 90) > CFG.perpTol) continue;
			for (const D of [P.width / CARD_ASPECT, P.width * CARD_ASPECT]) {
				const L = [lines[P.i], lines[ci], lines[P.j], synthLine(lines[ci], D, P.polarity)];
				const pol = accept(L);
				if (pol) cands.push({ L, polarity: pol, syn: 3, D, pol: P.polarity });
			}
		}
	const rated: { cd: Candidate; r: Rating }[] = [];
	for (const cd of cands) {
		const r = rate(A, cd, T, imgArea, true, extend);
		if (r) rated.push({ cd, r });
	}
	rated.sort((p, q) => q.r.final - p.r.final);
	// the best candidates are many versions of the same quad (a pixel or two apart): keep one of each, so that the few that get re-fitted include
	// the other rectangles of the picture (the card's edge AND the frame inside its border)
	const picked: { cd: Candidate; r: Rating }[] = [];
	for (const it of rated) {
		const near = (q: { r: Rating }) => it.r.P.every((p, i) => Math.hypot(p[0] - q.r.P[i][0], p[1] - q.r.P[i][1]) < 0.04 * Math.sqrt(it.r.area));
		if (picked.some((q) => near(q))) continue;
		picked.push(it);
		if (picked.length >= CFG.refineTop) break;
	}
	const refined: Refined[] = [];
	for (const { cd } of picked) {
		const fitted = refine(A, cd.L, T, cd.syn, cd.D, cd.pol) || cd.L;
		const r = rate(A, { ...cd, L: fitted }, T, imgArea, false, extend);
		if (!r) continue;
		const asp = pairAspect(sideLengths(r.P));
		if (asp < CFG.aspectMin - 0.02 || asp > CFG.aspectMax + 0.03) continue; // the re-fit drifted: no longer a card
		// only among the re-fitted quads: ranking the raw candidates by it would push the real card out of the few that get re-fitted
		const aspectOff = Math.max(0, Math.abs(asp - CARD_ASPECT) - CFG.aspectSlack);
		refined.push({ ...r, final: r.final * Math.max(0.5, 1 - CFG.aspectPenalty * aspectOff), polarity: cd.polarity, synthetic: cd.syn >= 0 });
	}
	refined.sort((p, q) => q.final - p.final);
	let best: Refined | null = refined[0] || null;
	// A card has frames inside its edge (the border, the picture box) that make rectangles of their own, as well supported as the edge: when a
	// clearly bigger quad around the best one is nearly as good, the bigger one is the card.
	for (let again = best !== null; again; ) {
		again = false;
		const current: Refined = best;
		for (const e of refined) {
			const ratio = e.area / current.area;
			if (e === current || ratio < 1.08 || ratio > CFG.encloseMaxRatio || e.final < CFG.encloseKeep * current.final) continue;
			if (!current.P.every((pt) => insideConvex(e.P, pt))) continue;
			best = e;
			again = true;
			break;
		}
	}
	let extended = false;
	if (best && best.polarity === "in") {
		const oP = outerEdge(A, best.P);
		if (oP) {
			const grown = Math.abs(polyArea(oP)) / Math.abs(polyArea(best.P));
			const asp = pairAspect(sideLengths(oP));
			const mx = CFG.margin * w;
			const my = CFG.margin * h;
			if (grown > 1.02 && grown < 1.6 && asp >= CFG.aspectMin && asp <= CFG.aspectMax && oP.every(([x, y]) => x > -mx && y > -my && x < w + mx && y < h + my)) {
				best = { ...best, P: oP };
				extended = true;
			}
		}
	}
	const ms = now() - t0;
	if (!best) return { quad: null, candidates: rated.length, lines: lines.length, edges: A.edges.length, ms };
	// order: clockwise from the corner nearest the top-left; the long side vertical
	let P: Point[] = best.P.slice();
	if (polyArea(P) < 0) P.reverse();
	let k0 = 0;
	for (let i = 1; i < 4; i++) if (P[i][0] + P[i][1] < P[k0][0] + P[k0][1]) k0 = i;
	P = [P[k0], P[(k0 + 1) % 4], P[(k0 + 2) % 4], P[(k0 + 3) % 4]];
	const top = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
	const left = Math.hypot(P[3][0] - P[0][0], P[3][1] - P[0][1]);
	if (top > left) P = [P[1], P[2], P[3], P[0]];
	const sl = sideLengths(P);
	const aspect = (sl[0] + sl[2]) / (sl[1] + sl[3]);
	return {
		quad: [P[0], P[1], P[2], P[3]],
		score: best.final,
		sides: best.fr,
		aspect,
		polarity: best.polarity,
		synthetic: best.synthetic,
		extended,
		cut: best.cut,
		candidates: rated.length,
		lines: lines.length,
		edges: A.edges.length,
		ms,
	};
}
