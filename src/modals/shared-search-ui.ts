import { setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { Finish } from "../core/card-model";
import { ScryfallCard, getImageUrl, applySvgColor, getRarityColor } from "../api/scryfall";
import { ListGroup, WantlistGroup, formatScryfallPrice } from "../core/price";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  Search modal                                                              */
/* -------------------------------------------------------------------------- */

export interface AddCardOptions {
	finish: Finish;
	language: string;
	condition: string;
}

export interface AddCardsModalOptions {
	// Returns the resulting entry (id + count + real listId) when the caller
	// can supply it (addCardToCollection/addCardToWantlist/addCardToDeck all
	// three return it — CollectionCard/WantlistCard have an id field of their
	// own, DeckCard does not and the call site uses scryfallId in its place,
	// see openDeckCardDetailById/the "+ Add cards" call site of the deck in
	// view.ts — the signature merely exposes an identifier that already
	// existed in practice in each case) — AddCardsModal uses it, with
	// onChangeQuantity, to turn a tile's "Add" button into a +/- stepper right
	// after the addition, and (listId) to know which destination a
	// contribution to the additions history belongs to (see onUndoAdd further
	// down — useful mostly for the listGallery flow, where the destination is
	// only known after that very first successful addition). void remains
	// possible for a future caller that couldn't supply this shape — none of
	// the 3 current flows (Collection/Wantlist/Deck) needs this branch any
	// more since the Deck flow was made uniform, but the type stays permissive
	// rather than narrowed to { id, count, listId } alone.
	onAdd: (
		card: ScryfallCard,
		options: AddCardOptions,
		listId?: string
	) => { id: string; count: number; listId: string } | void;
	// Changes the quantity of an already added entry (see onAdd above) —
	// supplied by the 3 flows
	// (changeCollectionCardCount/changeWantlistCardCount/changeDeckCardCount).
	// Absent = no stepper, the "Add" button stays "Add" even if onAdd returned
	// an entry.
	onChangeQuantity?: (entryId: string, delta: number, onDone: () => void) => void;
	// Opens the card's detail window once added — explicitly requested: a tile
	// that has become a stepper (see onChangeQuantity above, which must
	// therefore also be supplied for this callback to make sense) becomes
	// clickable and opens
	// CardDetailModal/WantlistCardDetailModal/DeckCardDetailModal (the call
	// site knows which one, not this generic interface — that is why
	// AddCardsModal never builds a detail window itself, it merely relays the
	// id of the added entry).
	// `onDetailClosed` — reported bug: changing the quantity (or deleting the
	// card) from this detail window, then coming back to "Add cards", left the
	// carousel tile displayed with its old value, nothing resynchronized it
	// afterwards. The call site (which builds the detail window and therefore
	// knows when it closes) MUST call this callback back at that moment with
	// the up-to-date real row (or undefined if deleted) — AddCardsModal uses
	// it to replay exactly the same resynchronization logic as the "Add
	// history" panel (see syncFromHistory, add-cards-modal.ts), which already
	// accepts this return shape.
	onOpenDetail?: (
		entryId: string,
		onDetailClosed: (currentRow: { id: string; count: number } | undefined) => void
	) => void;
	// Undoes `delta` copies added with THESE precise options, at this
	// destination — used by the "Add history" panel (see search-modal.ts) to
	// disable/delete a history tile. Symmetric to onAdd: the call site finds
	// the row by the same deduplication key that
	// addCardToCollection/addCardToWantlist/addCardToDeck already use to MERGE
	// an addition, rather than passing up a row id that could become invalid
	// in the meantime (row deleted by a previous undo, then re-created by a
	// redo — see AddCardsModal.toggleHistoryEntry). Returns the resulting row
	// (or undefined if deleted) so that AddCardsModal can resynchronize the
	// display of the matching carousel tile on the real state. Supplied by the
	// 3 flows since the Deck flow was made uniform (undoAddToDeck, plugin.ts)
	// — absent only for a possible future caller that truly had no way to undo
	// an addition.
	onUndoAdd?: (
		card: ScryfallCard,
		options: AddCardOptions,
		listId: string,
		delta: number
	) => { id: string; count: number } | undefined;
	// Name of the fixed destination (e.g. "Deck 1"), displayed on each tile of the
	// "Add history" panel — only for the 2 fixed-destination flows
	// (openAddCollectionCardsModal/openAddWantlistCardsModal); the 2 listGallery flows
	// instead resolve the name by listId from listGallery.summaries (the destination
	// isn't fixed there, it varies tile by tile).
	destinationName?: string;
	titleText?: string;
	// Which data this modal actually adds — explicitly requested, so that the
	// tiles of the "Add history" panel can open
	// ChangePrintingModal/CopyCardModal("move") on the row actually added (see
	// renderHistoryTile, add-cards-modal.ts). Both ONLY accept
	// "collection"/"wantlist" (neither knows DeckCard — see "Data model notes"
	// in CLAUDE.md): the tiles of the Deck flow (sourceKind === "deck")
	// therefore show neither link, unlike the 2 other flows. Optional rather
	// than required: a caller that doesn't supply it simply never shows these 2
	// links (like the Deck flow), not an error.
	sourceKind?: "collection" | "wantlist" | "deck";
	listGallery?: {
		summaries: (ListGroup | WantlistGroup)[];
		// ListGroup and WantlistGroup have the same shape — nothing allows telling
		// them apart at runtime once in this array. SelectListModal needs this for
		// its label ("+ New list" vs "+ New wantlist") and to know which creation
		// modal to open.
		kind: "list" | "wantlist";
		// Id of the "Inbox" list (see CollectionList.isInbox) when supplied by the
		// caller (today: only openAddCardsModalWithListPicker, My Collection —
		// never the Wantlist flow, which has no equivalent). When defined,
		// "Add"/"Add all" add directly to that list instead of opening
		// SelectListModal — see buildAddButton/performAddAll, add-cards-modal.ts.
		// SelectListModal remains usable as is when this field is absent
		// (defensive fallback if Inbox doesn't exist, and unchanged behavior on
		// the Wantlist side).
		defaultListId?: string;
	};
}

// Horizontally scrolling results track (carousel), shared by AddCardsModal
// (card adding) and ChangePrintingModal (choosing another version):
// left/right arrows + mouse wheel (per page) to navigate.
export function setupResultsCarousel(container: HTMLElement): HTMLElement {
	const carousel = container.createDiv({ cls: "mtg-search-carousel" });

	const leftArrow = carousel.createDiv({ cls: "mtg-search-carousel-arrow mtg-search-carousel-arrow-left" });
	setIcon(leftArrow, "chevron-left");

	const resultsEl = carousel.createDiv({ cls: "mtg-search-results" });

	const rightArrow = carousel.createDiv({ cls: "mtg-search-carousel-arrow mtg-search-carousel-arrow-right" });
	setIcon(rightArrow, "chevron-right");

	const scrollByPage = (dir: number) => {
		resultsEl.scrollBy({ left: dir * resultsEl.clientWidth, behavior: "smooth" });
	};

	// Nothing more to scroll in this direction -> no hover effect
	// (is-disabled, see styles.css) — explicitly requested. 2px of margin
	// rather than strict equality: scrollWidth/scrollLeft/clientWidth are
	// floating-point values at fractional zoom, and scroll-snap-type can leave
	// the real resting point 1-2px away from 0 rather than exactly on it
	// (observed empirically) — a comparison that is too strict would miss it.
	const updateArrowState = () => {
		leftArrow.toggleClass("is-disabled", resultsEl.scrollLeft <= 2);
		rightArrow.toggleClass(
			"is-disabled",
			resultsEl.scrollLeft + resultsEl.clientWidth >= resultsEl.scrollWidth - 2
		);
	};
	// "scroll" alone isn't enough here: with scroll-snap-type: x mandatory +
	// scroll-behavior: smooth (see mtg-search-results, styles.css), the event
	// fires on every frame of the animation AND of the readjustment to the snap
	// point that follows — but the very last frame, once the snap point is
	// actually reached, isn't guaranteed to carry the exact final value
	// depending on the engine (initially reported bug: the left arrow stayed
	// hoverable once back at the very first card). "scrollend" fires only once,
	// once the scrolling AND the readjustment to the snap are entirely over —
	// native support Chromium ≥114, widely included in Obsidian's Electron. Kept
	// in addition to "scroll" (not in its place): "scroll" keeps the display
	// reactive during the scrolling itself, "scrollend" guarantees the correct
	// final state once the movement has settled.
	resultsEl.addEventListener("scroll", updateArrowState, { passive: true });
	resultsEl.addEventListener("scrollend", updateArrowState, { passive: true });
	// The tiles are added by the caller (renderResult/renderPrintingTile) after
	// this function returns, never through a callback it could invoke itself —
	// a MutationObserver on the children is therefore the only central point to
	// recover a correct activation state on each new search, without
	// duplicating this logic at the 2 call sites (AddCardsModal +
	// ChangePrintingModal). A ResizeObserver additionally covers a resizing of
	// the window itself (clientWidth/scrollWidth both change, but not
	// necessarily in the same ratio). Neither is explicitly disconnected:
	// resultsEl is destroyed with the modal when it closes, both observers then
	// become eligible for GC — same reasoning as setupCardTilt elsewhere in
	// this plugin (see card-detail-fx.ts).
	new MutationObserver(updateArrowState).observe(resultsEl, { childList: true });
	new ResizeObserver(updateArrowState).observe(resultsEl);
	updateArrowState();

	leftArrow.addEventListener("click", () => scrollByPage(-1));
	rightArrow.addEventListener("click", () => scrollByPage(1));

	let wheelCooldown = false;
	resultsEl.addEventListener(
		"wheel",
		(evt) => {
			if (Math.abs(evt.deltaY) < 4 && Math.abs(evt.deltaX) < 4) return;
			evt.preventDefault();
			if (wheelCooldown) return;
			wheelCooldown = true;
			scrollByPage(evt.deltaY + evt.deltaX > 0 ? 1 : -1);
			window.setTimeout(() => {
				wheelCooldown = false;
			}, 550);
		},
		{ passive: false }
	);

	return resultsEl;
}

// "Skeleton" tiles displayed while loading (search in progress / default
// results) — same box structure/classes as a real tile
// (renderScryfallResultTile below: 5/7 ratio image, footer, action area),
// with empty, pulsing content instead. Fixes a reported visual jump: before,
// a simple "Searching…"/"Loading recent cards…" text (one line) stood in as
// content while loading, so the track (mtg-search-results, with no fixed
// height — only a min-height that the real tiles far exceed once loaded, see
// styles.css) collapsed then suddenly grew back when the results arrived.
// Reusing the same box template eliminates the jump by construction (same
// height on both sides) rather than guessing/measuring a px value to freeze.
// `count` = the number of tiles visible at once in the carousel (4, see
// .mtg-result-card-tile) — beyond that, the exact number has no influence on
// the height of a nowrap flex row, only the width/height PER tile matters.
export function renderResultSkeletons(resultsEl: HTMLElement, count = 4) {
	for (let i = 0; i < count; i++) {
		const tile = resultsEl.createDiv({ cls: "mtg-result-card-tile mtg-result-card-tile-skeleton" });

		const imgWrap = tile.createDiv({ cls: "mtg-result-card-image-wrap" });
		// mtg-no-image already inherits its 5/7 aspect-ratio from
		// mtg-result-card-image (same classes that renderScryfallResultTile uses
		// for a card truly without an image) — it is this ratio, not a guessed
		// fixed height, that guarantees a height identical to a real tile whatever
		// the carousel's actual width.
		imgWrap.createDiv({ cls: "mtg-result-card-image mtg-no-image mtg-skeleton-pulse" });

		const footer = tile.createDiv({ cls: "mtg-result-card-footer" });
		const footerLeft = footer.createDiv({ cls: "mtg-result-card-footer-left" });
		footerLeft.createSpan({ cls: "mtg-result-card-set-badge mtg-skeleton-pulse" });
		// Non-breaking space as text, rather than an empty span: an element with
		// no text content at all can lose the line height that its font-size would
		// otherwise give it — a non-breaking space reserves that height exactly as
		// the real text ("#123"/"2.50 $") would once loaded, without displaying
		// anything readable in the meantime (color: transparent, see styles.css).
		footerLeft.createSpan({ cls: "mtg-result-card-number mtg-skeleton-pulse", text: " " });
		footer.createSpan({ cls: "mtg-result-card-price mtg-skeleton-pulse", text: " " });

		const addControl = tile.createDiv({ cls: "mtg-result-card-add-control" });
		addControl.createDiv({ cls: "mtg-result-card-add-btn mtg-skeleton-pulse", text: " " });
	}
}

/* -------------------------------------------------------------------------- */
/* Animated exit/entrance of the result tiles (AddCardsModal only — */
/* ChangePrintingModal loads once per opening, not on every keystroke, so */
/* nothing to animate there) */
/* -------------------------------------------------------------------------- */

// Number of tiles actually visible at once in the carousel (see
// .mtg-result-card-tile — "exactly 4 cards visible"): beyond that, a tile
// is out of view at the time of the transition, no point animating it —
// neither on exit (animateResultTilesOut) nor on entrance
// (applyResultTileStaggerEntrance), which share this same limit.
const RESULT_TILE_STAGGER_MAX = 4;
// ×2.5 (were 40ms/180ms) — explicitly requested ("2x to 3x slower"),
// middle of the range. RESULT_TILE_EXIT_TRANSITION_MS must stay equal to
// the transition duration declared on .mtg-result-card-tile in styles.css
// (0.45s) — the two drive the same animation from two different places (JS
// delay between tiles + CSS duration per tile), and must therefore be
// changed together.
const RESULT_TILE_STAGGER_DELAY_MS = 100;
const RESULT_TILE_EXIT_TRANSITION_MS = 450;

// Animates the exit of the tiles CURRENTLY displayed (fade + slight slide,
// staggered left to right — DOM order = visual order in the carousel)
// before a new batch replaces them — explicitly requested, rather than an
// instant replacement. Resolves once the animation is over (immediately if
// there was nothing to animate); nothing waits on this Promise in the main
// usage (AddCardsModal.triggerSearch, fire-and-forget — see its own
// comment), but keeping it available as a Promise lets a future caller
// chain on it without changing the signature later.
export function animateResultTilesOut(resultsEl: HTMLElement): Promise<void> {
	const tiles = Array.from(resultsEl.children).slice(0, RESULT_TILE_STAGGER_MAX) as HTMLElement[];
	if (tiles.length === 0) return Promise.resolve();
	tiles.forEach((tile, i) => {
		window.setTimeout(() => tile.addClass("mtg-result-tile-exit"), i * RESULT_TILE_STAGGER_DELAY_MS);
	});
	const totalMs = (tiles.length - 1) * RESULT_TILE_STAGGER_DELAY_MS + RESULT_TILE_EXIT_TRANSITION_MS;
	return new Promise((resolve) => window.setTimeout(resolve, totalMs));
}

// Wave reappearance of a freshly inserted tile, staggered left to right
// according to its index within the batch of results — same idiom as
// CopyCardModal.revealTile/tileStaggerIndex (see CLAUDE.md): the tile starts
// hidden (mtg-result-tile-enter, set here before any paint since called
// right after renderScryfallResultTile) then mtg-result-tile-visible is
// added after an increasing delay, which leaves the browser a distinct
// "start" image (hidden) from the arrival to animate — without this initial
// delay, there would be no transition to play.
export function applyResultTileStaggerEntrance(tile: HTMLElement, index: number) {
	if (index >= RESULT_TILE_STAGGER_MAX) return;
	tile.addClass("mtg-result-tile-enter");
	window.setTimeout(() => tile.addClass("mtg-result-tile-visible"), index * RESULT_TILE_STAGGER_DELAY_MS);
}

// "Card" tile of a result (image + set symbol tinted by rarity / number /
// price), with an action area left to the call site: "Add" button for the
// add search, "Select"/"Current" for the printing choice. "caption" (the
// set's name in full) is only useful for this second case — several sets of
// the same name sometimes exist in different products, the code alone isn't
// enough to tell them apart.
export function renderScryfallResultTile(
	plugin: MTGCollectionPlugin,
	resultsEl: HTMLElement,
	card: ScryfallCard,
	renderAction: (tile: HTMLElement) => void,
	caption?: string
): HTMLElement {
	const tile = resultsEl.createDiv({ cls: "mtg-result-card-tile" });

	const imgWrap = tile.createDiv({ cls: "mtg-result-card-image-wrap" });
	const img = getImageUrl(card);
	if (img) {
		imgWrap.createEl("img", { cls: "mtg-result-card-image", attr: { src: img, loading: "lazy" } });
	} else {
		imgWrap.createDiv({ cls: "mtg-result-card-image mtg-no-image" });
	}

	if (caption) {
		tile.createDiv({ cls: "mtg-result-card-caption", text: caption });
	}

	const footer = tile.createDiv({ cls: "mtg-result-card-footer" });

	// Left: set symbol tinted by rarity + collector number.
	const footerLeft = footer.createDiv({ cls: "mtg-result-card-footer-left" });
	const setBadge = footerLeft.createDiv({ cls: "mtg-result-card-set-badge" });
	// Only requests the icon (getSetIconSvg, plugin.ts) once the tile is
	// visible — or about to be, rootMargin gives a preload margin in the
	// scrolling direction to avoid a flash of missing icon at the moment it
	// appears — in the scrolling track, not from the initial render.
	// getSetIconSvg already serializes new fetches (see setIconFetchQueue,
	// plugin.ts), but a carousel of 175 results has no reason anyway to
	// request the icon of the ~170 out-of-view tiles right on opening — this
	// guard directly reduces the size of the initial burst, in addition to the
	// queue that protects all the other callers (lists/grids, detail panels,
	// etc.). `root: resultsEl` (not the window): intersection must be computed
	// relative to the track itself, the only element that actually scrolls
	// here.
	const io = new IntersectionObserver(
		(entries) => {
			if (!entries.some((e) => e.isIntersecting)) return;
			io.disconnect();
			void plugin.getSetIconSvg(card.set).then((svg) => {
				if (!svg) {
					setBadge.remove();
					return;
				}
				setSvgMarkup(setBadge, svg);
				const svgEl = setBadge.querySelector("svg");
				if (svgEl) {
					svgEl.setAttribute("width", "16");
					svgEl.setAttribute("height", "16");
				}
				applySvgColor(setBadge, getRarityColor(card.rarity));
			});
		},
		{ root: resultsEl, rootMargin: "0px 300px 0px 300px" }
	);
	io.observe(tile);
	footerLeft.createSpan({
		cls: "mtg-result-card-number",
		text: `#${card.collector_number}`,
	});

	// Right: last price recorded by Scryfall.
	footer.createSpan({
		cls: "mtg-result-card-price",
		text: formatScryfallPrice(card, plugin.settings.priceCurrency) || "—",
	});

	renderAction(tile);
	return tile;
}
