// The chip bar (.mtg-filter-chip-row-inner) never wraps, on any platform: it scrolls
// horizontally, with no visible scrollbar (styles.css, base of `.mtg-filter-chip-row-inner`).
// Phone first (2026-10-02), then desktop and iPad (2026-10-03, "the same everywhere"). Two
// consequences, handled here:
//
// 1. Every rebuild of the bar (renderChipFilter in the detached clone of render(),
//    renderSearchChipBar on every chip committed/removed) recreates it at scrollLeft = 0: the
//    input and the "clear" button, the last children, would be out of view as soon as the chips
//    overflow -> scrollChipRowToEnd.
// 2. Without a scrollbar, a mouse with a vertical wheel has no way left to reach the first
//    chips (the trackpad and touch already scroll horizontally on their own) -> the vertical
//    wheel is converted into horizontal scrolling.
//
// To be called once the bar is built, whether or not it has focus.
//
// The file also hosts the generic building blocks of the Select mode actions bar (2026-10-03),
// which scrolls the same way: the wheel (setupWheelHorizontalScroll) and the hint fade + the
// remembered position (setupFadingScrollRow) — composed in createBulkActionsBar
// (view/shared-render-helpers.ts).
export function setupChipRowScroll(inner: HTMLElement) {
	setupWheelHorizontalScroll(inner);
	scrollChipRowToEnd(inner);
}

// Vertical wheel -> horizontal scrolling, for any row with a hidden scrollbar. Also
// used on its own by the Select mode actions bar (createBulkActionsBar,
// view/shared-render-helpers.ts), which scrolls like the chip bar but starts on the
// LEFT (counter + "Select all" first): no scrollChipRowToEnd for it.
export function setupWheelHorizontalScroll(row: HTMLElement) {
	// `row` is recreated on every rebuild: a single listener per element, never
	// accumulated. Non-passive, otherwise preventDefault() would be ignored.
	row.addEventListener(
		"wheel",
		(evt) => {
			const max = row.scrollWidth - row.clientWidth;
			if (max <= 0) return;
			// Mostly horizontal gesture (trackpad, tilted wheel): native scrolling
			// already takes care of it.
			if (Math.abs(evt.deltaX) >= Math.abs(evt.deltaY)) return;
			const next = Math.min(max, Math.max(0, row.scrollLeft + evt.deltaY));
			// Already at the end in this direction: we let the wheel scroll the page
			// instead of blocking it on a bar that can no longer move. Tolerance of 1px:
			// on a screen with a fractional ratio `scrollLeft` is e.g. 834.5 when
			// scrollWidth - clientWidth (rounded integers) is 835 — a `===` would believe
			// the bar still movable and swallow a wheel notch at the end.
			if (Math.abs(next - row.scrollLeft) < 1) return;
			row.scrollLeft = next;
			evt.preventDefault();
		},
		{ passive: false }
	);
}

// Distance (px) from the end over which the fade rises from 0 to 100%: on reaching the
// end of the row it fades out progressively instead of disappearing all at once.
const FADE_RAMP_PX = 24;

// Recomputes the fade of a scrolling row: `--mtg-row-fade-start`/`-end` are 0 to 1 (the
// share of the CSS fade actually displayed, `.mtg-bulk-actions-scroll` in styles.css) and
// `.is-scrollable` is only set if the row overflows — without it, no mask-image at all.
// Continuous variables rather than a class per side (the pattern of setupPanelScrollFade,
// card-detail-fx.ts): a class toggled at the end would make the last button "jump" from
// half-faded to crisp all at once. To be called again when the CONTENT changes without the
// row changing size or scrolling (replaceInBulkBar): neither the scroll listener nor the
// ResizeObserver of setupFadingScrollRow notice it then.
export function refreshScrollRowFade(row: HTMLElement) {
	const max = row.scrollWidth - row.clientWidth;
	const scrollable = max > 1;
	row.toggleClass("is-scrollable", scrollable);
	const ratio = (distance: number) => (scrollable ? Math.min(1, Math.max(0, distance / FADE_RAMP_PX)) : 0);
	row.style.setProperty("--mtg-row-fade-start", String(ratio(row.scrollLeft)));
	row.style.setProperty("--mtg-row-fade-end", String(ratio(max - row.scrollLeft)));
}

// Scrolling row with a hint fade, which recovers its position after a rebuild.
// `restoreLeft`: where to put the row back (the value remembered by `onScroll`); `onScroll`
// receives each new position — including that of the restoration, already clamped by what
// the row can actually scroll.
// A single mechanism for both: a ResizeObserver, whose FIRST callback fires as soon as the
// element is in the DOM and laid out, before painting — the row is built in the detached
// clone of render() (scrollWidth = 0, a `scrollLeft` set at that moment doesn't stick), and
// no flicker on the left is visible. It stays connected: a change of the panel's width
// changes what overflows, hence the fade. No explicit disconnect(), same reasoning as
// setupResponsiveRadius (card-detail-fx.ts): the row is recreated on every render, the old
// one and its observer become eligible for garbage collection once detached.
export function setupFadingScrollRow(row: HTMLElement, restoreLeft: number, onScroll: (left: number) => void) {
	row.addEventListener("scroll", () => {
		refreshScrollRowFade(row);
		onScroll(row.scrollLeft);
	});
	let restored = false;
	const observer = new ResizeObserver(() => {
		if (!restored) {
			restored = true;
			if (restoreLeft > 0) row.scrollLeft = restoreLeft;
		}
		refreshScrollRowFade(row);
	});
	observer.observe(row);
}

function scrollChipRowToEnd(inner: HTMLElement) {
	const toEnd = () => {
		inner.scrollLeft = inner.scrollWidth;
	};
	const settle = () => {
		toEnd();
		// The chips' icons (mana/set symbol) arrive through a promise
		// (getManaSymbolSvg/getSetIconSvg().then) and widen the row AFTER this first
		// pass; a microtask, queued after those .then calls, re-adjusts the scroll
		// before painting. A symbol never fetched yet (network) arrives too late for
		// that: the next render — the next keystroke — brings the input back into
		// view.
		queueMicrotask(toEnd);
	};
	if (inner.isConnected) {
		settle();
		return;
	}
	// Bar built off-DOM (detached clone of render()): no layout, scrollWidth is 0. The
	// first callback of a ResizeObserver fires as soon as the element is in the DOM and
	// has a size, before painting; a single pass is enough (disconnect), so as not to
	// fight afterwards against a scroll done by hand.
	const observer = new ResizeObserver(() => {
		observer.disconnect();
		settle();
	});
	observer.observe(inner);
}
