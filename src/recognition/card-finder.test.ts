import { describe, expect, it } from "vitest";
import { cardCorners, inside, scene } from "./__tests__/scenes";
import { analyse, findCard, FINDER_CONFIG, outerEdge, type Point } from "./card-finder";

// Scenes drawn in the tests: ./__tests__/scenes.ts
const W = 240;
const H = 320;

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The found quad against the true one, whichever corner it starts from: the worst corner error in pixels. */
function worstError(found: Point[], truth: Point[]): number {
	let best = Infinity;
	for (let s = 0; s < 4; s++) best = Math.min(best, Math.max(...found.map((p, i) => dist(p, truth[(i + s) % 4]))));
	return best;
}

describe("findCard", () => {
	it("finds an upright dark-bordered card on a lighter table, and says its edge is darker (out)", () => {
		const truth = cardCorners(120, 160, 140, 196, 0);
		const r = findCard(scene({ bg: 190, border: 25, frame: 150, corners: truth }), W, H);
		expect(r?.quad).not.toBeNull();
		expect(r?.polarity).toBe("out");
		expect(worstError(r!.quad as Point[], truth)).toBeLessThan(3.5);
		expect(r!.aspect).toBeCloseTo(0.714, 1);
	});

	it("follows a card turned by 12 degrees", () => {
		const truth = cardCorners(118, 158, 136, 190, 12);
		const r = findCard(scene({ bg: 195, border: 30, frame: 140, corners: truth }), W, H);
		expect(r?.quad).not.toBeNull();
		expect(worstError(r!.quad as Point[], truth)).toBeLessThan(4);
	});

	it("gives a card lying on its side the same way up as a standing one: the long side is vertical, TL to TR is the short side", () => {
		const truth = cardCorners(120, 160, 196, 140, 0); // wider than tall
		const r = findCard(scene({ bg: 190, border: 25, frame: 150, corners: truth }), W, H);
		expect(r?.quad).not.toBeNull();
		const q = r!.quad as Point[];
		expect(dist(q[0], q[1])).toBeLessThan(dist(q[0], q[3]));
		expect(r!.aspect).toBeLessThan(0.8);
		expect(worstError(q, truth)).toBeLessThan(4);
	});

	it("finds a white-bordered card on a dark table (the edge is brighter than its surroundings: polarity in)", () => {
		const truth = cardCorners(120, 160, 140, 196, 0);
		const r = findCard(scene({ bg: 35, border: 235, frame: 120, corners: truth }), W, H);
		expect(r?.quad).not.toBeNull();
		expect(r?.polarity).toBe("in");
		expect(worstError(r!.quad as Point[], truth)).toBeLessThan(4);
	});

	it("moves a frame found inside a dark border onto the card's own edge when the table is lighter", () => {
		// a thick black border: the frame inside it is the strongest rectangle for the Hough step, the card's own edge is a little further out
		const truth = cardCorners(120, 160, 150, 210, 0);
		const r = findCard(scene({ bg: 200, border: 20, frame: 170, corners: truth, borderWidth: 12 }), W, H);
		expect(r?.quad).not.toBeNull();
		expect(worstError(r!.quad as Point[], truth)).toBeLessThan(5);
	});

	it("deduces a side that hardly shows from the card's shape, and does not stop at a strong edge inside the card", () => {
		// the bottom border melts into a dark strip of the table (no edge there), and a strong dark line crosses the card at mid height, so the
		// top part of the card is a four-sided rectangle with strong edges on all sides, but its sides go on below it
		const truth = cardCorners(120, 160, 140, 196, 0); // y from 62 to 258
		const px = scene({
			bg: 190,
			border: 25,
			frame: 150,
			corners: truth,
			paint: (x, y, v) => (y >= 244 ? 25 : y >= 148 && y < 153 && x > 56 && x < 184 ? 5 : v),
		});
		const r = findCard(px, W, H);
		expect(r?.quad).not.toBeNull();
		expect(r?.synthetic).toBe(true);
		const q = r!.quad as Point[];
		// the top corners are real, the bottom ones come from the 63x88 shape: within a few pixels of the card's edge or of the frame inside its 8 px border (an edge votes
		// with at most `houghMagCap`, so the two concentric rectangles are about equally strong and either is an answer)
		const inner = cardCorners(120, 160, 140 - 16, 196 - 16, 0);
		expect(Math.min(dist(q[0], truth[0]), dist(q[0], inner[0]))).toBeLessThan(4);
		expect(Math.min(dist(q[1], truth[1]), dist(q[1], inner[1]))).toBeLessThan(4);
		expect(q[3][1] - q[0][1]).toBeGreaterThan(170); // the whole card, not the part above the dark line (height ~ 90)
		expect(Math.min(worstError(q, truth), worstError(q, inner))).toBeLessThan(12);
	});

	it("lands on the card's own edge, not on the frame inside its border, when one side of that edge is lost in a dark part of the table", () => {
		// a 12 px black border; the table is as dark as the border on the left, so the card's left edge does not exist: the frame inside the
		// border (dark outside, light inside: polarity "in") is the best full rectangle, and the other three sides reveal where the border ends
		const truth = cardCorners(130, 160, 150, 210, 0);
		const r = findCard(scene({ bg: 200, border: 20, frame: 170, corners: truth, borderWidth: 12, paint: (x, _y, v) => (x < 62 ? 20 : v) }), W, H);
		expect(r?.quad).not.toBeNull();
		expect(r?.polarity).toBe("in");
		expect(r?.extended).toBe(true);
		expect(worstError(r!.quad as Point[], truth)).toBeLessThan(6);
	});

	it("never answers with the text box of a card: a rectangle as wide as that is not a card, however strong its edges (the card's own edge is lost in a textured mat)", () => {
		// a white box on a black card is the strongest rectangle of the picture and 0.62 as tall as it is wide; the card's edge against the mat is a small step lost in
		// the mat's texture. The finder used to answer with the box (aspect 0.65, 127 px off the card): the answer is the card or nothing.
		const truth = cardCorners(120, 160, 160, 224, 0);
		const box = { x0: 59, x1: 181, y0: 178, y1: 254 };
		const painted = scene({
			bg: 65,
			border: 28,
			frame: 28,
			corners: truth,
			paint: (x, y, v) => (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 ? 235 : v + (((x * 31 + y * 17) % 17) - 8)),
		});
		const r = findCard(painted, W, H);
		if (r?.quad) expect(worstError(r.quad as Point[], truth)).toBeLessThan(10);
		expect(r?.aspect ?? 1).toBeGreaterThanOrEqual(0.67);
	});

	it("prefers the card to the picture box inside it when the card's top edge is lost against a dark part of the table (0.84 wide is not a card)", () => {
		// a dark stripe of the table right above the card hides its top edge, while the picture under the light title bar has a sharp top edge of its own: a rectangle
		// with the card's three real sides and that edge on top has every side well supported, but it is 0.84 as wide as tall. The card is the one with proportions of a card.
		const truth = cardCorners(130, 165, 150, 210, 0);
		const top = Math.min(...truth.map((p) => p[1]));
		const px = scene({
			bg: 190,
			border: 22,
			frame: 160,
			corners: truth,
			borderWidth: 12,
			paint: (x, y, v) => {
				const onCard = inside(truth, x, y);
				if (!onCard && y < top + 6) return 28; // the dark stripe above the card
				if (onCard && y > top + 50 && y < top + 130 && x > 58 && x < 200) return 60; // the picture
				return v;
			},
		});
		const r = findCard(px, W, H);
		expect(r?.quad).not.toBeNull();
		expect(worstError(r!.quad as Point[], truth)).toBeLessThan(6);
		expect(r!.aspect).toBeCloseTo(0.716, 1);
		// and the mark-down is what decides it: without it the finder answers with the picture box
		const before = FINDER_CONFIG.aspectPenalty;
		FINDER_CONFIG.aspectPenalty = 0;
		try {
			const without = findCard(px, W, H);
			expect(worstError(without!.quad as Point[], truth)).toBeGreaterThan(20);
		} finally {
			FINDER_CONFIG.aspectPenalty = before;
		}
	});

	describe("the retry with a stronger rule for a side that goes on past a corner", () => {
		/** The picture with the retry switched to the first pass's own rule, i.e. what the finder did before the retry existed. */
		const withoutRetry = (px: Uint8ClampedArray) => {
			const before = FINDER_CONFIG.extendStrengthRetry;
			FINDER_CONFIG.extendStrengthRetry = FINDER_CONFIG.extendStrength;
			try {
				return findCard(px, W, H);
			} finally {
				FINDER_CONFIG.extendStrengthRetry = before;
			}
		};

		it("is stronger than the first rule (the whole point of asking again)", () => {
			expect(FINDER_CONFIG.extendStrengthRetry).toBeGreaterThan(FINDER_CONFIG.extendStrength);
		});

		it("never changes an answer the first pass gave (even one the stronger rule would have bettered): that rule picks other quads, which are not the same strip to read", () => {
			// a dark card on a woven table (cells of 4 px, 32 levels apart): the first pass answers, and the stronger rule alone would answer something else
			const truth = cardCorners(120, 160, 150.5, 215, 4);
			const px = scene({
				bg: 90,
				border: 60,
				frame: 100,
				corners: truth,
				borderWidth: 10,
				paint: (x, y, v) => (v >= 85 && v <= 110 ? v + ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 16 : -16) : v),
			});
			const a = findCard(px, W, H);
			expect(a?.quad).not.toBeNull();
			expect(JSON.stringify(a?.quad)).toBe(JSON.stringify(withoutRetry(px)?.quad));
			const before = FINDER_CONFIG.extendStrength;
			FINDER_CONFIG.extendStrength = FINDER_CONFIG.extendStrengthRetry;
			try {
				expect(JSON.stringify(findCard(px, W, H)?.quad)).not.toBe(JSON.stringify(a?.quad)); // the test can fail: the stronger rule gives another quad
			} finally {
				FINDER_CONFIG.extendStrength = before;
			}
		});

		it("does not invent a card on a table with nothing on it (a weave, stripes, noise: 100 of 300 such pictures give a phantom quad already, the retry adds none)", () => {
			let newQuads = 0;
			for (const bg of [60, 120]) for (const amp of [16, 32]) for (const cell of [3, 6]) for (const kind of ["weave", "stripes", "noise"]) {
				const px = new Uint8ClampedArray(W * H * 4);
				for (let y = 0; y < H; y++)
					for (let x = 0; x < W; x++) {
						let v = bg;
						if (kind === "weave") v += ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? amp : -amp) / 2;
						else if (kind === "stripes") v += (Math.floor(x / (cell * 3)) % 2 ? amp : -amp) / 2;
						else v += ((((x * 73856093) ^ (y * 19349663) ^ (cell * 83492791)) % 1000) / 1000) * amp - amp / 2;
						const i = (y * W + x) * 4;
						px[i] = px[i + 1] = px[i + 2] = v;
						px[i + 3] = 255;
					}
				if (!withoutRetry(px)?.quad && findCard(px, W, H)?.quad) newQuads++;
			}
			expect(newQuads).toBe(0);
		});
	});

	describe("outerEdge", () => {
		const truth = cardCorners(120, 160, 150, 210, 0);
		const frame = truth.map(([x, y]): Point => [x + (x < 120 ? 12 : -12), y + (y < 160 ? 12 : -12)]); // the frame inside a 12 px border

		it("moves a frame found inside a dark border onto the card's own edge on a lighter table", () => {
			const A = analyse(scene({ bg: 200, border: 20, frame: 170, corners: truth, borderWidth: 12 }), W, H);
			const P = outerEdge(A, frame);
			expect(P).not.toBeNull();
			// the distance is searched in whole pixels and the blurred Sobel puts an edge about a pixel off: up to ~3 px at a corner, against 12 px of border
			expect(worstError(P as Point[], truth)).toBeLessThan(3.5);
		});

		it("leaves the frame alone when the border is as dark as the table (no edge to find)", () => {
			const A = analyse(scene({ bg: 22, border: 20, frame: 170, corners: truth, borderWidth: 12 }), W, H);
			expect(outerEdge(A, frame)).toBeNull();
		});
	});

	it("answers null when there is nothing but a flat table (too few edges)", () => {
		const flat = new Uint8ClampedArray(W * H * 4).fill(180);
		expect(findCard(flat, W, H)).toBeNull();
	});

	it("never throws on a degenerate picture", () => {
		const tiny = new Uint8ClampedArray(8 * 8 * 4).fill(10);
		expect(() => findCard(tiny, 8, 8)).not.toThrow();
	});
});
