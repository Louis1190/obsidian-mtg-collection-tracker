import { DeckCard, getDeckCardCategory } from "./data-model";
import { COLOR_NAMES, GROUP_LABEL_HEX, MAIN_TYPES, RARITY_ORDER, isLand, primaryType } from "./card-sorting";

/* -------------------------------------------------------------------------- */
/* Deck stats (2026-09-02) — "Stats" view of My Decks (mana */
/* curve/colors/types), see renderDeckStats (view.ts) + deck-stats-fx.ts (SVG */
/* drawing). Pure/testable: no dependency on Obsidian or the DOM, like the */
/* rest of src/core/. */
/* -------------------------------------------------------------------------- */

// "The deck actually played" — Mainboard, NOT Sideboard/Maybeboard (cards
// "not in the deck" by definition, see DeckCardCategory, data-model.ts).
// Same convention as Moxfield/Archidekt for their own statistics pages. No
// longer explicitly tests "or Commander" since 2026-09-07: Commander
// became a Function, not a category (see isDeckCommander) — a Commander
// card is already, structurally, categorized "mainboard" like any other
// card of the main deck.
export function cardsInDeckStatsScope(cards: DeckCard[]): DeckCard[] {
	return cards.filter((c) => getDeckCardCategory(c) === "mainboard");
}

export interface ManaCurveBucket {
	cmc: number; // 0-6, or 7 for the "7+" bucket
	label: string;
	count: number;
}

// Excludes lands (CMC 0 by nature — counting them would completely skew the
// curve) and groups everything above 6 into a "7+" bucket — the same two
// conventions already established by any usual deck builder
// (Moxfield/Archidekt). Weighted by card.count (the number of copies), not by
// number of distinct entries — a card with 3 copies counts 3 times,
// consistent with "the deck's curve as it will actually be drawn".
export function computeManaCurve(cards: DeckCard[]): ManaCurveBucket[] {
	const buckets = new Map<number, number>();
	for (let i = 0; i <= 7; i++) buckets.set(i, 0);
	cards.forEach((c) => {
		if (isLand(c.typeLine)) return;
		const cmc = Math.min(7, Math.max(0, Math.round(c.manaValue ?? 0)));
		buckets.set(cmc, (buckets.get(cmc) ?? 0) + c.count);
	});
	return Array.from(buckets.entries()).map(([cmc, count]) => ({
		cmc,
		label: cmc === 7 ? "7+" : String(cmc),
		count,
	}));
}

export interface ColorSlice {
	label: string;
	color: string;
	count: number;
}

// Canonical display order (legend + pie chart) — WUBRG then
// Multicolor/Colorless/Land, never sorted by decreasing count: a fixed order
// stays readable/comparable from one render to the next, unlike an order
// that would reshuffle depending on the deck's content.
const COLOR_SLICE_ORDER = ["White", "Blue", "Black", "Red", "Green", "Multicolor", "Colorless", "Land"];

// Bucketing DELIBERATELY different from colorGroupLabel (card-sorting.ts,
// which sub-classes each exact multicolor combination, e.g. "Green/Red" —
// well suited to a group header, but would give a pie chart with as many
// thin slivers as there are color pairs present in the deck): here, ANY card
// with 2+ colors falls into a single "Multicolor" bucket, as Moxfield's own
// "Color Breakdown" pie chart does. Lands keep their own "Land" bucket (not
// excluded, unlike computeManaCurve above) — "what proportion of the deck is
// colorless/mono/multi/land" is a different question from "what is the cost
// curve of the spells".
function colorPieLabel(card: { colors: string[]; typeLine: string }): string {
	if (isLand(card.typeLine)) return "Land";
	const colors = card.colors ?? [];
	if (colors.length === 0) return "Colorless";
	if (colors.length === 1) return COLOR_NAMES[colors[0]] ?? "Colorless";
	return "Multicolor";
}

// Interface deliberately narrower than DeckCard — computeColorBreakdown only
// reads these 3 fields, just as present on CollectionCard/WantlistCard
// (core/types.ts). Widened on 2026-09-23: Home (home-render.ts, "By Color"
// block) reuses this same function over the whole collection rather than
// duplicating a copy scoped to DeckCard — DeckCard still satisfies it with
// no change at its own call sites (deck-stats-modal.ts).
export interface ColorBreakdownCard {
	colors: string[];
	typeLine: string;
	count: number;
}

export function computeColorBreakdown(cards: ColorBreakdownCard[]): ColorSlice[] {
	const counts = new Map<string, number>();
	cards.forEach((c) => {
		const label = colorPieLabel(c);
		counts.set(label, (counts.get(label) ?? 0) + c.count);
	});
	return COLOR_SLICE_ORDER.filter((label) => (counts.get(label) ?? 0) > 0).map((label) => ({
		label,
		count: counts.get(label) ?? 0,
		color: GROUP_LABEL_HEX[label] ?? "#9a9a9a",
	}));
}

export interface TypeSlice {
	label: string;
	count: number;
}

