import { detectDeckCardFunction, deckFunctionSortKey } from "./deck-function";

/* -------------------------------------------------------------------------- */
/*  Group by / Sort by                                                        */
/* -------------------------------------------------------------------------- */

// "stacks" (2026-09-02) — Archidekt-style "card piles" view, My Decks only
// (see renderDeckStacksView, view.ts): one column per group, cards stacked
// with overlap rather than one row/tile per card. The type stays common to
// the three sections (like the 4 existing values) even though this mode is
// never offered for list/wantlist — same reason as for CardViewMode itself:
// a 2nd type just for one extra value would have been more machinery than
// the per-scope guard it replaces.
export type CardViewMode = "list" | "grid" | "table" | "card" | "stacks";

// On phone, only List and Card are offered (the CSS hides the
// Grid/Table/Stacks buttons, see `.is-phone .mtg-view-toggle` in styles.css) —
// but collectionViewMode/deckViewMode/wantlistViewMode are ONE setting synced
// between devices (data.json): a "grid" set on the Mac, or on the phone before
// this restriction, was still applied to the rendering, with no active button
// in the bar. We do NOT rewrite the setting (the Mac/iPad preference survives
// a visit on the phone): only the display falls back to "list".
export const PHONE_VIEW_MODES: readonly CardViewMode[] = ["list", "card"];

export function effectiveViewMode(mode: CardViewMode, isPhone: boolean): CardViewMode {
	return isPhone && !PHONE_VIEW_MODES.includes(mode) ? "list" : mode;
}

// Read at each render (not frozen at load): `.is-phone` is a <body> class
// that Obsidian toggles live on resize, like the CSS that hides the buttons —
// the two thus stay in agreement.
export function phoneAwareViewMode(mode: CardViewMode): CardViewMode {
	return effectiveViewMode(mode, document.body.classList.contains("is-phone"));
}

export function viewModeClass(mode: CardViewMode, scope: "list" | "deck" | "wantlist"): string {
	if (mode === "grid") return " mtg-collection-list-grid";
	if (mode === "card") return " mtg-collection-list-cards";
	// "stacks" view: no grid of equal-sized tiles nor vertically stacked rows
	// (.mtg-card-row-outer) — renderDeckStacksView builds its own column
	// structure directly, this class only serves to frame the container's CSS
	// styling (.mtg-deck-stacks).
	if (mode === "stacks") return " mtg-collection-list-stacks";
	if (mode === "table") {
		if (scope === "deck") return " mtg-collection-list-table mtg-collection-list-table-deck";
		if (scope === "wantlist") return " mtg-collection-list-table mtg-collection-list-table-wantlist";
		return " mtg-collection-list-table mtg-collection-list-table-collection";
	}
	return "";
}

// Column headings shown in Table mode, depending on context. "Mana Value" right after "Name"
// (the most natural reading order — a card's cost is traditionally read right after its name):
// this column order MUST stay in sync with the order in which each
// buildCollectionCardRow/buildDeckCardRow/buildWantlistCardRow inserts its cells in the DOM
// (see the comment on .mtg-collection-list-table in styles.css — without an explicit
// grid-column, the visual order of the cells follows the DOM order).
export const TABLE_COLUMNS_COLLECTION = [
	"Name",
	"Mana value",
	"Set",
	"Number",
	"Language",
	"Condition",
	"Qty",
	"Price",
];
// "Legality" (the colored dot, see deckLegalityBadge in card-search.ts and the
// dedicated column of buildDeckCardRow, view.ts) exists ONLY for Deck — a deck
// has a declared format (Deck.format), a list or a wantlist does not, so no
// equivalent column for TABLE_COLUMNS_COLLECTION/_WANTLIST.
// "Language"/"Condition" — My Decks/My Collection harmonization (2026-08-25):
// DeckCard now carries the same fields (see data-model.ts), the same 2 columns
// as TABLE_COLUMNS_COLLECTION, at the same place in the order (right after
// "Number").
export const TABLE_COLUMNS_DECK = [
	"Name",
	"Mana value",
	"Set",
	"Number",
	"Language",
	"Condition",
	"Qty",
	"Legality",
	"Price",
];
export const TABLE_COLUMNS_WANTLIST = ["Name", "Mana value", "Set", "Number", "Qty", "Price"];

