import { Platform } from "obsidian";
import type { MTGCollectionView } from "../view";

const FLIP_DISTANCE_PX = 24;
const FLIP_VELOCITY_PX_PER_MS = 0.25;
const SNAP_MIN_MS = 110;
const SNAP_MAX_MS = 200;
// Only the last moves of a drag say how fast the finger left: a finger that stopped before lifting has
// no velocity, however fast it moved earlier.
const VELOCITY_WINDOW_MS = 100;
// Finger travel before a gesture is read as horizontal or vertical.
const DIRECTION_SLOP_PX = 6;

// Page dots + remembered page of the pinned row of My Collection (Inbox / "All cards") and
// My Wantlists (Inbox / "All wanted"). On a phone in portrait that row is a one-line carousel
// (CSS only: `.is-phone .mtg-pinned-tiles-grid`, styles.css — horizontal scroll with
// scroll-snap, the next tile peeking at the right) instead of two tiles stacked; everywhere
// else it stays the 2-column grid and the dots are `display: none`. The dots are always built
// here and shown or hidden by CSS, because `.is-phone` flips live with the window size and the
// pane's width decides (container query) — no JS test of the window size.
//
// The row is rebuilt by every render() (detached clone, see view.ts), so a swipe to the second
// tile would snap back to the first on the next keystroke in the search bar: the page is kept
// in `view.pinnedCarouselPage` (one entry per section, like `bulkBarScrollLeft`) and restored on
// the first layout — a ResizeObserver, same reasoning as setupFadingScrollRow
// (ui/chip-row-scroll.ts): in the detached clone scrollWidth is 0 and a `scrollLeft` set then
// doesn't stick. The page is remembered as an INDEX, not as pixels: the width of the pane
// changes between a phone and a rotated phone.
export function setupPinnedCarousel(
	view: MTGCollectionView,
	kind: "collection" | "wantlists",
	wrap: HTMLElement,
	grid: HTMLElement
) {
	const count = grid.children.length;
	// A lone tile (no list/wantlist yet) has nothing to page through.
	if (count < 2) return;

	const dots = wrap.createDiv({ cls: "mtg-pinned-dots" });
	dots.setAttribute("aria-hidden", "true");
	const dotEls = Array.from({ length: count }, () => dots.createSpan({ cls: "mtg-pinned-dot" }));
	const paint = (page: number) => dotEls.forEach((dot, i) => dot.toggleClass("is-active", i === page));

	const remembered = Math.min(view.pinnedCarouselPage.get(kind) ?? 0, count - 1);
	paint(remembered);

	// Tiles are equal in width, so the page is where the scroll sits between 0 and its maximum.
	const maxLeft = () => grid.scrollWidth - grid.clientWidth;
	grid.addEventListener("scroll", () => {
		const max = maxLeft();
		const page = max > 1 ? Math.round((grid.scrollLeft / max) * (count - 1)) : 0;
		paint(page);
		view.pinnedCarouselPage.set(kind, page);
	});

	let restored = false;
	const observer = new ResizeObserver(() => {
		const max = maxLeft();
		// Nothing to restore while the row does not overflow (a wide pane shows the two tiles
		// side by side) or is not laid out yet.
		if (restored || max <= 1) return;
		restored = true;
		// The last page asks for "as far as possible" (scrollWidth - clientWidth is rounded).
		if (remembered > 0) grid.scrollLeft = remembered >= count - 1 ? grid.scrollWidth : (remembered / (count - 1)) * max;
	});
	// No explicit disconnect(): the row is recreated on every render, the old one and its
	// observer become eligible for garbage collection once detached.
	observer.observe(grid);

	// Android only: that is where the plain snap was measured slow, and iOS Safari's own snap is
	// already quick — its interplay with a scroll set from script during momentum was not tested.
	if (Platform.isAndroidApp) setupSnapAssist(grid, count);
}

