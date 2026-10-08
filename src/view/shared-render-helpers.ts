import { setIcon } from "obsidian";
import { formatCountTitle } from "../core/count-title";
import {
	renderLoadingDots,
} from "../ui/card-detail-fx";
import type { App } from "obsidian";
import type { MTGCollectionView } from "../view";

export function openPluginSettings(this: MTGCollectionView) {
	// Obsidian internal API (not officially typed) to directly open this
	// plugin's settings tab.
	const app = this.app as App & { setting?: { open?: () => void; openTabById?: (id: string) => void } };
	app.setting?.open?.();
	app.setting?.openTabById?.(this.plugin.manifest.id);
}


// Filter field rebuilt on every render (necessary to be placed just above the
// Group by/Sort by bar), but which keeps focus and cursor position from one
// keystroke to the next.
// "Cards: …" title at the head of the scroll area of an open
// list/deck/wantlist: "Cards: 95 cards" at rest, "Cards: 14 of 95 cards match"
// as soon as a filter is typed — same title (same class) as
// "Lists"/"Decks"/"Wantlists" above the galleries (see formatCountTitle), in
// place of the "x of y cards match" line that used to be displayed under the
// search bar. In the scroll area and not in the sticky header: at rest it says
// nothing that the title header doesn't already say, and it must not make the
// fixed part of the view taller (see "Open UI/UX follow-ups", CLAUDE.md).
//
// Count of COPIES (sum of `count`), not of unique entries: it is the "N cards"
// of the view header and of the group headers ("38 unique · 95 cards"). A
// 60-card deck must display "Cards: 60 cards", not its number of distinct
// entries.
//
// `legalityPending`: a "legal:" token is active but at least one card of the
// open list doesn't have its legality in the cache yet (see
// MTGCollectionPlugin.bulkFetchLegalities, triggered from renderListDetail):
// without this indicator, the count displayed during loading would just seem
// "wrong" (legal cards not yet resolved counted as not legal), rather than
// legibly "in progress".
export function renderCardsCountTitle(
	parent: HTMLElement,
	cards: { count: number }[],
	matchedCards: { count: number }[],
	filtering: boolean,
	legalityPending = false
) {
	const sumCount = (list: { count: number }[]) => list.reduce((s, c) => s + c.count, 0);
	const titleEl = parent.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle("card", sumCount(matchedCards), sumCount(cards), filtering),
	});
	if (legalityPending) {
		const loadingWrap = titleEl.createSpan({ cls: "mtg-filter-legality-loading" });
		loadingWrap.createSpan({ text: "Fetching legality data" });
		renderLoadingDots(loadingWrap.createSpan({ cls: "mtg-filter-legality-loading-dots" }));
	}
}

// Row of column headings in Table mode. Thanks to the natural flow of the
// CSS grid, these cells simply occupy the first N columns of the grid,
// before the card rows continue the flow.

export function renderTableHeader(this: MTGCollectionView, list: HTMLElement, columns: string[]) {
	columns.forEach((label) => {
		const cell = list.createDiv({ cls: "mtg-table-header-cell", text: label });
		// "QTY" centered, "Price" right-aligned (explicitly requested, the only
		// two headings concerned originally) — see
		// .mtg-table-header-cell-qty/-price, styles.css. "Legality" (Deck column
		// only) follows the same centered treatment as QTY.
		if (label === "Qty") cell.addClass("mtg-table-header-cell-qty");
		if (label === "Price") cell.addClass("mtg-table-header-cell-price");
		if (label === "Legality") cell.addClass("mtg-table-header-cell-legality");
	});
}

export function isDetailViewOpen(this: MTGCollectionView): boolean {
	return (
		(this.activeSection === "collection" && !!this.openListId) ||
		(this.activeSection === "decks" && !!this.openDeckId) ||
		(this.activeSection === "wantlists" && !!this.openWantlistId)
	);
}