export type GroupByOption =
	| "none"
	| "artist"
	| "color"
	| "dateAdded"
	// My Decks only (see DECK_GROUP_BY_OPTIONS below): the card's "function"
	// in the deck (Ramp/Removal/Draw/Tokens/etc.), detected automatically from
	// oracleText/keywords (detectDeckCardFunction, ./deck-function) — see
	// SortableCard further down for the required fields.
	| "function"
	| "manaValue"
	| "name"
	| "quantity"
	| "rarity"
	| "set"
	| "type";

export type SortByOption =
	| "artist"
	| "collectorNumber"
	| "color"
	| "dateAdded"
	| "dateModified"
	| "listName"
	| "manaValue"
	| "name"
	| "price"
	| "quantity"
	| "rarity"
	| "releasedAt"
	| "set"
	| "type";

export const GROUP_BY_OPTIONS: { value: GroupByOption; label: string }[] = [
	{ value: "none", label: "Don't group" },
	{ value: "artist", label: "Artist" },
	{ value: "color", label: "Color" },
	{ value: "dateAdded", label: "Creation date" },
	{ value: "manaValue", label: "Mana value" },
	{ value: "name", label: "Name" },
	{ value: "quantity", label: "Quantity" },
	{ value: "rarity", label: "Rarity" },
	{ value: "set", label: "Set" },
	{ value: "type", label: "Type" },
];

// My Decks only — GROUP_BY_OPTIONS + "Function", right after "Don't Group".
// Also carried "Category" (Commander/Mainboard/Sideboard/Maybeboard) until
// 2026-09-07: removed on explicit request ("Commander is not a category") in
// favor of the board tabs (DeckBoardTab, data-model.ts, see
// renderDeckBoardTabs in view.ts) — the only grouping still specific to
// decks is therefore "Function" now. List/Wantlist keep GROUP_BY_OPTIONS as
// is (renderGroupSortBar chooses between the two according to `scope`).
export const DECK_GROUP_BY_OPTIONS: { value: GroupByOption; label: string }[] = [
	GROUP_BY_OPTIONS[0],
	{ value: "function", label: "Function" },
	...GROUP_BY_OPTIONS.slice(1),
];

export const SORT_BY_OPTIONS: { value: SortByOption; label: string }[] = [
	{ value: "artist", label: "Artist" },
	{ value: "collectorNumber", label: "Collector's number" },
	{ value: "color", label: "Color" },
	{ value: "dateAdded", label: "Creation date" },
	{ value: "dateModified", label: "Date modified" },
	{ value: "listName", label: "List name" },
	{ value: "manaValue", label: "Mana value" },
	{ value: "name", label: "Name" },
	{ value: "price", label: "Price" },
	{ value: "quantity", label: "Quantity" },
	{ value: "rarity", label: "Rarity" },
	{ value: "releasedAt", label: "Release date" },
	{ value: "set", label: "Set" },
	{ value: "type", label: "Type" },
];

export const LIST_GRID_SORT_OPTIONS: { value: "name" | "dateCreated" | "cardCount" | "price"; label: string }[] = [
	{ value: "name", label: "Alphabetical" },
	{ value: "dateCreated", label: "Date created" },
	{ value: "cardCount", label: "Number of cards" },
	{ value: "price", label: "Price" },
];

// No "price" here: this sorts the decks themselves, and a deck tile shows no total
// value (which boards would count?). "Price" does exist for the CARDS of a deck,
// see DECK_SORT_BY_OPTIONS.
export const DECK_GRID_SORT_OPTIONS: { value: "name" | "dateCreated" | "cardCount"; label: string }[] = [
	{ value: "name", label: "Alphabetical" },
	{ value: "dateCreated", label: "Date created" },
	{ value: "cardCount", label: "Number of cards" },
];

