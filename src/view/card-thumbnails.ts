import { isAlphaSet } from "../core/card-model";
import { applySvgColor, getRarityColor } from "../api/scryfall";
import { setIcon } from "obsidian";
import { computeCardTileRadius } from "../ui/card-detail-fx";
import type { MTGCollectionView } from "../view";
import { setSvgMarkup } from "../ui/svg-markup";

/* ---------------------------------------------------------------------------- */
/* Card thumbnails with set badge, hover preview, corner radius in Card mode. */
/* ---------------------------------------------------------------------------- */

// Displays the floating preview on hovering a card's NAME, in Table mode only (see
// buildCollectionCardRow/buildDeckCardRow/buildWantlistCardRow, which only attach
// the mouseenter/mouseleave listeners calling these two methods when
// this.viewMode/deckViewMode/wantlistViewMode === "table"). anchor is the hovered
// element (the <span>/<div> of the name itself, not the whole cell) — used only to
// compute the position, never stored. No preview for a card with no known image
// (empty imageUrl, rare but possible case for a CSV entry imported without a
// successful Scryfall round trip).

export function showCardNamePreview(this: MTGCollectionView, anchor: HTMLElement, imageUrl: string) {
	if (!imageUrl) return;
	this.cardNamePreviewImgEl.src = imageUrl;
	const r = anchor.getBoundingClientRect();
	const margin = 12;
	const previewWidth = this.cardNamePreviewEl.offsetWidth || 220;
	const previewHeight = previewWidth * (680 / 488);
	// By default to the right of the hovered name; flips to the left if that
	// would overflow the viewport on the right (narrow window, or name close
	// to the edge). Then clamped on both sides in case NEITHER the right nor
	// the left is enough (window narrower than the preview itself).
	let left = r.right + margin;
	if (left + previewWidth > window.innerWidth - margin) {
		left = r.left - previewWidth - margin;
	}
	left = Math.max(margin, Math.min(left, window.innerWidth - previewWidth - margin));
	const top = Math.max(margin, Math.min(r.top, window.innerHeight - previewHeight - margin));
	this.cardNamePreviewEl.style.left = `${left}px`;
	this.cardNamePreviewEl.style.top = `${top}px`;
	this.cardNamePreviewEl.addClass("is-visible");
}


export function hideCardNamePreview(this: MTGCollectionView) {
	this.cardNamePreviewEl.removeClass("is-visible");
}
// See the comment of computeCardTileRadius (card-detail-fx.ts) for why the
// Card view does NOT observe its tiles individually like setupCardTilt
// does for the detail window. this.mainEl is persistent (never
// destroyed/rebuilt, unlike the tiles themselves or this.bodyEl) — a
// single ResizeObserver set up once here, for the whole lifetime of the
// view, rather than one per tile.

export function setupCardTileRadiusObserver(this: MTGCollectionView) {
	const observer = new ResizeObserver(() => this.updateCardTileRadius());
	observer.observe(this.mainEl);
}
// Samples the width of a Card view tile CURRENTLY displayed (any one: the
// 4 columns of the grid all have the same width, see
// .mtg-collection-list-cards) and sets --mtg-card-tile-radius on
// this.containerEl (also persistent) — inherited from there by all the
// displayed tiles, without any of them having to set it itself. Called (1)
// right after the atomic swap in render(), where a freshly built tile is
// already attached, and (2) from the ResizeObserver of
// setupCardTileRadiusObserver above, on every resize of the panel. Neither
// depends on observing an individual tile node, which proved unreliable
// (see computeCardTileRadius): the latter is regularly recreated, reused
// from the cache (cachedListRowElements) and moved again from one render
// to the next, much more fragile ground for a ResizeObserver than
// this.mainEl, which never moves. With no tile currently displayed
// (List/Grid/Table view active, or Card view on an empty list), does
// nothing — nothing to update.
// The sample is the first tile that has a layout box, NOT simply the first in the
// document: a tile inside a collapsed group is `display: none` and measures 0 wide, and
// stopping there left the variable unset, so every visible tile fell back to the 16px CSS
// default (10.9px expected at a 217px tile) until the next render — in whichever section
// had its first group collapsed (found 2026-10-08, "Collection's radius is not the same
// as Decks/Wantlists").

