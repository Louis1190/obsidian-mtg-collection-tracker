import { setIcon } from "obsidian";
import { manaPoolPricesSupported } from "../api/manapool";
import type MTGCollectionPlugin from "../plugin";
import { Finish, finishHasFoilLook } from "../core/card-model";
import { formatCardPrice, formatMoney, LEGALITY_FORMATS, PricedCard } from "../core/price";
import { legalityStatusClass } from "../core/card-search";
import { getCardbaseLatestPrice, getCardbaseDayChange } from "../api/cardbase";
import {
	animateCardNav,
	toCardbaseFinish,
	renderPriceHistoryChart,
	renderPriceHistorySourceFooter,
	appendAsOfToSourceFooter,
	renderLoadingDots,
	renderDayChangeBadge,
	renderManaCostIcons,
	renderTextWithManaSymbols,
	renderCardDescriptionFaces,
	openExternalUrl,
	renderLegalityColorLegend,
} from "../ui/card-detail-fx";
import {
	CARD_KINGDOM_LOGO_SVG,
	TCGPLAYER_LOGO_SVG,
	MANA_POOL_LOGO_SVG,
	CARDMARKET_LOGO_SVG,
} from "../ui/brand-assets";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/* Boxes common to the three card detail windows (CardDetailModal / */
/* DeckCardDetailModal / WantlistCardDetailModal) */
/* -------------------------------------------------------------------------- */
// These blocks were copied identically (names aside) in the three modals; the real differences between
// sections (where a DeckCard's finish lives, which "priced" card to give formatCardPrice, which deck
// format to highlight, what to reset when changing card) are parameters. The rest — structure, CSS
// classes, order of network calls, "stale card" guard — is HERE, only once: a fix in one box applies to
// all three windows.
//
// The modal keeps its renderXBox(panel) methods: they are thin callers of these functions, which spare it
// from changing draw().

// What each box needs from the modal. `currentScryfallId` is a function (not a value) because the modal
// reassigns its card when navigating: each network request captures the card's id AT LAUNCH then compares it
// to that of the current card at resolution, to ignore a response that arrived after a change of card (draw()
// will already have rebuilt the box for the new card in the meantime).
export interface DetailBoxHost {
	plugin: MTGCollectionPlugin;
	currentScryfallId: () => string;
}

// State of "Legal Formats" kept by the modal from one display to the next: the id of the last card whose
// legalities have already been revealed (see renderLegalFormatsBox).
export interface LegalFormatsState {
	shownFor: string | null;
}

// What "Store Prices" reads from the card. `finish` is the RESOLVED finish (a DeckCard doesn't always have
// one, see getDeckCardFinish); `pricedCard` is what formatCardPrice can read (see toDeckPricedCard for a
// DeckCard).
export interface StorePricesCard {
	scryfallId: string;
	name: string;
	finish: Finish;
	pricedCard: PricedCard;
}

// A tile of the "Copies in Lists" carousel.
export type CopyTile = {
	kind: "collection" | "deck" | "wantlist";
	sourceName: string;
	imageUrl: string;
	finish: Finish;
	count: number;
	priceText: string;
	wanted?: boolean;
	onClick?: () => void;
};