// Deck cards have no list membership and no recorded release date: these two
// criteria make no sense for a deck. They DO have a price (real persisted fields
// since 2026-09-02, see toDeckPricedCard), so "Price" is offered, sorted by the
// same displayed price as in My Collection (2026-10-09).
export const DECK_SORT_BY_OPTIONS = SORT_BY_OPTIONS.filter(
	(o) => o.value !== "listName" && o.value !== "releasedAt"
);

// Wantlist cards keep price and release date, but "listName" resolves
// against settings.lists (the My Collection lists): meaningless for a card
// that lives in a wantlist.
export const WANTLIST_SORT_BY_OPTIONS = SORT_BY_OPTIONS.filter((o) => o.value !== "listName");

export const RARITY_ORDER: Record<string, number> = {
	common: 0,
	uncommon: 1,
	rare: 2,
	special: 2,
	mythic: 3,
	bonus: 3,
};

export const COLOR_LETTER_ORDER: Record<string, number> = { W: 0, U: 1, B: 2, R: 3, G: 4 };
export const COLOR_NAMES: Record<string, string> = {
	W: "White",
	U: "Blue",
	B: "Black",
	R: "Red",
	G: "Green",
};

// Indicative hue per mana color, used to visually accent group headers when
// grouping/sorting by Color.
export const COLOR_HEX: Record<string, string> = {
	W: "#d8c988",
	U: "#4a90d9",
	B: "#8a7ba8",
	R: "#e0643a",
	G: "#4f9e5c",
};

// Same principle, but per group label: also covers categories that have no
// single color letter (Land, Multicolor, Colorless).
export const GROUP_LABEL_HEX: Record<string, string> = {
	White: COLOR_HEX.W,
	Blue: COLOR_HEX.U,
	Black: COLOR_HEX.B,
	Red: COLOR_HEX.R,
	Green: COLOR_HEX.G,
	Multicolor: "#c9a227",
	Land: "#8a6d4a",
	Colorless: "#9a9a9a",
};

export const MAIN_TYPES = [
	"Land",
	"Creature",
	"Artifact",
	"Enchantment",
	"Instant",
	"Sorcery",
	"Planeswalker",
	"Battle",
	"Kindred",
	"Tribal",
];

export function primaryType(typeLine: string): string {
	const prefix = (typeLine || "").split("—")[0];
	const found = MAIN_TYPES.find((t) => prefix.includes(t));
	return found || prefix.trim() || "Other";
}

export function isLand(typeLine: string): boolean {
	return /\bLand\b/.test(typeLine || "");
}

// Common fields needed for sorting/grouping, shared by collection cards
// (CollectionCard) and deck cards (DeckCard). listId is optional because absent
// from deck cards. There is no price field here on purpose: what "Price" sorts
// by depends on the finish and the display currency, so the caller passes a
// `priceOf` function (see compareCardsBy).
export interface SortableCard {
	name: string;
	setName: string;
	setCode: string;
	collectorNumber: string;
	rarity: string;
	manaValue: number;
	typeLine: string;
	artist: string;
	colors: string[];
	count: number;
	dateAdded: number;
	dateModified: number;
	listId?: string;
	// Absent from a DeckCard (the "Release Date" sort isn't offered in a deck, see DECK_SORT_BY_OPTIONS).
	releasedAt?: string;
	// "Group by Function" (My Decks only, see deck-function.ts) —
	// oracleText/keywords already exist on
	// CollectionCard/WantlistCard/DeckCard (see types.ts/data-model.ts), so
	// nothing to add on the caller side for all 3 to structurally satisfy this
	// field; only deckFunctionOverride is specific to DeckCard (absent
	// elsewhere, hence always undefined outside a deck).
	oracleText?: string;
	keywords?: string[];
	deckFunctionOverride?: string;
}

