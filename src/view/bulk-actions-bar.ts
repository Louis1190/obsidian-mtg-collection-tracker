import { setupWheelHorizontalScroll, setupFadingScrollRow, refreshScrollRowFade } from "../ui/chip-row-scroll";
import type { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/* Bulk actions bars: common construction and in-place button replacement. */
/* ---------------------------------------------------------------------------- */

// Select mode actions bar — the 6 variants (cards + gallery, My Collection/My Decks/My Wantlists) go through
// here rather than each writing its own `createDiv`: the bar never wraps, it scrolls horizontally with no
// visible scrollbar (styles.css, `.mtg-bulk-actions-scroll` — same principle as the chip bar, see
// ui/chip-row-scroll.ts), and the wheel, the hint fade and the remembered position must be wired up at each
// creation.
//
// TWO elements: `.mtg-bulk-actions-bar` (wrapper: border, background, rounded corners, margin, appear animation)
// and `.mtg-bulk-actions-scroll` (the one that scrolls, and the one this function RETURNS — callers add their
// buttons to it as before). The hint fade is a mask-image on the element that scrolls; carried by the wrapper,
// it would also have faded the border and background at the ends, the bar losing its edges.
//
// The bar is rebuilt on EVERY render() (every selection tap, every applied action): its scroll position is
// remembered in `view.bulkBarScrollLeft` (one entry per `kind`, see that field) and restored on rebuild. It
// starts again from 0 (counter + "Select all" in view) on its first appearance (`animate`, i.e. entering Select
// mode), not on every render.

export type BulkBarKind = "list-cards" | "list-gallery" | "deck-cards" | "deck-gallery" | "wantlist-cards" | "wantlist-gallery";

export function createBulkActionsBar(
	view: MTGCollectionView,
	kind: BulkBarKind,
	container: HTMLElement,
	animate: boolean
): HTMLElement {
	const wrap = container.createDiv({
		cls: `mtg-bulk-actions-bar${animate ? " mtg-bulk-actions-bar-animate" : ""}`,
	});
	const bar = wrap.createDiv({ cls: "mtg-bulk-actions-scroll" });
	if (animate) view.bulkBarScrollLeft.delete(kind);
	setupWheelHorizontalScroll(bar);
	setupFadingScrollRow(bar, view.bulkBarScrollLeft.get(kind) ?? 0, (left) => {
		view.bulkBarScrollLeft.set(kind, left);
	});
	return bar;
}
// Replaces a button of the bar (Quantity -> field + Cancel, Delete -> red Delete +
// Cancel) then brings the LAST new element into view: these elements arrive to the
// right of the old one, and since the bar scrolls, a Cancel/Confirm can otherwise end
// up off the screen with nothing indicating why nothing happens. `block: "nearest"`:
// never any vertical scrolling, the bar being already visible. The fade is refreshed
// by hand: the content has changed width without the bar scrolling (already visible)
// or changing size, so nothing else recomputes it.

export function replaceInBulkBar(oldEl: HTMLElement, ...newEls: HTMLElement[]) {
	const bar = oldEl.parentElement;
	oldEl.replaceWith(...newEls);
	newEls[newEls.length - 1]?.scrollIntoView({ block: "nearest", inline: "nearest" });
	if (bar) refreshScrollRowFade(bar);
}