// "Card Text" block — under Price History. The name isn't repeated there
// (already displayed at the top of the panel, see
// navTitle/mtg-card-detail-nav-name); mana cost + type come directly from
// the card, already cached (see CollectionCard.manaCost/typeLine), so
// displayed immediately, without waiting for a fetch. Only the rules text
// and Power/Toughness/Loyalty need a separate Scryfall round trip
// (getCardTextInfo, never stored on CollectionCard — see its own comment in
// scryfall.ts). No Proxy guard here unlike Store Prices/Price History just
// above: a proxy always represents a real card, with a real text — only the
// notion of price doesn't apply to it.
export function renderCardDescriptionBox(
	host: DetailBoxHost,
	panel: HTMLElement,
	card: { scryfallId: string; typeLine: string; manaCost: string }
) {
	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-card-description-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Card text" });

	const header = box.createDiv({ cls: "mtg-card-description-header" });
	header.createDiv({ cls: "mtg-card-description-type", text: card.typeLine });
	if (card.manaCost) {
		const manaCostEl = header.createDiv({ cls: "mtg-card-description-mana-cost" });
		renderManaCostIcons(manaCostEl, card.manaCost, (letter) => host.plugin.getManaSymbolSvg(letter));
	}

	const textEl = box.createDiv({ cls: "mtg-card-description-text" });
	renderLoadingDots(textEl);

	const requestedId = card.scryfallId;
	void host.plugin.getCardTextInfo(requestedId).then((info) => {
		if (host.currentScryfallId() !== requestedId) return;
		textEl.removeClass("mtg-loading-dots");
		if (!info) {
			// Confirmed failure after retry (see fetchCardTextInfo) — the cost/type
			// above stay displayed, only the text and the stats are missing.
			textEl.setText("—");
			return;
		}
		// Multi-faced card (split, double-faced...): replaces the merged
		// header+text above (cost/type combined at the Scryfall root, e.g.
		// "Instant // Instant") with one section per face, see
		// renderCardDescriptionFaces (card-detail-fx.ts) — explicit request rather
		// than a textual "//" between the two portions.
		if (info.faces && info.faces.length > 1) {
			header.remove();
			textEl.remove();
			renderCardDescriptionFaces(box, info.faces, (letter) => host.plugin.getManaSymbolSvg(letter));
			return;
		}
		// An empty oracle_text is a real response (vanilla creature with no
		// ability, e.g. Grizzly Bears), not a failure — no misleading "—".
		// .empty() first: renderTextWithManaSymbols appends nodes
		// (createSpan/appendChild), unlike .setText() above which by itself
		// replaces all the existing content (the 3 loading dots).
		textEl.empty();
		renderTextWithManaSymbols(textEl, info.oracleText || "No rules text.", (letter) =>
			host.plugin.getManaSymbolSvg(letter)
		);
		if (info.loyalty !== undefined) {
			box.createDiv({ cls: "mtg-card-description-stats", text: `Loyalty: ${info.loyalty}` });
		} else if (info.power !== undefined || info.toughness !== undefined) {
			box.createDiv({
				cls: "mtg-card-description-stats",
				text: `${info.power ?? "?"}/${info.toughness ?? "?"}`,
			});
		}
	});
}

// Price history (cardbase.dev, see cardbase.ts/card-detail-fx.ts) — under
// Store Prices. Card Kingdom + TCGplayer only: cardbase doesn't cover Mana
// Pool. Same Proxy exclusion as renderStorePricesBox (a Proxy card has no
// price anywhere else in this panel either).
export function renderPriceHistoryBox(
	host: DetailBoxHost,
	panel: HTMLElement,
	card: { scryfallId: string; finish: Finish },
	onResolved: () => void
) {
	if (card.finish === "proxy") return;

	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-price-history-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Price history" });
	// Spinner rather than a static "…" — see styles.css
	// .mtg-price-history-loading. renderPriceHistoryChart removes the
	// class/icon itself once the real content is ready (container.empty()).
	const body = box.createDiv({ cls: "mtg-price-history-body mtg-price-history-loading" });
	setIcon(body, "loader-2");
	const sourceFooterEl = renderPriceHistorySourceFooter(box);

	const requestedId = card.scryfallId;
	const finish = toCardbaseFinish(card.finish);
	const targetCurrency = host.plugin.settings.priceCurrency;
	void Promise.all([host.plugin.getCardbasePriceHistoryWithNativeCardmarket(requestedId, finish), host.plugin.getUsdEurRate()]).then(
		([history, rate]) => {
			if (host.currentScryfallId() !== requestedId) return;
			renderPriceHistoryChart(body, history, targetCurrency, rate);
			appendAsOfToSourceFooter(sourceFooterEl, history?.asOf);
			// The displayed card is resolved — background preloading of the Cover Flow
			// neighbors, never in competition with this request (see
			// schedulePrefetchNeighbors/MTGCollectionPlugin.prefetchCardbaseNeighbors
			// for the full rate-limit reasoning).
			onResolved();
		}
	);
}