// 0-4 for a single color (WUBRG order), 5.xx for each precise multicolor
// combination (sub-sorted by WUBRG bitmask for a stable, consistent order
// between groups), 6 land, 7 colorless.
export function colorSortKey(card: SortableCard): number {
	if (isLand(card.typeLine)) return 6;
	const colors = card.colors ?? [];
	if (colors.length === 0) return 7;
	if (colors.length === 1) return COLOR_LETTER_ORDER[colors[0]] ?? 7;
	const mask = colors.reduce((m, c) => m | (1 << (COLOR_LETTER_ORDER[c] ?? 0)), 0);
	return 5 + mask / 100; // stays within (5,6), between "single color" and "Land"
}

// Lands get their own "Land" category rather than being drowned in
// "Colorless", which then only concerns non-land artifacts/colorless cards.
// Multicolor cards are sub-sorted by exact color combination (e.g.
// "Green/Red") rather than drowned in a single "Multicolor" bucket.
export function colorGroupLabel(card: SortableCard): string {
	if (isLand(card.typeLine)) return "Land";
	const colors = card.colors ?? [];
	if (colors.length === 0) return "Colorless";
	if (colors.length === 1) return COLOR_NAMES[colors[0]] ?? "Colorless";
	const sorted = [...colors].sort(
		(a, b) => (COLOR_LETTER_ORDER[a] ?? 9) - (COLOR_LETTER_ORDER[b] ?? 9)
	);
	return sorted.map((c) => COLOR_NAMES[c] ?? c).join("/");
}

// Union of the colors of all the cards in a deck (each card already carries
// its own `colors` — see DeckCard/DeckSourceCard, data-model.ts), sorted
// WUBRG — the "color identity" shown on the deck's thumbnail in My Decks
// (mtg-deck-tile-colors, renderDeckGrid), modeled on the pips shown by
// Moxfield. Deliberately the union of the cards' own colors, not the
// "commander color identity" (which would also include the mana cost symbols
// in the rules text) — this plugin doesn't have that data per card, only
// `colors` (from the Scryfall field of the same name) is stored.
export function deckColorIdentity(cards: { colors: string[] }[]): string[] {
	const seen = new Set<string>();
	cards.forEach((c) => (c.colors ?? []).forEach((letter) => seen.add(letter)));
	return [...seen].sort((a, b) => (COLOR_LETTER_ORDER[a] ?? 9) - (COLOR_LETTER_ORDER[b] ?? 9));
}

// Numeric comparison when possible (collector numbers can contain letters,
// e.g. "23a"), otherwise alphabetical.
export function collectorNumberCompare(a: string, b: string): number {
	const na = parseInt(a, 10);
	const nb = parseInt(b, 10);
	if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
	return (a || "").localeCompare(b || "");
}

// Only the `id`/`name` of the My Collection lists matter here (not the whole plugin): this module thus
// stays pure, with no dependency on Obsidian or the plugin layer.
export type ListNameSource = readonly { id: string; name: string }[];

export function getListNameFor(lists: ListNameSource, card: { listId?: string }): string {
	if (!card.listId) return "";
	return lists.find((l) => l.id === card.listId)?.name ?? "";
}

