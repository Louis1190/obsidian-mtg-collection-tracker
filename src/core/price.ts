import { CollectionCard, WantlistCard, Finish } from "./card-model";
import type { ScryfallCard } from "../api/scryfall";
import type { CollectionList, Wantlist, ListIcon } from "./data-model";
import { LEGALITY_SEARCH_FORMATS } from "./card-search";

export interface ListGroup {
	id: string;
	name: string;
	cards: CollectionCard[];
	totalQty: number;
	totalValue: number;
	coverImage: string;
	// See CollectionList.listIcon (data-model.ts) — a simple pass-through,
	// never resolved here (this module has no access to Scryfall/the plugin).
	icon?: ListIcon;
}

// The three price "sources" actually available at Scryfall (see
// discussion: Scryfall exposes only one figure per currency/finish, unlike
// services such as Delver Lens that aggregate several sources per currency
// - TCGPlayer Low/Mid/High, CardKingdom, etc.).
export type PriceCurrency = "usd" | "eur";

export const CURRENCY_LABELS: Record<PriceCurrency, { name: string; symbol: string }> = {
	usd: { name: "USD ($)", symbol: "$" },
	eur: { name: "EUR (€)", symbol: "€" },
};

// Subset of fields used by the price calculations below: both CollectionCard
// and WantlistCard satisfy it, no need to duplicate this logic for the
// wantlist.
export interface PricedCard {
	finish: Finish;
	priceUsd: string;
	priceUsdFoil: string;
	priceEur: string;
	priceEurFoil: string;
	priceUsdEtched: string;
	priceEurEtched: string;
	count: number;
}

function isPricedInFoilOnly(card: PricedCard): boolean {
	return !card.priceUsd && !card.priceEur && Boolean(card.priceUsdFoil || card.priceEurFoil);
}

export function getRawCardPrice(card: PricedCard, currency: PriceCurrency): string {
	if (card.finish === "proxy") return "";
	if (card.finish === "etched") {
		const etched = currency === "eur" ? card.priceEurEtched : card.priceUsdEtched;
		if (etched) return etched;
		return (currency === "eur" ? card.priceEur : card.priceUsd) || "";
	}
	const usesFoilPrice =
		card.finish === "foiled" ||
		card.finish === "surged" ||
		(card.finish === "regular" && isPricedInFoilOnly(card));
	if (currency === "eur") return (usesFoilPrice ? card.priceEurFoil : card.priceEur) || "";
	return (usesFoilPrice ? card.priceUsdFoil : card.priceUsd) || card.priceUsd || "";
}

export function getCardPriceNumber(card: PricedCard, currency: PriceCurrency): number {
	return parseFloat(getRawCardPrice(card, currency)) || 0;
}

export function formatCardPrice(card: PricedCard, currency: PriceCurrency): string {
	const raw = getRawCardPrice(card, currency);
	if (!raw) return "—";
	return `${CURRENCY_LABELS[currency].symbol}${raw}`;
}

export function cardValue(card: PricedCard, currency: PriceCurrency = "usd"): number {
	return getCardPriceNumber(card, currency) * card.count;
}

// Builds a PricedCard from a DeckCard (2026-09-02) —
// DeckCard.finish/priceUsd/etc. are all optional (see its own comment,
// data-model.ts: an already mature data model, caught up once for existing
// entries rather than guaranteed present from the start), so they don't
// structurally satisfy PricedCard (non-optional finish/priceUsd/etc.) without
// this small fallback — the same "Regular"/empty string as
// getDeckCardFinish/etc. (data-model.ts) for a field not yet caught up. Once
// this PricedCard is built, getRawCardPrice/formatCardPrice/cardValue apply
// to a deck card exactly as to a CollectionCard/WantlistCard — same
// etched/surged/proxy handling, no duplicated logic.
export function toDeckPricedCard(card: {
	finish?: Finish;
	priceUsd?: string;
	priceUsdFoil?: string;
	priceEur?: string;
	priceEurFoil?: string;
	priceUsdEtched?: string;
	priceEurEtched?: string;
	count: number;
}): PricedCard {
	return {
		finish: card.finish ?? "regular",
		priceUsd: card.priceUsd ?? "",
		priceUsdFoil: card.priceUsdFoil ?? "",
		priceEur: card.priceEur ?? "",
		priceEurFoil: card.priceEurFoil ?? "",
		priceUsdEtched: card.priceUsdEtched ?? "",
		priceEurEtched: card.priceEurEtched ?? "",
		count: card.count,
	};
}

export const LEGALITY_FORMATS: { key: string; label: string }[] = LEGALITY_SEARCH_FORMATS;

// Formats an already computed amount (e.g. a total sum), unlike
// formatCardPrice which reads the raw price of a specific card.
export function formatMoney(amount: number, currency: PriceCurrency): string {
	return `${CURRENCY_LABELS[currency].symbol}${amount.toFixed(2)}`;
}

// Signed change ("+€2.50" / "-$1.05"), for a price difference rather than an
// absolute amount — the sign comes BEFORE the symbol (common convention for
// a change), and a zero difference displays "+€0.00", never "-€0.00" (the
// sign comes from the rounded amount, not from a floating -0).
export function formatSignedMoney(amount: number, currency: PriceCurrency): string {
	const rounded = Math.abs(amount).toFixed(2);
	const sign = amount < 0 && parseFloat(rounded) !== 0 ? "-" : "+";
	return `${sign}${CURRENCY_LABELS[currency].symbol}${rounded}`;
}