// The element that ACTUALLY scrolls at the moment — this.mainEl for the
// overview grid, .mtg-detail-scroll-area (see styles.css) once a
// list/deck/wantlist is open, since the latter then takes charge of
// scrolling alone (this.mainEl never overflows in this mode). Resolved on
// each call rather than cached: this area is rebuilt on every render(),
// unlike this.mainEl.

export function getActiveScrollEl(this: MTGCollectionView): HTMLElement {
	if (this.isDetailViewOpen()) {
		const scrollArea = this.bodyEl.querySelector<HTMLElement>(".mtg-detail-scroll-area");
		if (scrollArea) return scrollArea;
	}
	return this.mainEl;
}

// Logic already used by the listener set once on this.mainEl in onOpen()
// ("Back to top" button + hiding the card name preview) — taken up here to
// be freshly attached to .mtg-detail-scroll-area each time it is rebuilt
// (see renderListDetail/renderDeckDetail/renderWantlistDetail): this
// element is NOT persistent like this.mainEl, so no "a single listener for
// the whole lifetime of the view" is possible here — a new listener on
// every render() rather than an explicit removal of the old one, which
// leaves anyway with the detached node (garbage collected with it, no
// leak).

export function handleScrollAreaScroll(this: MTGCollectionView, scrollEl: HTMLElement) {
	this.backToTopBtn.toggleClass("is-visible", scrollEl.scrollTop > 400);
	this.hideCardNamePreview();
}

// Resynchronizes the icon/active state of one of the 3 persistent "Select"
// buttons of the grid
// (listGallerySelectBtn/deckGallerySelectBtn/wantlistGallerySelectBtn) —
// unlike selectModeBtn (card selection, rebuilt from scratch on every
// render() since it lives in the stickyHeader of an open list), these 3
// buttons are persistent elements (like newListBtn) never recreated, so
// their icon must be updated explicitly here rather than reapplied by an
// initial createDiv/setIcon that would only replay once.

export function syncGallerySelectBtn(this: MTGCollectionView, btn: HTMLElement, active: boolean, label: string) {
	btn.toggleClass("is-active", active);
	setIcon(btn, active ? "x" : "square-mouse-pointer");
	btn.setAttribute("title", active ? "Exit select mode" : label);
}

// Placed at the end of the list as long as there are cards not yet
// rendered (see sliceGroupsForRender): as soon as it approaches the bottom
// of the visible area, we enlarge the render limit and trigger a full
// render() again, which then includes this extra batch. root:
// list.parentElement (and not the viewport nor this.mainEl) — since
// .mtg-detail-scroll-area (see styles.css), it is THIS area, the direct
// parent of list, that actually scrolls here, not this.mainEl; rootMargin
// triggers the loading a little before the sentinel is visible, to avoid
// any perceptible jolt during scrolling. The preservation of scrollTop
// after onLoadMore() (triggers a render()) no longer needs to be redone
// here by hand — render() now takes care of it itself, generically, for
// any caller (see its own comment on preservedScrollTop).

export function renderLoadMoreSentinel(this: MTGCollectionView, list: HTMLElement, onLoadMore: () => void) {
	const sentinel = list.createDiv({ cls: "mtg-load-more-sentinel" });
	const root = list.parentElement ?? this.mainEl;
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0].isIntersecting) {
				observer.disconnect();
				onLoadMore();
			}
		},
		{ root, rootMargin: "600px" }
	);
	// list (and hence sentinel) is built off-DOM at this precise moment —
	// render() assembles everything in a detached clone before swapping it in
	// at once with the old content (see render()). Observing a still-detached
	// node doesn't reliably capture its intersection once attached: some
	// engines then never recompute the sentinel's state again, and "Loading
	// more…" stays displayed indefinitely with nothing loading. We therefore
	// defer the observe() call to the next tick, once the swap is finished and
	// sentinel is really in the document.
	window.setTimeout(() => observer.observe(sentinel), 0);
}