// `priceOf` is the unit price a card is DISPLAYED at (finish and currency
// included: getCardPriceNumber, price.ts), injected rather than imported because
// price.ts -> card-search.ts -> this file would make an import cycle. It is
// required, not optional: sorting on `priceUsd` alone (the first version) ignored
// the foil/etched price and the EUR currency, so a list shown in euros came out
// in an order the visible prices contradicted.
export function compareCardsBy<T extends SortableCard>(
	sortBy: SortByOption,
	lists: ListNameSource,
	priceOf: (card: T) => number
): (a: T, b: T) => number {
	return (a, b) => {
		switch (sortBy) {
			case "artist":
				return (a.artist || "").localeCompare(b.artist || "");
			case "collectorNumber":
				return collectorNumberCompare(a.collectorNumber, b.collectorNumber);
			case "color":
				return colorSortKey(a) - colorSortKey(b) || a.name.localeCompare(b.name);
			case "dateAdded":
				return (a.dateAdded || 0) - (b.dateAdded || 0);
			case "dateModified":
				return (a.dateModified || 0) - (b.dateModified || 0);
			case "listName":
				return getListNameFor(lists, a).localeCompare(getListNameFor(lists, b));
			case "manaValue":
				return (a.manaValue ?? 0) - (b.manaValue ?? 0);
			case "price":
				return priceOf(a) - priceOf(b);
			case "quantity":
				return a.count - b.count;
			case "rarity":
				return (RARITY_ORDER[a.rarity] ?? 0) - (RARITY_ORDER[b.rarity] ?? 0);
			case "releasedAt":
				return (a.releasedAt || "").localeCompare(b.releasedAt || "");
			case "set":
				return a.setName.localeCompare(b.setName);
			case "type":
				return (a.typeLine || "").localeCompare(b.typeLine || "");
			case "name":
			default:
				return a.name.localeCompare(b.name);
		}
	};
}

export function groupSortValue<T extends SortableCard>(groupBy: GroupByOption, card: T): number | string {
	switch (groupBy) {
		// Always a STRING (never a bare number) — see deckFunctionSortKey
		// (deck-function.ts): groupOrderCmp (further down in this file) only
		// compares two values as numbers if BOTH sides are typeof "number"; mixing
		// numbers and strings in the same groupBy would fall back to an
		// alphabetical comparison of the number converted to text, not the
		// intended order.
		case "function":
			return deckFunctionSortKey(
				card.deckFunctionOverride || detectDeckCardFunction(card) || primaryType(card.typeLine)
			);
		case "color":
			return colorSortKey(card);
		case "rarity":
			return RARITY_ORDER[card.rarity] ?? 0;
		case "manaValue":
			return card.manaValue ?? 0;
		case "dateAdded":
			return card.dateAdded ?? 0;
		case "quantity":
			return card.count;
		case "artist":
			return card.artist || "";
		case "set":
			return card.setName;
		case "type":
			return primaryType(card.typeLine);
		case "name":
			return card.name;
		default:
			return "";
	}
}

export function groupLabelFor<T extends SortableCard>(groupBy: GroupByOption, card: T): string {
	switch (groupBy) {
		case "artist":
			return card.artist || "Unknown artist";
		// 3-step fallback (manual override > auto detection > card type) — see
		// getDeckCardFunction (data-model.ts) for the same chain reimplemented for
		// a specific DeckCard rather than a generic SortableCard (used by the
		// detail panel, not this file).
		case "function":
			return card.deckFunctionOverride || detectDeckCardFunction(card) || primaryType(card.typeLine);
		case "color":
			return colorGroupLabel(card);
		case "dateAdded":
			return card.dateAdded ? new Date(card.dateAdded).toLocaleDateString() : "Unknown";
		case "manaValue":
			return `Mana value ${card.manaValue ?? 0}`;
		case "name":
			return (card.name[0] || "#").toUpperCase();
		case "quantity":
			return `${card.count}x`;
		case "rarity":
			return card.rarity ? card.rarity.charAt(0).toUpperCase() + card.rarity.slice(1) : "Unknown";
		case "set":
			return card.setName;
		case "type":
			return primaryType(card.typeLine);
		default:
			return "";
	}
}

export interface CardGroup<T> {
	label: string;
	colorKeys?: string[];
	manaValueKey?: number;
	setCodeKey?: string;
	// Marks the "Recently Added" group pinned at the top of renderListDetail
	// (see further down) — never set by groupAndSortCards itself. A dedicated
	// boolean rather than a test on `label === "Recently Added"`: matching on
	// the label text would be fragile (a real group by type/rarity/etc. could
	// in theory carry that same label).
	isRecentlyAdded?: boolean;
	cards: T[];
}