// Same principle as formatCardPrice, but for a raw search result (not yet a
// CollectionCard) — used in previews before adding.
export function formatScryfallPrice(card: ScryfallCard, currency: PriceCurrency): string {
	const raw = currency === "eur" ? card.prices?.eur : card.prices?.usd;
	if (!raw) return "";
	return `${CURRENCY_LABELS[currency].symbol}${raw}`;
}

// Cover rule of a list: empty -> no image, 1 card -> its artwork, 2 or more
// cards -> the artwork of the most expensive card (unit price). The artwork
// alone (art_crop) is used rather than the whole card scan, much better
// suited to a tile background.
export function pickCoverImage(cards: { artCropUrl: string; imageUrl: string; priceUsd: string }[]): string {
	if (cards.length === 0) return "";
	if (cards.length === 1) return cards[0].artCropUrl || cards[0].imageUrl;
	const mostExpensive = [...cards].sort(
		(a, b) => (parseFloat(b.priceUsd || "0") || 0) - (parseFloat(a.priceUsd || "0") || 0)
	)[0];
	return mostExpensive.artCropUrl || mostExpensive.imageUrl || cards[0].artCropUrl || cards[0].imageUrl;
}

// Same rule as pickCoverImage above, except that a manual choice
// (CollectionList.coverCardId, ListSettingsModal's "Choose cover image")
// wins if it still points to a card actually present in the list —
// otherwise (card moved/deleted since) silent fallback to the usual
// auto-selection rather than a broken image or an exception.
export function resolveCoverImage(
	cards: { id: string; artCropUrl: string; imageUrl: string; priceUsd: string }[],
	coverCardId?: string
): string {
	if (coverCardId) {
		const chosen = cards.find((c) => c.id === coverCardId);
		if (chosen) return chosen.artCropUrl || chosen.imageUrl;
	}
	return pickCoverImage(cards);
}

// Same principle as pickCoverImage above, but for a Deck: falls back to the
// deck's Commander if it has one (idiomatic concept for a Commander/EDH
// deck — see isDeckCommander, data-model.ts) rather than "the most
// expensive card" like pickCoverImage, otherwise the deck's first card
// (order of addition). DeckCard now carries a real persisted price
// (2026-09-02, see "Data model notes", CLAUDE.md), so "the most expensive
// card" would now be computable here with no network round trip — but this
// Commander fallback remains deliberate, not a technical limitation: more
// idiomatic for a deck, and not called into question by the sole fact that
// the price is now available. Reads deckFunctionOverride directly (not
// isDeckCommander/getDeckCardFunction, data-model.ts) rather than widening
// this already deliberately narrow interface with
// typeLine/oracleText/keywords — Commander only ever exists through this
// manual designation anyway (see its own comment), never through automatic
// detection/the card-type fallback.
export function pickDeckCoverImage(
	cards: { artCropUrl: string; imageUrl: string; deckFunctionOverride?: string }[]
): string {
	if (cards.length === 0) return "";
	const commander = cards.find((c) => c.deckFunctionOverride === "Commander");
	const chosen = commander ?? cards[0];
	return chosen.artCropUrl || chosen.imageUrl;
}

// Same principle as resolveCoverImage above — a manual choice
// (Deck.coverCardId, DeckSettingsModal's "Choose cover image") wins if it
// still points to a card actually present in the deck, identified by
// scryfallId (DeckCard has no id field of its own) rather than by id as for
// a list.
export function resolveDeckCoverImage(
	cards: { scryfallId: string; artCropUrl: string; imageUrl: string; deckFunctionOverride?: string }[],
	coverCardId?: string
): string {
	if (coverCardId) {
		const chosen = cards.find((c) => c.scryfallId === coverCardId);
		if (chosen) return chosen.artCropUrl || chosen.imageUrl;
	}
	return pickDeckCoverImage(cards);
}

export function groupByList(
	lists: CollectionList[],
	collection: CollectionCard[],
	currency: PriceCurrency = "usd"
): ListGroup[] {
	return lists
		.map((list) => {
			const cards = collection.filter((c) => c.listId === list.id);
			return {
				id: list.id,
				name: list.name,
				cards,
				totalQty: cards.reduce((s, c) => s + c.count, 0),
				totalValue: cards.reduce((s, c) => s + cardValue(c, currency), 0),
				coverImage: resolveCoverImage(cards, list.coverCardId),
				icon: list.listIcon,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export interface WantlistGroup {
	id: string;
	name: string;
	cards: WantlistCard[];
	totalQty: number;
	totalValue: number;
	coverImage: string;
	// See ListGroup.icon above — same pass-through, on the wantlist side.
	icon?: ListIcon;
}

export function groupByWantlist(
	wantlists: Wantlist[],
	wantlistCards: WantlistCard[],
	currency: PriceCurrency = "usd"
): WantlistGroup[] {
	return wantlists
		.map((wantlist) => {
			const cards = wantlistCards.filter((c) => c.listId === wantlist.id);
			return {
				id: wantlist.id,
				name: wantlist.name,
				cards,
				totalQty: cards.reduce((s, c) => s + c.count, 0),
				totalValue: cards.reduce((s, c) => s + cardValue(c, currency), 0),
				coverImage: resolveCoverImage(cards, wantlist.coverCardId),
				icon: wantlist.listIcon,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