// Legalities fetched on demand (never persisted, see
// MTGCollectionPlugin.legalitiesCache): requestedId captured at the launch
// of the request, re-checked at resolution to ignore a response arriving
// after the user has navigated to another card (draw() will already have
// rebuilt this block for the new card in the meantime).
export function renderLegalFormatsBox(
	host: DetailBoxHost,
	panel: HTMLElement,
	card: { scryfallId: string },
	state: LegalFormatsState,
	highlightFormat?: string
) {
	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-legal-formats-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Legal formats" });
	const grid = box.createDiv({ cls: "mtg-legal-formats-grid" });
	// Static/independent of the card's data — built only once, whichever path
	// (warm cache or first fetch) is taken right after (see
	// legalityStatusClass for the color code it explains).
	renderLegalityColorLegend(box);

	const requestedId = card.scryfallId;
	// A draw() on the same card (changing the finish, saving the grading…)
	// must not replay the reveal for data already known. getCardLegalities
	// stays asynchronous even on a cache hit (an async function always returns
	// a Promise) — going through it here would still let the browser paint the
	// neutral state one frame before the is-legal/is-restricted/is-banned
	// class is set, thus visually replaying the CSS transition.
	// getCachedLegalities reads the cache strictly synchronously to avoid this
	// gap.
	if (state.shownFor === requestedId) {
		const cached = host.plugin.getCachedLegalities(requestedId);
		if (cached) {
			LEGALITY_FORMATS.forEach(({ key, label }) => {
				const tile = grid.createDiv({ cls: "mtg-legal-format-tile", text: label });
				if (highlightFormat && key === highlightFormat) tile.addClass("is-deck-format");
				const cls = legalityStatusClass(cached[key]);
				if (cls) tile.addClass(cls);
			});
			return;
		}
	}

	// First appearance of this card in this window: the tiles are built right
	// away (neutral state = "not legal"), not after the fetch resolves — the
	// box therefore has its final size from the first render, and the Scryfall
	// response just recolors the relevant tiles (green/orange/red according to
	// their real status) rather than making a whole block appear/disappear
	// (avoids the layout jump that a "Loading…" state caused).
	const tiles = new Map<string, HTMLElement>();
	LEGALITY_FORMATS.forEach(({ key, label }) => {
		const tile = grid.createDiv({ cls: "mtg-legal-format-tile", text: label });
		if (highlightFormat && key === highlightFormat) tile.addClass("is-deck-format");
		tiles.set(key, tile);
	});

	void host.plugin.getCardLegalities(requestedId).then((legalities) => {
		if (host.currentScryfallId() !== requestedId || !legalities) return;
		state.shownFor = requestedId;
		grid.addClass("is-revealing");
		window.setTimeout(() => {
			LEGALITY_FORMATS.forEach(({ key }) => {
				const cls = legalityStatusClass(legalities[key]);
				if (cls) tiles.get(key)?.addClass(cls);
			});
			grid.removeClass("is-revealing");
		}, 200);
	});
}