// Android: the row is driven from script instead of by the browser's own horizontal scroll. The
// first version only took over when the finger lifted, and failed in the real app: the browser
// keeps its snap/fling animation running on its compositor and, when the scripted glide ended,
// resumed it from its own offset (the row reached 250 px, jumped back to ~205 and crawled to 250
// again for 400 ms) — setting `overflow: hidden` to stop it did not help. So `touch-action: pan-y`
// (`.is-script-driven`, styles.css) tells the browser to leave horizontal gestures alone: the finger
// moves the row one for one here, a short drag or a flick picks the page, and the glide is ours.
// Vertical gestures are still scrolled by the browser. The row stays a real `overflow-x: auto`
// scroller at exact page offsets, so everything reading scrollLeft (dots, the remembered page,
// the restore after render()) and Obsidian's own check before opening a drawer behave as before.
function setupSnapAssist(grid: HTMLElement, count: number) {
	grid.addClass("is-script-driven");
	let mode: "idle" | "undecided" | "horizontal" | "vertical" = "idle";
	let startX = 0;
	let startY = 0;
	let startLeft = 0;
	let startPage = 0;
	let samples: { x: number; t: number }[] = [];
	let frame = 0;
	let fallback = 0;

	const maxLeft = () => grid.scrollWidth - grid.clientWidth;
	const pageAt = (left: number) => {
		const max = maxLeft();
		return max > 1 ? Math.round((left / max) * (count - 1)) : 0;
	};

	const stopGlide = () => {
		window.cancelAnimationFrame(frame);
		window.clearTimeout(fallback);
	};

	const glideTo = (page: number) => {
		stopGlide();
		const max = maxLeft();
		if (max <= 1) return;
		const from = grid.scrollLeft;
		const to = (page / (count - 1)) * max;
		const distance = Math.abs(to - from);
		if (distance < 1) {
			grid.scrollLeft = page >= count - 1 ? grid.scrollWidth : to;
			return;
		}
		const duration = SNAP_MIN_MS + (SNAP_MAX_MS - SNAP_MIN_MS) * Math.min(1, distance / max);
		const startedAt = performance.now();
		const finish = () => {
			stopGlide();
			// `scrollWidth - clientWidth` is rounded; the last page asks for "as far as possible" so it
			// lands on the real (fractional) end instead of half a pixel short.
			grid.scrollLeft = page >= count - 1 ? grid.scrollWidth : to;
		};
		const step = (now: number) => {
			const progress = Math.min(1, (now - startedAt) / duration);
			grid.scrollLeft = from + (to - from) * (1 - Math.pow(1 - progress, 3));
			if (progress < 1) frame = window.requestAnimationFrame(step);
			else finish();
		};
		frame = window.requestAnimationFrame(step);
		// A hidden or background webview paints no frames: never leave the row between two pages.
		fallback = window.setTimeout(finish, duration + 150);
	};

	grid.addEventListener(
		"touchstart",
		(evt) => {
			// A finger landing on a row that is still gliding takes it from where it is.
			stopGlide();
			if (evt.touches.length !== 1) {
				mode = "idle";
				return;
			}
			const touch = evt.touches[0];
			mode = "undecided";
			startX = touch.clientX;
			startY = touch.clientY;
			startLeft = grid.scrollLeft;
			startPage = pageAt(startLeft);
			samples = [{ x: touch.clientX, t: evt.timeStamp }];
		},
		{ passive: true }
	);
	grid.addEventListener(
		"touchmove",
		(evt) => {
			if (mode !== "undecided" && mode !== "horizontal") return;
			const touch = evt.touches[0];
			const dx = touch.clientX - startX;
			const dy = touch.clientY - startY;
			if (mode === "undecided") {
				if (Math.abs(dx) < DIRECTION_SLOP_PX && Math.abs(dy) < DIRECTION_SLOP_PX) return;
				// A vertical gesture belongs to the browser (the row sits in a scrolling pane).
				mode = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
				if (mode === "vertical") return;
			}
			grid.scrollLeft = Math.min(maxLeft(), Math.max(0, startLeft - dx));
			samples.push({ x: touch.clientX, t: evt.timeStamp });
			if (samples.length > 8) samples.shift();
		},
		{ passive: true }
	);
	grid.addEventListener(
		"touchend",
		(evt) => {
			const wasHorizontal = mode === "horizontal";
			mode = "idle";
			if (!wasHorizontal || evt.touches.length > 0) return;
			const dx = evt.changedTouches[0].clientX - startX;
			const recent = samples.filter((s) => evt.timeStamp - s.t <= VELOCITY_WINDOW_MS);
			let velocity = 0;
			if (recent.length >= 2) {
				const first = recent[0];
				const last = recent[recent.length - 1];
				if (last.t > first.t) velocity = (last.x - first.x) / (last.t - first.t);
			}
			// A fast flick: the finger's direction at the very end decides; otherwise the whole drag.
			const flicked = Math.abs(velocity) >= FLIP_VELOCITY_PX_PER_MS;
			const dragged = Math.abs(dx) >= FLIP_DISTANCE_PX;
			let target = startPage;
			if (flicked || dragged) {
				const direction = (flicked ? velocity : dx) < 0 ? 1 : -1;
				target = Math.min(count - 1, Math.max(0, startPage + direction));
			}
			glideTo(target);
		},
		{ passive: true }
	);
	// The system took the gesture away (a notification, an edge gesture): settle on the nearest page.
	grid.addEventListener(
		"touchcancel",
		() => {
			const wasHorizontal = mode === "horizontal";
			mode = "idle";
			if (wasHorizontal) glideTo(pageAt(grid.scrollLeft));
		},
		{ passive: true }
	);
}
