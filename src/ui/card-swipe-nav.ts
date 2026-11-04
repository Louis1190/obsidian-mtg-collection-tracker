import { classifySwipe, startsAtScreenEdge, velocityOf, type SwipeSample } from "../core/card-swipe";
import { closeOpenPickerMenu } from "./picker-menu";


export type SwipeNav = (direction: "prev" | "next") => void;

// The window's current navigation. contentEl outlives every draw() but the nav header (and the
// closure that knows the list, the index and the animation lock) is rebuilt each time: a map entry
// replaced at each draw, with the listeners installed only once.
const navOf = new WeakMap<HTMLElement, SwipeNav>();
const installed = new WeakSet<HTMLElement>();

// Only the elements that really scroll sideways take the gesture from us (the "Copies in lists"
// carousel with more than 3 tiles). The layout itself is the vertical scroller: skipped, its
// computed overflow-x is "auto" too.
function scrollsHorizontally(el: Element): boolean {
	if (el.scrollWidth <= el.clientWidth + 1) return false;
	const overflowX = getComputedStyle(el).overflowX;
	return overflowX === "auto" || overflowX === "scroll";
}

// A gesture that starts in a text field is about the text (caret, selection), and one that starts in
// a sideways scroller is about that scroller.
function startsInSwipeBlocker(target: EventTarget | null, contentEl: HTMLElement): boolean {
	// Element, not HTMLElement: the price chart's targets are SVG elements.
	let el = target instanceof Element ? target : null;
	while (el && el !== contentEl) {
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable) return true;
		if (!el.classList.contains("mtg-card-detail-layout") && scrollsHorizontally(el)) return true;
		el = el.parentElement;
	}
	return false;
}

function attach(contentEl: HTMLElement): void {
	let start: { x: number; y: number } | null = null;
	let samples: SwipeSample[] = [];

	contentEl.addEventListener(
		"touchstart",
		(evt) => {
			start = null;
			// Read at each touch, like usesArtHeader: Obsidian flips `is-phone` live with the window size.
			if (!document.body.classList.contains("is-phone")) return;
			// No nav header = the "Remove this card?" screen, where nothing is displayed to move away from.
			if (evt.touches.length !== 1 || !contentEl.querySelector(".mtg-card-detail-nav-header")) return;
			const touch = evt.touches[0];
			if (startsAtScreenEdge(touch.clientX, window.innerWidth)) return;
			if (startsInSwipeBlocker(evt.target, contentEl)) return;
			start = { x: touch.clientX, y: touch.clientY };
			samples = [{ x: touch.clientX, t: evt.timeStamp }];
		},
		{ passive: true }
	);
	contentEl.addEventListener(
		"touchmove",
		(evt) => {
			if (!start) return;
			// A second finger (pinch) cancels the gesture for good.
			if (evt.touches.length !== 1) {
				start = null;
				return;
			}
			samples.push({ x: evt.touches[0].clientX, t: evt.timeStamp });
			if (samples.length > 8) samples.shift();
		},
		{ passive: true }
	);
	contentEl.addEventListener(
		"touchend",
		(evt) => {
			const from = start;
			start = null;
			if (!from || evt.touches.length > 0) return;
			const end = evt.changedTouches[0];
			const direction = classifySwipe(
				end.clientX - from.x,
				end.clientY - from.y,
				velocityOf(samples, evt.timeStamp)
			);
			if (direction) {
				// A swipe is not a click: the open Finish / Condition / Language menu would never see it and stay over the next card
				// (it also closes when the swipe cannot move, at either end of the list: the finger did leave the menu).
				closeOpenPickerMenu();
				navOf.get(contentEl)?.(direction);
			}
		},
		{ passive: true }
	);
	contentEl.addEventListener(
		"touchcancel",
		() => {
			start = null;
		},
		{ passive: true }
	);
}

// Called by renderCardNavHeader at every draw(): replaces the window's previous/next function and,
// the first time for this window, installs the touch listeners.
export function registerCardSwipeNav(contentEl: HTMLElement, go: SwipeNav): void {
	navOf.set(contentEl, go);
	if (installed.has(contentEl)) return;
	installed.add(contentEl);
	attach(contentEl);
}