// "Store" prices (complements the Scryfall price) — one column per store
// (logo + name + price), see card-kingdom.ts/manapool.ts. A Proxy card
// isn't a really owned/tradeable object, same exclusion as for the
// collection's value — no block at all.
export function renderStorePricesBox(host: DetailBoxHost, panel: HTMLElement, card: StorePricesCard) {
	if (card.finish === "proxy") return;

	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-store-prices-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Store prices" });
	const cols = box.createDiv({ cls: "mtg-store-price-cols" });

	// Card Kingdom first: built right away with a neutral state ("…"), not
	// after the fetch resolves — same reason as renderLegalFormatsBox above,
	// the box has its almost final size from the first render.
	const ckCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(ckCol.createDiv({ cls: "mtg-store-price-col-logo" }), CARD_KINGDOM_LOGO_SVG);
	ckCol.createDiv({ cls: "mtg-store-price-col-name", text: "Card Kingdom" });
	const ckValueEl = ckCol.createDiv({ cls: "mtg-store-price-col-value" });
	renderLoadingDots(ckValueEl);
	// Always Near Mint (see card-kingdom.ts) — a constant, no need to wait for
	// the fetch to resolve to display it (but cleared in the "no price" branch
	// below if Card Kingdom doesn't sell this printing).
	const ckDetailEl = ckCol.createDiv({ cls: "mtg-store-price-col-detail", text: "Near Mint" });
	// Yesterday→today change (see getCardbaseDayChange) — empty as long as
	// nothing is resolved, no dedicated "…"/spinner (see renderDayChangeBadge,
	// styles.css .mtg-store-price-col-change).
	const ckChangeEl = ckCol.createDiv({ cls: "mtg-store-price-col-change" });

	// TCGplayer in the second column (explicitly requested), via the price
	// already loaded on this card by Scryfall (same data as the "Price" line
	// further down in this panel) — no second network round trip needed for
	// the price itself, unlike Card Kingdom/Mana Pool, so built right away.
	// Always in USD (not plugin.settings.priceCurrency): Card Kingdom/Mana
	// Pool have no EUR, comparing the three in the same currency makes more
	// sense than using the currency chosen for the rest of the panel.
	const tcgCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(tcgCol.createDiv({ cls: "mtg-store-price-col-logo" }), TCGPLAYER_LOGO_SVG);
	tcgCol.createDiv({ cls: "mtg-store-price-col-name", text: "TCGplayer" });
	const tcgPrice = formatCardPrice(card.pricedCard, "usd");
	tcgCol.createDiv({ cls: "mtg-store-price-col-value", text: tcgPrice });
	if (tcgPrice !== "—") {
		tcgCol.setAttribute(
			"title",
			"Synced from TCGplayer's market price via Scryfall, refreshed roughly once a day — not live."
		);
		// Not a condition (NM/LP/etc.) but a market average — see the comment on
		// the "title" above for the full nuance.
		tcgCol.createDiv({ cls: "mtg-store-price-col-detail", text: "Market price" });
		const tcgChangeEl = tcgCol.createDiv({ cls: "mtg-store-price-col-change" });

		// Link to this printing's TCGplayer page, like the Card Kingdom column —
		// fetched separately (purchase_uris isn't included in the price already
		// cached on the card), so the click is only enabled once resolved rather
		// than delaying the display of the price itself, already known
		// synchronously.
		const tcgRequestedId = card.scryfallId;
		void host.plugin.getTcgplayerUrl(tcgRequestedId).then((url) => {
			if (host.currentScryfallId() !== tcgRequestedId || !url) return;
			tcgCol.addEventListener("click", () => openExternalUrl(url));
		});
		// Same cardbase history as Card Kingdom/Cardmarket below (deduplicated
		// call, see their comment) — just for the yesterday→today change, the
		// price itself remains Scryfall's displayed just above, already known
		// synchronously.
		void host.plugin.getCardbasePriceHistoryWithNativeCardmarket(tcgRequestedId, toCardbaseFinish(card.finish)).then((history) => {
			if (host.currentScryfallId() !== tcgRequestedId) return;
			renderDayChangeBadge(tcgChangeEl, getCardbaseDayChange(history, "tcgplayer"));
		});
	} else {
		// Scryfall has no price for this printing/finish — column kept (not
		// removed) so that the three stores stay aligned from one card to the
		// next, just greyed out and not clickable.
		tcgCol.addClass("is-unavailable");
	}

	// Mana Pool in the third column — same neutral "…" state while waiting for
	// the fetch (see Card Kingdom just above).
	const mpCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(mpCol.createDiv({ cls: "mtg-store-price-col-logo" }), MANA_POOL_LOGO_SVG);
	mpCol.createDiv({ cls: "mtg-store-price-col-name", text: "Mana Pool" });
	const mpValueEl = mpCol.createDiv({ cls: "mtg-store-price-col-value" });
	renderLoadingDots(mpValueEl);
	// Unlike Card Kingdom/TCGplayer, the real condition is only known once the
	// fetch has resolved (see pickManaPoolPrice) — left empty until then
	// rather than a neutral text that would have to be cleared afterwards.
	const mpDetailEl = mpCol.createDiv({ cls: "mtg-store-price-col-detail" });

	// Cardmarket in the fourth column — via cardbase.dev (see cardbase.ts,
	// getCardbasePriceHistoryWithNativeCardmarket), not Scryfall. This column
	// shares the same call/cache as the "Price History" box (see
	// renderPriceHistoryBox) — but since the addition of Cardmarket's native
	// "trend" price, this sharing now costs 2 extra network round trips
	// (cardmarket_id, then the native price itself) the first time a card is
	// opened in the session, not 0 as before:
	// getCardbasePriceHistoryWithNativeCardmarket nonetheless deduplicates
	// these two steps internally, so a single call here is enough and stays
	// shared with the "Price History" box. Always EUR (Cardmarket's native
	// currency, unlike the 3 other columns in USD): unlike TCGplayer/Card
	// Kingdom/Mana Pool, converting to a common currency would make no sense
	// here, Cardmarket never had a USD price to display.
	const cmCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(cmCol.createDiv({ cls: "mtg-store-price-col-logo" }), CARDMARKET_LOGO_SVG);
	cmCol.createDiv({ cls: "mtg-store-price-col-name", text: "Cardmarket" });
	const cmValueEl = cmCol.createDiv({ cls: "mtg-store-price-col-value" });
	renderLoadingDots(cmValueEl);
	const cmDetailEl = cmCol.createDiv({ cls: "mtg-store-price-col-detail", text: "Market price" });
	// Price of the cheapest listing (price_type="low", see
	// CardbasePriceHistory.cardmarketLow) — same class/visual treatment as
	// cmDetailEl just above (discreet, muted), empty as long as unresolved.
	// Reuses the existing class rather than creating a new one: it is exactly
	// the same role ("secondary detail under the price"), just a second line
	// of this kind instead of a single one.
	const cmLowEl = cmCol.createDiv({ cls: "mtg-store-price-col-detail" });
	const cmChangeEl = cmCol.createDiv({ cls: "mtg-store-price-col-change" });

	const requestedId = card.scryfallId;
	const isFoil = finishHasFoilLook(card.finish);
	const cardbaseFinish = toCardbaseFinish(card.finish);

	// Combined into a single Promise.all rather than two independent .then():
	// the Card Kingdom price comes from card-kingdom.ts (direct fetch), the
	// change comes from cardbase.ts (history) — two different sources for the
	// same column. Resolving them together avoids a race where one of the two
	// resolves first and shows a change badge under a price not yet known to
	// be "unavailable" (or the reverse); see Cardmarket further down, which
	// doesn't have this risk since price AND change come from the same
	// cardbase response.
	void Promise.all([
		host.plugin.getCardKingdomPrice(requestedId, isFoil),
		host.plugin.getCardbasePriceHistoryWithNativeCardmarket(requestedId, cardbaseFinish),
	]).then(([entry, history]) => {
		// The displayed card has changed (prev/next navigation) while waiting —
		// this response no longer concerns the current card.
		if (host.currentScryfallId() !== requestedId) return;
		ckValueEl.removeClass("mtg-loading-dots");
		if (!entry) {
			// Card Kingdom doesn't sell this printing — column kept (see TCGplayer
			// above), no "Near Mint" to display since there is no price to qualify.
			ckValueEl.setText("—");
			ckDetailEl.setText("");
			ckCol.addClass("is-unavailable");
			return;
		}
		ckValueEl.setText(formatMoney(entry.priceRetail, "usd"));
		ckCol.addEventListener("click", () => openExternalUrl(entry.url));
		renderDayChangeBadge(ckChangeEl, getCardbaseDayChange(history, "cardkingdom"));
	});

	void host.plugin.getManaPoolPrice(requestedId, card.finish).then((result) => {
		if (host.currentScryfallId() !== requestedId) return;
		mpValueEl.removeClass("mtg-loading-dots");
		if (!result) {
			mpValueEl.setText("—");
			// On phone / tablet the pricelist isn't loaded at all (too big for memory, see manaPoolPricesSupported): say so,
			// rather than letting people think Mana Pool doesn't sell this card.
			if (!manaPoolPricesSupported()) {
				mpDetailEl.setText("Not on mobile");
				mpDetailEl.addClass("is-note");
			}
			mpCol.addClass("is-unavailable");
			return;
		}
		// Price fell back to "the lowest available" for lack of an NM copy in
		// stock at Mana Pool — flagged in a tooltip rather than silently, so as
		// not to pass a "Played" price off as Near Mint (same reasoning as the
		// TCGplayer clarification above).
		if (!result.isNearMint) {
			mpCol.setAttribute(
				"title",
				"No Near Mint copy in stock on Mana Pool right now — showing the lowest available condition instead."
			);
		}
		mpValueEl.setText(formatMoney(result.priceCents / 100, "usd"));
		mpDetailEl.setText(result.isNearMint ? "Near Mint" : "Lowest available");
		mpCol.addEventListener("click", () => openExternalUrl(result.url));
	});

	void host.plugin.getCardbasePriceHistoryWithNativeCardmarket(requestedId, cardbaseFinish).then((history) => {
		if (host.currentScryfallId() !== requestedId) return;
		cmValueEl.removeClass("mtg-loading-dots");
		const entry = getCardbaseLatestPrice(history, "cardmarket");
		if (!entry) {
			cmValueEl.setText("—");
			cmDetailEl.setText("");
			cmCol.addClass("is-unavailable");
			return;
		}
		cmValueEl.setText(formatMoney(entry.price, entry.currency.toLowerCase() === "eur" ? "eur" : "usd"));
		renderDayChangeBadge(cmChangeEl, getCardbaseDayChange(history, "cardmarket"));
		if (history?.cardmarketLow) {
			cmLowEl.setText(
				`Low ${formatMoney(
					history.cardmarketLow.price,
					history.cardmarketLow.currency.toLowerCase() === "eur" ? "eur" : "usd"
				)}`
			);
		}
		// No exact product link: cardbase returns no URL on this endpoint (just a
		// price), and guessing a path from cardmarket_id fails in practice
		// (checked live — Cardmarket has no public redirect by ID, only slug-based
		// URLs of set+card that cardbase doesn't provide). A name SEARCH link,
		// however, works reliably and never points to the wrong place — the nuance
		// ("this precise printing" vs "all versions of this card") is flagged in a
		// tooltip, same principle as the TCGplayer/Mana Pool clarifications above.
		cmCol.setAttribute(
			"title",
			"Opens a Cardmarket search for this card name — not necessarily this exact printing."
		);
		cmCol.addEventListener("click", () =>
			window.open(
				`https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(card.name)}`,
				"_blank"
			)
		);
	});
}