// Distribution into tracks for the Stacks view (updateDeckStacksLayout,
// src/view/deck-render.ts, 2026-09-13) — see
// docs/history/deck-stats-and-stacks-views.md for the full history of why CSS
// `columns`/`column-fill: balance` (used from 2026-09-11 to 2026-09-13,
// "rounds 6-8") was abandoned: its target column height can never drop below
// the height of the TALLEST pile (each pile is an unfragmentable block,
// break-inside: avoid) — so as soon as a single group is clearly longer than
// the others (e.g. "Creature" with 45 copies under "Group by Type", whereas
// "Group by Function" spreads that same content over many more short piles),
// that target height becomes large enough to fit everything else into a
// handful of columns — leaving the remaining potential tracks (determined by
// width alone) entirely empty, whatever column-count/-width is (confirmed
// empirically: forcing column-count to 8 or 24 changes NOTHING about the
// number of columns actually populated for a given content — balance never
// recomputes its own minimum number of columns from column-count/-width, only
// the other way round). updateDeckStacksLayout therefore does the
// distribution itself (greedy "shortest track first"), relying on this PURE
// height estimate (no DOM measurement — a simple computation from the card
// count, like the -120%/the 488/680 ratio already used in CSS for the same
// pile, see the comment on .mtg-deck-stack-card in styles.css) to decide,
// BEFORE any rendering, which track is currently the shortest.
//
// STACK_TRACK_MIN_WIDTH_PX FIRST serves to estimate the relative height of a
// pile before distribution (a real measured width here would create a
// circular dependency with the choice of trackCount, see further down). Since
// a pile's height is affine in this width for ALL piles of the same view
// (same formula, same constant), the precise value chosen here never changes
// the relative ORDER of piles by height — only that relative comparison
// matters for the greedy distribution; it also serves as the MINIMUM track
// width in the computation of trackCount (updateDeckStacksLayout,
// src/view/deck-render.ts), taking over the role that `column-width: 220px`
// played in the old CSS mechanism. For a long time it never influenced the
// RENDERED width of a track (which is availableWidth/trackCount once
// trackCount is chosen) — that is no longer quite true since 2026-09-16 (see
// the comment of .mtg-deck-stack-track in styles.css and that of
// updateDeckStacksLayout): this same constant now ALSO serves as the floor of
// the track width cap, so that a narrow panel never sees that cap drop below
// this minimum comfort width already established.
// STACK_TRACK_GAP_PX, for its part, MUST stay strictly equal to the literal
// `gap` of .mtg-collection-list-stacks (styles.css) — expressed in px on both
// sides (not em) precisely so that JS and CSS cannot silently diverge from
// each other.
export const STACK_TRACK_MIN_WIDTH_PX = 220;
export const STACK_TRACK_GAP_PX = 20;

// Measured height (Browser pane, this file's real CSS) of
// .mtg-deck-stack-header + its own margin-bottom — ALWAYS the same
// whatever the group's label: .mtg-deck-stack-header-title is white-space:
// nowrap + text-overflow: ellipsis (styles.css), so it never wraps onto 2
// lines. A constant calibrated once via a real measurement is therefore
// exact, not just approximate.
const STACK_HEADER_BLOCK_HEIGHT_PX = 47;
// 680/488 (ratio of the "tile" image, see "Card view" in CLAUDE.md) minus
// the 120% overlap (.mtg-deck-stack-card + .mtg-deck-stack-card,
// styles.css) — same derivation as the comment of that CSS rule, repeated
// here in JS to estimate a pile's height without measuring it in the DOM.
const STACK_CARD_HEIGHT_RATIO = 680 / 488;
const STACK_SLIVER_HEIGHT_RATIO = STACK_CARD_HEIGHT_RATIO - 1.2;