// primaryType (card-sorting.ts) already files each type line under a SINGLE
// main type (Creature/Instant/Land/etc., see MAIN_TYPES) — reused as is
// rather than reinvented, same logic already used by "Group by Type"
// elsewhere in this plugin. Sorted by decreasing count (unlike the color pie
// chart above): here there is no "expected" canonical order like WUBRG,
// most-represented to least-represented is what reads best on a horizontal
// bar chart.
export function computeTypeBreakdown(cards: DeckCard[]): TypeSlice[] {
	const counts = new Map<string, number>();
	cards.forEach((c) => {
		const type = primaryType(c.typeLine);
		counts.set(type, (counts.get(type) ?? 0) + c.count);
	});
	return Array.from(counts.entries())
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || MAIN_TYPES.indexOf(a.label) - MAIN_TYPES.indexOf(b.label));
}

// Small convenient total for the Stats view header (view.ts) — same count
// weighting as the 3 functions above.
export function totalStatsCardCount(cards: DeckCard[]): number {
	return cards.reduce((s, c) => s + c.count, 0);
}

/* -------------------------------------------------------------------------- */
/* The rest of this file (2026-09-23) serves Home's "Insights" (by rarity / */
/* decks to watch — home-render.ts), not My Decks' own Stats view. Still */
/* pure/testable, in the same spirit as the rest of this module. */
/* -------------------------------------------------------------------------- */

const RARITY_LABELS: Record<string, string> = {
	common: "Common",
	uncommon: "Uncommon",
	rare: "Rare",
	mythic: "Mythic",
	special: "Special",
	bonus: "Bonus",
};

// Palette deliberately different from RARITY_COLORS (api/scryfall.ts): the
// latter colors a small set symbol (white for "common", consistent on a
// thin icon with its own outline) — a white "common" on a SOLID pie slice
// (or, since 2026-09-23, a plain colored word like CardPreviewModal's
// rarity label) would be invisible in light theme. Neutral gray here
// instead; silver/gold/orange taken as is, those hues remaining readable
// as a solid fill. Exported (renamed from RARITY_PIE_COLORS the same day)
// for this second consumer — the original name, scoped to the pie chart,
// no longer really described what the constant actually does: "a rarity
// color readable as a flat fill", not only "as a pie slice".
export const RARITY_SOLID_COLORS: Record<string, string> = {
	common: "#9a9a9a",
	uncommon: "#9fb4c7",
	rare: "#d4af37",
	mythic: "#d9662b",
	special: "#9fb4c7",
	bonus: "#d4af37",
};

export interface RarityBreakdownCard {
	rarity: string;
	count: number;
}

// Sorted by RARITY_ORDER (card-sorting.ts, already the same table used by
// "Sort by Rarity" elsewhere in this plugin) rather than by decreasing count
// like computeTypeBreakdown — here, as with colors above, a canonical order
// (common → mythic) stays more readable than an order that would reshuffle
// depending on the collection's content. Returns ColorSlice (not a new
// "RaritySlice" type): same exact shape ({label, color, count}), so
// renderColorPieChart (deck-stats-fx.ts) is reused as is, without a redundant
// second pie-chart drawer.
export function computeRarityBreakdown(cards: RarityBreakdownCard[]): ColorSlice[] {
	const counts = new Map<string, number>();
	cards.forEach((c) => {
		const key = (c.rarity || "common").toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + c.count);
	});
	return Array.from(counts.entries())
		.sort((a, b) => (RARITY_ORDER[a[0]] ?? 0) - (RARITY_ORDER[b[0]] ?? 0))
		.map(([key, count]) => ({
			label: RARITY_LABELS[key] ?? key,
			count,
			color: RARITY_SOLID_COLORS[key] ?? "#9a9a9a",
		}));
}

// "Probably not finished" threshold for Home's "Decks to Finish" block —
// deliberately a 2-tier heuristic (Commander-like = 100, everything else =
// 60), NOT a full per-format legality engine (Oathbreaker=60 but with its
// own sideboard rules, Tiny Leaders=50, Gladiator=100 also exist but are
// rare in this plugin's real usage) — a simple "worth watching" signal, not
// a legality check (see legal:/banned:/restricted:, card-search.ts, for a
// real check). Absent format = 60 (the most common default case).
const COMMANDER_LIKE_FORMATS = new Set(["commander", "duel", "paupercommander", "predh"]);

export function deckMinimumSize(format: string | undefined): number {
	return format && COMMANDER_LIKE_FORMATS.has(format) ? 100 : 60;
}

export interface DeckSizeStatus {
	mainboardCount: number;
	minimum: number;
	isBelowMinimum: boolean;
}

// Counts the mainboard SCOPE (cardsInDeckStatsScope, earlier in this file
// — excludes sideboard/maybeboard) against deckMinimumSize(format) above —
// same count weighting as the rest of this file.
export function getDeckSizeStatus(deck: { format?: string; cards: DeckCard[] }): DeckSizeStatus {
	const mainboardCount = totalStatsCardCount(cardsInDeckStatsScope(deck.cards));
	const minimum = deckMinimumSize(deck.format);
	return { mainboardCount, minimum, isBelowMinimum: mainboardCount < minimum };
}