export function renderCopiesInListsBox(
	panel: HTMLElement,
	active: Omit<CopyTile, "onClick">,
	others: CopyTile[],
	onActiveMeta: (meta: HTMLElement) => void
) {
	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-copies-in-lists-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Copies in lists" });

	const carouselRow = box.createDiv({ cls: "mtg-copies-in-lists-carousel-row" });
	const leftArrow = carouselRow.createDiv({ cls: "mtg-copies-in-lists-arrow" });
	setIcon(leftArrow, "chevron-left");
	const track = carouselRow.createDiv({ cls: "mtg-copies-in-lists-track" });
	const rightArrow = carouselRow.createDiv({ cls: "mtg-copies-in-lists-arrow" });
	setIcon(rightArrow, "chevron-right");
	// The active card always occupies the first tile (see buildTile further
	// down): a single "page" (3 tiles, cf. mtg-copies-in-lists-tile
	// flex-basis) remains possible even with no duplicate at all, hence the
	// +1.
	const hasOnePage = others.length + 1 <= 3;
	leftArrow.toggleClass("is-disabled", hasOnePage);
	rightArrow.toggleClass("is-disabled", hasOnePage);
	leftArrow.addEventListener("click", () => track.scrollBy({ left: -track.clientWidth, behavior: "smooth" }));
	rightArrow.addEventListener("click", () => track.scrollBy({ left: track.clientWidth, behavior: "smooth" }));

	// Small icon in front of the name (layers/swords/heart — the same as the
	// left sidebar, see makeNavItem in view.ts, and the same mapping already
	// used by the context badge of the "Add history" panel,
	// add-cards-modal.ts): indicates which section each tile comes from, the
	// active tile included (visual consistency).
	const buildTile = (tile: Omit<CopyTile, "onClick">, isActive: boolean, onClick?: () => void) => {
		const tileEl = track.createDiv({ cls: "mtg-copies-in-lists-tile" });
		tileEl.toggleClass("is-active", isActive);
		const imgWrap = tileEl.createDiv({ cls: "mtg-copies-in-lists-tile-image-wrap" });
		if (tile.imageUrl) {
			imgWrap.createEl("img", {
				cls: "mtg-copies-in-lists-tile-image",
				attr: { src: tile.imageUrl, loading: "lazy" },
			});
			if (finishHasFoilLook(tile.finish)) {
				imgWrap.createDiv({ cls: "mtg-foil-overlay" });
			}
		} else {
			imgWrap.createDiv({ cls: "mtg-copies-in-lists-tile-image mtg-no-image" });
		}
		if (tile.wanted) {
			imgWrap.createDiv({ cls: "mtg-thumb-wanted-ribbon", text: "Wanted" });
		}
		const info = tileEl.createDiv({ cls: "mtg-copies-in-lists-tile-info" });
		const meta = info.createDiv({
			cls: "mtg-copies-in-lists-tile-meta",
			text: `${tile.count}x · ${tile.priceText}`,
		});
		if (isActive) {
			onActiveMeta(meta);
		}
		const sourceRow = info.createDiv({ cls: "mtg-copies-in-lists-tile-source" });
		setIcon(
			sourceRow.createSpan({ cls: "mtg-copies-in-lists-tile-source-icon" }),
			tile.kind === "collection" ? "layers" : tile.kind === "deck" ? "swords" : "heart"
		);
		sourceRow.createSpan({ cls: "mtg-copies-in-lists-tile-list", text: tile.sourceName });
		if (!isActive && onClick) {
			tileEl.addEventListener("click", onClick);
		}
	};

	buildTile(active, true);
	others.forEach((other) => buildTile(other, false, other.onClick));
}

