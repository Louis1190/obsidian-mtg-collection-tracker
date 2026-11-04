// The decision behind swiping between cards in a card detail window (phone only, see
// ui/card-swipe-nav.ts). Pure: no DOM, so the thresholds are testable and tuned in ONE place.
//
// Unlike the pinned-row carousel (view/pinned-carousel.ts), where a short drag only changes the page
// of a row that follows the finger, a swipe here replaces a whole window's content: an accidental
// one costs the user their place, a missed one costs a second try. So the bar is higher than the
// carousel's 24 px, and a mostly vertical gesture (the window is a vertical scroller) never counts.

// Swipe distance (CSS px) that changes card on its own: about 15% of a 390 px phone.
export const SWIPE_MIN_DISTANCE_PX = 60;
// A fast flick changes card over a shorter distance, but never over a mere tap-and-twitch.
export const SWIPE_FLICK_MIN_DISTANCE_PX = 28;
export const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.4;
// Only the last moves of a drag say how fast the finger left (see velocityOf).
export const SWIPE_VELOCITY_WINDOW_MS = 100;
// The gesture must be this many times wider than tall. 1.5 favours scrolling on purpose: a
// diagonal drag over the card text is a scroll, not a navigation.
export const SWIPE_HORIZONTAL_RATIO = 1.5;
// A touch starting this close to a screen edge belongs to the system (Android's back gesture, iOS's
// back swipe) or to Obsidian's drawers.
export const SWIPE_EDGE_GUARD_PX = 24;

export interface SwipeSample {
	x: number;
	t: number;
}

// Horizontal speed (px/ms, signed) over the last SWIPE_VELOCITY_WINDOW_MS before `endTime`; 0 when
// there are fewer than two samples in the window. A finger that stopped before lifting has no
// velocity, however fast it moved earlier.
export function velocityOf(samples: SwipeSample[], endTime: number): number {
	const recent = samples.filter((s) => endTime - s.t <= SWIPE_VELOCITY_WINDOW_MS);
	if (recent.length < 2) return 0;
	const first = recent[0];
	const last = recent[recent.length - 1];
	return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
}

// Which card a finished gesture goes to, or null. The finger moving LEFT brings the next card (the
// content is pulled towards the left, like turning a page), moving right brings the previous one.
export function classifySwipe(dx: number, dy: number, velocityX: number): "next" | "prev" | null {
	if (Math.abs(dx) <= Math.abs(dy) * SWIPE_HORIZONTAL_RATIO) return null;
	// The finger's direction at the very end decides a flick; otherwise the whole drag does. A flick
	// that ends against the drag (finger pulled back) is a hesitation, not a flick.
	const flicked =
		Math.abs(velocityX) >= SWIPE_FLICK_VELOCITY_PX_PER_MS &&
		Math.abs(dx) >= SWIPE_FLICK_MIN_DISTANCE_PX &&
		Math.sign(velocityX) === Math.sign(dx);
	const dragged = Math.abs(dx) >= SWIPE_MIN_DISTANCE_PX;
	if (!flicked && !dragged) return null;
	return dx < 0 ? "next" : "prev";
}

// True when a touch that starts at `x` is too close to either edge of a screen `width` wide.
export function startsAtScreenEdge(x: number, width: number): boolean {
	return x < SWIPE_EDGE_GUARD_PX || x > width - SWIPE_EDGE_GUARD_PX;
}
