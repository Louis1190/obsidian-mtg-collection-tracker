import { describe, expect, it } from "vitest";
import {
	SWIPE_EDGE_GUARD_PX,
	SWIPE_FLICK_MIN_DISTANCE_PX,
	SWIPE_FLICK_VELOCITY_PX_PER_MS,
	SWIPE_MIN_DISTANCE_PX,
	SWIPE_VELOCITY_WINDOW_MS,
	classifySwipe,
	startsAtScreenEdge,
	velocityOf,
} from "./card-swipe";

describe("classifySwipe", () => {
	it("a long enough slow drag to the left goes to the next card, to the right to the previous one", () => {
		expect(classifySwipe(-SWIPE_MIN_DISTANCE_PX, 0, 0)).toBe("next");
		expect(classifySwipe(SWIPE_MIN_DISTANCE_PX, 0, 0)).toBe("prev");
	});

	it("a drag just under the distance does nothing", () => {
		expect(classifySwipe(-(SWIPE_MIN_DISTANCE_PX - 1), 0, 0)).toBeNull();
		expect(classifySwipe(SWIPE_MIN_DISTANCE_PX - 1, 0, 0)).toBeNull();
	});

	it("a fast flick works over a shorter distance, in the direction of the finger", () => {
		const fast = SWIPE_FLICK_VELOCITY_PX_PER_MS;
		expect(classifySwipe(-SWIPE_FLICK_MIN_DISTANCE_PX, 0, -fast)).toBe("next");
		expect(classifySwipe(SWIPE_FLICK_MIN_DISTANCE_PX, 0, fast)).toBe("prev");
	});

	it("a flick still needs a minimal distance (a twitch is not a swipe)", () => {
		expect(classifySwipe(-(SWIPE_FLICK_MIN_DISTANCE_PX - 1), 0, -5)).toBeNull();
	});

	it("a slow gesture under the flick speed does not count as a flick", () => {
		expect(classifySwipe(-SWIPE_FLICK_MIN_DISTANCE_PX, 0, -(SWIPE_FLICK_VELOCITY_PX_PER_MS - 0.01))).toBeNull();
	});

	it("a finger pulled back at the end (speed against the drag) is not a flick", () => {
		expect(classifySwipe(-SWIPE_FLICK_MIN_DISTANCE_PX - 5, 0, SWIPE_FLICK_VELOCITY_PX_PER_MS * 2)).toBeNull();
	});

	it("a long drag still counts when the finger slowed down before lifting", () => {
		expect(classifySwipe(-120, 0, 0)).toBe("next");
	});

	it("a mostly vertical gesture (a scroll) never navigates, however far it went sideways", () => {
		expect(classifySwipe(-90, 80, 0)).toBeNull();
		expect(classifySwipe(-90, -80, -1)).toBeNull();
		// 1.5x wider than tall is the limit: exactly on it is still a scroll, just past it is a swipe.
		expect(classifySwipe(-90, 60, 0)).toBeNull();
		expect(classifySwipe(-91, 60, 0)).toBe("next");
	});

	it("no movement at all does nothing", () => {
		expect(classifySwipe(0, 0, 0)).toBeNull();
	});
});

describe("velocityOf", () => {
	it("is the speed over the last moves only", () => {
		const samples = [
			{ x: 0, t: 0 },
			{ x: -100, t: 20 },
			{ x: -100, t: 150 },
			{ x: -110, t: 170 },
		];
		// Only the last two are within 100 ms of the end: 10 px in 20 ms, the earlier burst is forgotten.
		expect(velocityOf(samples, 200)).toBeCloseTo(-0.5);
	});

	it("is 0 for a finger that stopped before lifting", () => {
		const samples = [
			{ x: 0, t: 0 },
			{ x: -100, t: 20 },
		];
		expect(velocityOf(samples, 20 + SWIPE_VELOCITY_WINDOW_MS + 1)).toBe(0);
	});

	it("is 0 with fewer than two samples or with samples at the same instant", () => {
		expect(velocityOf([], 10)).toBe(0);
		expect(velocityOf([{ x: 5, t: 10 }], 10)).toBe(0);
		expect(velocityOf([{ x: 5, t: 10 }, { x: 50, t: 10 }], 10)).toBe(0);
	});
});

describe("startsAtScreenEdge", () => {
	it("is true within the guard of either edge and false inside", () => {
		expect(startsAtScreenEdge(0, 390)).toBe(true);
		expect(startsAtScreenEdge(SWIPE_EDGE_GUARD_PX - 1, 390)).toBe(true);
		expect(startsAtScreenEdge(390 - SWIPE_EDGE_GUARD_PX + 1, 390)).toBe(true);
		expect(startsAtScreenEdge(SWIPE_EDGE_GUARD_PX, 390)).toBe(false);
		expect(startsAtScreenEdge(195, 390)).toBe(false);
		expect(startsAtScreenEdge(390 - SWIPE_EDGE_GUARD_PX, 390)).toBe(false);
	});
});