export function updateCardTileRadius(this: MTGCollectionView) {
	let width = 0;
	for (const wrap of Array.from(this.containerEl.querySelectorAll<HTMLElement>(".mtg-card-tile-thumb-shadow-wrap"))) {
		width = wrap.getBoundingClientRect().width;
		if (width) break;
	}
	if (!width) return;
	this.containerEl.style.setProperty("--mtg-card-tile-radius", `${computeCardTileRadius(width)}px`);
}
export function renderThumbWithBadge(this: MTGCollectionView, 
	container: HTMLElement,
	imageUrl: string,
	setCode: string,
	rarity: string,
	showFoilLook = false,
	// Card not yet owned (deck containing a card coming from a wantlist): a
	// small corner ribbon rather than a separate parameter per caller, to stay
	// generic and reusable elsewhere if needed.
	wanted = false,
	// "tile": Card view (see
	// buildCollectionCardTile/buildDeckCardTile/buildWantlistCardTile) — the
	// card is displayed in full, full width of the tile, rather than as a
	// fixed cropped thumbnail.
	variant: "row" | "tile" = "row",
	// Small crown badge in a corner (My Decks only, see isDeckCommander,
	// data-model.ts) — added as the LAST parameter rather than between
	// wanted/variant so as not to break any existing positional call (several
	// already pass 7 arguments up to variant).
	isCommander = false
) {
	// Card view: the requested drop shadow ("light, diffuse, downward") must
	// live on an ancestor that does NOT have overflow:hidden — .mtg-thumb-wrap
	// (below) needs it to clip the foil halo/the border at the rounded corners
	// (see its own comment), and a box-shadow set on an element that clips
	// itself with overflow:hidden is silently cropped, not just darkened.
	// Hence this additional container, purely decorative (no background, no
	// clip), only in the "tile" variant.
	const shadowWrap =
		variant === "tile" ? container.createDiv({ cls: "mtg-card-tile-thumb-shadow-wrap" }) : container;
	// Responsive radius (--mtg-card-tile-radius): NOT set here per tile — see
	// updateCardTileRadius/setupCardTileRadiusObserver (same file), and the
	// comment of computeCardTileRadius (card-detail-fx.ts), for why an
	// observer per tile built here (in the detached clone of render()) proved
	// unreliable in real Obsidian despite several successive fixes.
	// Alpha (Limited Edition Alpha) has a physical radius much larger than the
	// other sets — same need as in the List/Grid view
	// (mtg-card-row-thumb-alpha), but here the SAME modifier class
	// (mtg-card-tile-alpha) must be added to the THREE elements that carry a
	// border-radius (the shadow wrapper, the clipping wrap, and the image
	// itself) — a different radius between the one that clips and that of the
	// clipped image would desynchronize their appearance (see styles.css).
	const isAlpha = variant === "tile" && isAlphaSet(setCode);
	const wrap = shadowWrap.createDiv({
		cls:
			variant === "tile"
				? `mtg-thumb-wrap mtg-thumb-wrap-tile${isAlpha ? " mtg-card-tile-alpha" : ""}`
				: "mtg-thumb-wrap",
	});
	if (isAlpha && shadowWrap !== container) shadowWrap.addClass("mtg-card-tile-alpha");
	const thumbCls =
		variant === "tile"
			? `mtg-card-tile-thumb${isAlpha ? " mtg-card-tile-alpha" : ""}`
			: isAlphaSet(setCode)
			  ? "mtg-card-row-thumb mtg-card-row-thumb-alpha"
			  : "mtg-card-row-thumb";
	if (imageUrl) {
		wrap.createEl("img", { cls: thumbCls, attr: { src: imageUrl, loading: "lazy" } });
	} else {
		wrap.createDiv({ cls: `${thumbCls} mtg-no-image` });
	}

	if (showFoilLook) {
		wrap.createDiv({ cls: "mtg-foil-overlay" });
	}

	if (wanted) {
		wrap.createDiv({ cls: "mtg-thumb-wanted-ribbon", text: "Wanted" });
	}

	// TOP-RIGHT corner (top-left already taken by the "Wanted" ribbon above
	// and the "wanted" marker of My Wantlists, see their own comment in
	// styles.css — the two can in principle coexist with this badge on a
	// not-yet-owned deck card) — see isDeckCommander (data-model.ts): the
	// Commander has been a Function since 2026-09-07, not a category, so it is
	// identified here via a badge on the card itself rather than a dedicated
	// tab/group header (scoping explicitly confirmed).
	if (isCommander) {
		setIcon(wrap.createDiv({ cls: "mtg-thumb-commander-badge" }), "crown");
	}

	// The corner badge (set logo on the image itself) is redundant in the Card
	// view, where line 1 under the image already displays this same logo (see
	// buildCollectionCardTile/buildDeckCardTile/buildWantlistCardTile) —
	// removed for this variant alone, on explicit request. The List/Grid/Table
	// views have no other place where this logo appears: the badge is
	// indispensable there.
	if (variant !== "tile") {
		const badge = wrap.createDiv({ cls: "mtg-thumb-set-badge" });
		void this.plugin.getSetIconSvg(setCode).then((svg) => {
			if (!svg) {
				badge.remove();
				return;
			}
			setSvgMarkup(badge, svg);
			const svgEl = badge.querySelector("svg");
			if (svgEl) {
				svgEl.setAttribute("width", "13");
				svgEl.setAttribute("height", "13");
			}
			applySvgColor(badge, getRarityColor(rarity));
		});
	}

	return wrap;
}