// Card name centered above the two columns, flanked by previous/next arrows that walk through `cards` (the
// filtered/sorted list as it was displayed when the window opened), with the "Card X of Y" marker below.
// goTo(card) is called IN THE MIDDLE of the Cover Flow animation (see animateCardNav): the modal changes
// card there, resets its own state (flipped finish, rotated split, expanded grading…) then redraws the
// whole window via draw().
export function renderCardNavHeader<T>(
	contentEl: HTMLElement,
	nav: {
	cards: T[];
	// Position of the displayed card in `cards`, or -1 if it isn't in there (navigation then hidden).
	currentIndex: number;
	name: string;
	// The modal's lock: a navigation in progress (animation) ignores any new click.
	isAnimating: () => boolean;
	setAnimating: (animating: boolean) => void;
	goTo: (card: T) => void;
	}
) {
	const { cards, currentIndex, name, isAnimating, setAnimating, goTo } = nav;
	const navHeader = contentEl.createDiv({ cls: "mtg-card-detail-nav-header" });
	const canNavigate = cards.length > 1 && currentIndex !== -1;

	// Both arrows are always created (even when navigation is impossible, in which case they are simply
	// hidden via is-hidden) so that the 3-column grid keeps fixed side column widths — otherwise the
	// central title re-centers itself and the remaining arrow would change position depending on the length
	// of the name.
	const addArrow = (direction: "prev" | "next") => {
		const step = direction === "prev" ? -1 : 1;
		const arrow = navHeader.createDiv({ cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large" });
		setIcon(arrow, direction === "prev" ? "chevron-left" : "chevron-right");
		arrow.setAttribute("title", direction === "prev" ? "Previous card" : "Next card");
		if (!canNavigate) {
			arrow.addClass("is-hidden");
		} else if (direction === "prev" ? currentIndex === 0 : currentIndex === cards.length - 1) {
			arrow.addClass("is-disabled");
		} else {
			arrow.addEventListener("click", () => {
				if (isAnimating()) return;
				setAnimating(true);
				animateCardNav(
					contentEl,
					direction,
					() => goTo(cards[currentIndex + step]),
					() => {
						setAnimating(false);
					}
				);
			});
		}
	};

	addArrow("prev");
	const navTitle = navHeader.createDiv({ cls: "mtg-card-detail-nav-title" });
	navTitle.createDiv({ cls: "mtg-card-detail-nav-name", text: name });
	if (currentIndex !== -1) {
		navTitle.createDiv({
			cls: "mtg-card-detail-nav-count",
			text: `Card ${currentIndex + 1} of ${cards.length}`,
		});
	}
	addArrow("next");
}