// cardCount = number of distinct ROWS of the group (cardGroup.cards.length
// — one card per fanned element in the DOM), NOT the total quantity (sum of
// count): a singleton Commander deck conflates the two for every
// non-basic-land card (count is always 1), but a classic "4-of" deck does
// not — "4x Lightning Bolt" remains ONE single fanned row/card (with an
// "×4" badge), never 4 distinct stacked cards. Using the total quantity
// would strongly overestimate the real height of any group containing
// multi-copy cards.
export function estimateStackColumnHeight(cardCount: number): number {
	const cardHeight = STACK_TRACK_MIN_WIDTH_PX * STACK_CARD_HEIGHT_RATIO;
	const sliverHeight = STACK_TRACK_MIN_WIDTH_PX * STACK_SLIVER_HEIGHT_RATIO;
	return STACK_HEADER_BLOCK_HEIGHT_PX + cardHeight + Math.max(0, cardCount - 1) * sliverHeight;
}

// Number of rows rendered in the DOM at a time: on a big collection (tens of
// thousands of cards), building a real DOM node (image, stepper, buttons,
// listeners...) for every card at once freezes the interface for several
// seconds and loads as many images in parallel. A list therefore opens with
// only the first RENDER_BATCH_SIZE cards; the rest appears in batches as the
// user scrolls (see renderLoadMoreSentinel).
export const RENDER_BATCH_SIZE = 150;

// Truncates an already-sorted list of groups to a given total number of
// cards, cutting the last visible group in the middle if needed (rather than
// excluding whole groups), so that the number of rows actually displayed
// matches the requested limit exactly.
export function sliceGroupsForRender<T>(groups: CardGroup<T>[], limit: number): CardGroup<T>[] {
	const result: CardGroup<T>[] = [];
	let remaining = limit;
	for (const group of groups) {
		if (remaining <= 0) break;
		if (group.cards.length <= remaining) {
			result.push(group);
			remaining -= group.cards.length;
		} else {
			result.push({ ...group, cards: group.cards.slice(0, remaining) });
			remaining = 0;
		}
	}
	return result;
}

export function groupAndSortCards<T extends SortableCard>(
	cards: T[],
	groupBy: GroupByOption,
	sortBy: SortByOption,
	sortReverse: boolean,
	groupReverse: boolean,
	lists: ListNameSource,
	priceOf: (card: T) => number
): CardGroup<T>[] {
	const cmp = compareCardsBy<T>(sortBy, lists, priceOf);

	if (groupBy === "none") {
		const sorted = [...cards].sort(cmp);
		if (sortReverse) sorted.reverse();
		return [{ label: "", cards: sorted }];
	}

	const groupOrderCmp = (a: T, b: T) => {
		const va = groupSortValue(groupBy, a);
		const vb = groupSortValue(groupBy, b);
		if (typeof va === "number" && typeof vb === "number") return va - vb;
		return String(va).localeCompare(String(vb));
	};

	const order: string[] = [];
	const map = new Map<string, T[]>();
	[...cards]
		.sort(groupOrderCmp)
		.forEach((card) => {
			const label = groupLabelFor(groupBy, card);
			if (!map.has(label)) {
				map.set(label, []);
				order.push(label);
			}
			map.get(label)!.push(card);
		});

	const groups = order.map((label) => {
		const groupCards = map.get(label)!;
		const sorted = [...groupCards].sort(cmp);
		if (sortReverse) sorted.reverse();
		const groupColors = groupCards[0]?.colors ?? [];
		return {
			label,
			colorKeys:
				groupBy === "color" && groupColors.length >= 1
					? [...groupColors].sort(
							(a, b) => (COLOR_LETTER_ORDER[a] ?? 9) - (COLOR_LETTER_ORDER[b] ?? 9)
					  )
					// "Colorless" has its own official symbol ({C}, via Scryfall); "Land" has
					// none (it isn't a mana color), stays as text only.
					: groupBy === "color" && label === "Colorless"
					  ? ["C"]
					  : undefined,
			manaValueKey: groupBy === "manaValue" ? groupCards[0]?.manaValue ?? 0 : undefined,
			setCodeKey: groupBy === "set" ? groupCards[0]?.setCode : undefined,
			cards: sorted,
		};
	});

	if (groupReverse) groups.reverse();
	return groups;
}
