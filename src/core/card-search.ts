import { Finish, LANGUAGES, getCondition } from "./card-model";
import { MAIN_TYPES, isLand } from "./card-sorting";

// Enriched keyword search, with facets: keywords of the SAME category
// combine with OR ("green" + "blue" = green OR blue), whereas different
// categories combine with AND ("rare" + "blue" = rare AND blue). This is the
// usual behavior of faceted filters (Scryfall, most deckbuilders). Free text
// (name/set/artist/type) stays AND: each word must be found somewhere.
export const COLOR_SEARCH_KEYWORDS: Record<string, string> = {
	white: "W",
	blue: "U",
	black: "B",
	red: "R",
	green: "G",
};

export const RARITY_SEARCH_KEYWORDS = ["common", "uncommon", "rare", "mythic"];

export interface SearchableCard {
	name: string;
	rarity: string;
	typeLine: string;
	setName: string;
	setCode?: string;
	collectorNumber?: string;
	artist: string;
	colors: string[];
	language?: string;
	condition?: string;
	finish?: Finish;
	keywords?: string[];
	manaValue?: number;
	priceUsd?: string;
	count?: number;
	dateAdded?: number;
	// Border/frame ("border" category, see BORDER_SEARCH_OPTIONS and
	// borderTokenMatches further down) — unlike "legality", this data IS an
	// intrinsic field of the card (persisted on
	// CollectionCard/DeckCard/WantlistCard themselves, see their own comment in
	// types.ts/data-model.ts), so no need for a Map supplied separately by the
	// caller — borderTokenMatches can join TOKEN_MATCHERS directly.
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	// Rules text ("oracle" category, "oracle:" filter) — same reason for being
	// optional as borderColor/frame/frameEffects above: an intrinsic and
	// IMMUTABLE piece of card data (a printing's oracle text never changes,
	// barring errata — very rare), hence persisted directly on the card rather
	// than through a separate Map like "legality" below. Combines both faces
	// for a double-faced card (see buildCardTextInfo, scryfall.ts, already
	// used by the "Card Text" box of the card detail — same function, same
	// result, just persisted here rather than re-fetched each time the modal
	// opens).
	oracleText?: string;
	// Needed only for the "legality" category (see legalityTokenMatches
	// below): legality itself is never stored on the card (see
	// MTGCollectionPlugin.legalitiesCache, never persisted), so the matcher
	// has to resolve it separately via this id, in a Map supplied separately
	// by the caller — same reason for existing as recentlyAddedIds a little
	// further down in this file.
	scryfallId?: string;
}

export type TokenCategory =
	| "color"
	| "rarity"
	| "language"
	| "condition"
	| "foil"
	| "type"
	| "keyword"
	| "artist"
	| "set"
	| "cardnum"
	| "numeric_cmc"
	| "numeric_price"
	| "numeric_qty"
	| "numeric_added"
	| "recentlyadded"
	| "legality"
	| "border"
	| "oracle"
	| "text";

export const TYPE_SEARCH_KEYWORDS = [...MAIN_TYPES, "Legendary", "Basic", "Snow", "World"];

// "mint" used to point to NM before the distinct MT tier was added (see
// CONDITIONS, types.ts) — now reserved for MT alone, so that
// recognizeKeywordToken() (a .find(), the first match in array order wins)
// doesn't resolve "mint" to the wrong tier.
export const CONDITION_SEARCH_ENTRIES: { value: string; keywords: string[] }[] = [
	{ value: "MT", keywords: ["mt", "mint"] },
	{ value: "NM", keywords: ["nm", "near"] },
	{ value: "EX", keywords: ["ex", "excellent"] },
	{ value: "GD", keywords: ["gd", "good"] },
	{ value: "LP", keywords: ["lp", "light"] },
	{ value: "PL", keywords: ["pl", "played"] },
	{ value: "PO", keywords: ["po", "poor"] },
];

export const LEGALITY_SEARCH_FORMATS: { key: string; label: string }[] = [
	{ key: "standard", label: "Standard" },
	{ key: "pioneer", label: "Pioneer" },
	{ key: "modern", label: "Modern" },
	{ key: "legacy", label: "Legacy" },
	{ key: "vintage", label: "Vintage" },
	{ key: "commander", label: "Commander" },
	{ key: "pauper", label: "Pauper" },
	{ key: "brawl", label: "Brawl" },
	{ key: "gladiator", label: "Gladiator" },
	{ key: "timeless", label: "Timeless" },
	{ key: "future", label: "Future" },
	{ key: "historic", label: "Historic" },
	{ key: "penny", label: "Penny Dreadful" },
	{ key: "oathbreaker", label: "Oathbreaker" },
	{ key: "standardbrawl", label: "Standard Brawl" },
	{ key: "competitivebrawl", label: "Competitive Brawl" },
	{ key: "alchemy", label: "Alchemy" },
	{ key: "paupercommander", label: "Pauper Commander" },
	{ key: "duel", label: "Duel Commander" },
	{ key: "oldschool", label: "Old School" },
	{ key: "premodern", label: "Premodern" },
	{ key: "predh", label: "PreDH" },
	{ key: "tlr", label: "Tiny Leaders" },
];

// The 3 legality search prefixes — "legal:"/"banned:"/"restricted:" ALL
// three exist as is on Scryfall's side (confirmed live on /cards/search on
// 2026-08-21: banned:legacy and restricted:vintage return real results, not
// just legal:). A single "legality" category for the 3 rather than 3
// separate categories — the underlying mechanism is identical (format +
// legalities Map supplied by the caller, see legalityTokenMatches), only the
// status searched for differs. No prefix is a prefix of another, so the
// order of this array doesn't matter for matchLegalityPrefix below.
const LEGALITY_STATUS_PREFIXES: { prefix: string; status: string }[] = [
	{ prefix: "legal:", status: "legal" },
	{ prefix: "banned:", status: "banned" },
	{ prefix: "restricted:", status: "restricted" },
];

function matchLegalityPrefix(q: string): { prefix: string; status: string } | undefined {
	return LEGALITY_STATUS_PREFIXES.find((p) => q.startsWith(p.prefix));
}

// Translates a raw Scryfall status (legalities[format], e.g.
// "legal"/"banned"/"restricted"/"not_legal") into the CSS class of the
// matching tile in the "Legal Formats" block (see .mtg-legal-format-tile
// .is-* in styles.css, and renderLegalityColorLegend, card-detail-fx.ts,
// for the legend that explains this color code). "not_legal" and any
// missing/unknown value stay on the tile's default neutral appearance (no
// class added) — no need for a 4th special case, the tile's "at rest"
// state IS already that rendering. Pure function (no DOM) rather than
// inline in the 2 modals that use it: shared between CardDetailModal and
// WantlistCardDetailModal, and covered by a test (unlike the rest of these
// 2 files, see "Conventions" of the project's CLAUDE.md).
export function legalityStatusClass(status: string | undefined): string | null {
	if (status === "legal") return "is-legal";
	if (status === "restricted") return "is-restricted";
	if (status === "banned") return "is-banned";
	return null;
}

// Small per-card legality badge in My Decks (see
// buildDeckCardRow/buildDeckCardTile, view.ts) — distinct from
// legalityStatusClass above: this badge concerns only ONE format at a time
// (the one chosen for the deck, Deck.format), so unlike the grid of 23
// "Legal Formats" tiles (where "not_legal" is the expected neutral state for
// most formats, never highlighted), "not_legal" HERE is real, wanted
// information — the card breaks the legality of the format the deck gave
// itself, worth flagging. `status` undefined = legality not loaded yet (see
// MTGCollectionPlugin.getCachedLegalities) or unrecognized format: returns
// null, to show nothing rather than a misleading neutral badge.
export function deckLegalityBadge(
	status: string | undefined,
	formatLabel: string
): { cls: string; title: string } | null {
	if (status === "legal") return { cls: "is-legal", title: `Legal in ${formatLabel}` };
	if (status === "restricted") return { cls: "is-restricted", title: `Restricted in ${formatLabel}` };
	if (status === "banned") return { cls: "is-banned", title: `Banned in ${formatLabel}` };
	if (status === "not_legal") return { cls: "is-not-legal", title: `Not legal in ${formatLabel}` };
	return null;
}

export interface BorderSearchOption {
	value: string; // suffix after "border:", e.g. "border:showcase"
	label: string;
	scryfallClause: string;
	matches: (card: SearchableCard) => boolean;
}

export const BORDER_SEARCH_OPTIONS: BorderSearchOption[] = [
	{
		value: "borderless",
		label: "Borderless",
		scryfallClause: "border:borderless",
		matches: (c) => c.borderColor === "borderless",
	},
	{
		value: "extended",
		label: "Extended art",
		scryfallClause: "frame:extendedart",
		matches: (c) => !!c.frameEffects?.includes("extendedart"),
	},
	{
		value: "showcase",
		label: "Showcase",
		scryfallClause: "frame:showcase",
		matches: (c) => !!c.frameEffects?.includes("showcase"),
	},
	// Neither a border color nor a frame_effect — it is the old frame (frame
	// === "1997"), used by "retro frame" reprints (e.g. Dominaria Remastered).
	{
		value: "retro",
		label: "Retro frame",
		scryfallClause: "frame:1997",
		matches: (c) => c.frame === "1997",
	},
	{
		value: "black",
		label: "Black border",
		scryfallClause: "border:black",
		matches: (c) => c.borderColor === "black",
	},
	{
		value: "white",
		label: "White border",
		scryfallClause: "border:white",
		matches: (c) => c.borderColor === "white",
	},
	{
		value: "silver",
		label: "Silver border",
		scryfallClause: "border:silver",
		matches: (c) => c.borderColor === "silver",
	},
	// 0 known cards with this value as of 2026-08-16 (confirmed live on
	// /cards/search), but it is a border_color value genuinely recognized by
	// Scryfall — kept to stay correct if a future card uses it.
	{
		value: "gold",
		label: "Gold border",
		scryfallClause: "border:gold",
		matches: (c) => c.borderColor === "gold",
	},
	{
		value: "yellow",
		label: "Yellow border",
		scryfallClause: "border:yellow",
		matches: (c) => c.borderColor === "yellow",
	},
];

// Most common keyword abilities, used for autocompletion and for the
// "recognized" rendering of chips. The actual matching (tokenMatchesCard) is
// done directly on the "keywords" array supplied by Scryfall for each card,
// so an ability missing from this list remains searchable all the same (just
// with no dedicated chip or suggestion).
export const KEYWORD_ABILITIES = [
	"Flying",
	"Trample",
	"Haste",
	"Vigilance",
	"Deathtouch",
	"Lifelink",
	"Reach",
	"Menace",
	"Hexproof",
	"Indestructible",
	"First strike",
	"Double strike",
	"Defender",
	"Flash",
	"Prowess",
	"Ward",
	"Flashback",
	"Convoke",
	"Delve",
	"Cycling",
	"Regenerate",
	"Shroud",
	"Fear",
	"Intimidate",
	"Cascade",
	"Persist",
	"Undying",
	"Wither",
	"Infect",
	"Exalted",
	"Extort",
	"Bestow",
	"Outlast",
	"Dash",
	"Renown",
	"Skulk",
	"Afterlife",
	"Mentor",
	"Foretell",
	"Blitz",
	"Training",
	"Reconfigure",
	"Enlist",
	"Riot",
	"Adamant",
];

// Filterable numeric fields. "aliases" serves to recognize the typed word
// (to trigger the visual composer); the final stored token is always
// "<field><operator><value>" (e.g. "cmc>3"), whether it was built through
// the operator buttons or typed directly by an expert user.
export interface NumericFieldDef {
	key: "cmc" | "price" | "qty" | "added";
	label: string;
	category: TokenCategory;
	aliases: string[];
	valueType: "number" | "date";
}

export const NUMERIC_FIELDS: NumericFieldDef[] = [
	{
		key: "cmc",
		label: "Mana value",
		category: "numeric_cmc",
		aliases: ["cmc", "mana value", "manavalue", "mv"],
		valueType: "number",
	},
	{
		key: "price",
		label: "Price",
		category: "numeric_price",
		aliases: ["price", "cost"],
		valueType: "number",
	},
	{
		key: "qty",
		label: "Quantity",
		category: "numeric_qty",
		aliases: ["qty", "quantity", "count"],
		valueType: "number",
	},
	{
		key: "added",
		label: "Date added",
		category: "numeric_added",
		aliases: ["added", "date added", "date"],
		valueType: "date",
	},
];

export const NUMERIC_OPERATORS = ["<", "<=", "=", ">=", ">"] as const;
export type NumericOperator = (typeof NUMERIC_OPERATORS)[number];

// The value can be a number (cmc/price/qty) or an ISO date (added).
export const NUMERIC_TOKEN_RE = /^(cmc|price|qty|added)(>=|<=|>|<|=)(\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?)$/i;

export function matchNumericField(query: string): NumericFieldDef | null {
	const q = query.trim().toLowerCase();
	if (q.length < 2) return null;
	return NUMERIC_FIELDS.find((f) => f.aliases.some((a) => a.startsWith(q))) ?? null;
}

export interface ParsedNumericToken {
	field: NumericFieldDef;
	operator: NumericOperator;
	value: number; // raw number, or the timestamp of midnight (start of day) for a date
	rawDateStr?: string; // original "YYYY-MM-DD" text, for displaying the chip
}

export function parseNumericToken(token: string): ParsedNumericToken | null {
	const match = NUMERIC_TOKEN_RE.exec(token.trim());
	if (!match) return null;
	const field = NUMERIC_FIELDS.find((f) => f.key === match[1].toLowerCase());
	if (!field) return null;
	const operator = match[2] as NumericOperator;

	if (field.valueType === "date") {
		const [y, mo, d] = match[3].split("-").map(Number);
		const startOfDay = new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
		if (isNaN(startOfDay)) return null;
		return { field, operator, value: startOfDay, rawDateStr: match[3] };
	}
	return { field, operator, value: parseFloat(match[3]) };
}

export function numericTokenMatches(card: SearchableCard, token: string): boolean {
	const parsed = parseNumericToken(token);
	if (!parsed) return false;

	// For a date, we compare over the whole day: "= 2026-07-15" must match any
	// card added that day, whatever the exact time.
	if (parsed.field.valueType === "date") {
		if (card.dateAdded === undefined) return false;
		const startOfDay = parsed.value;
		const endOfDay = startOfDay + 24 * 60 * 60 * 1000 - 1;
		switch (parsed.operator) {
			case "<":
				return card.dateAdded < startOfDay;
			case "<=":
				return card.dateAdded <= endOfDay;
			case "=":
				return card.dateAdded >= startOfDay && card.dateAdded <= endOfDay;
			case ">=":
				return card.dateAdded >= startOfDay;
			case ">":
				return card.dateAdded > endOfDay;
		}
	}

	let cardValueNum: number | undefined;
	if (parsed.field.key === "cmc") cardValueNum = card.manaValue;
	else if (parsed.field.key === "price") cardValueNum = parseFloat(card.priceUsd || "0");
	else if (parsed.field.key === "qty") cardValueNum = card.count;
	if (cardValueNum === undefined || isNaN(cardValueNum)) return false;

	switch (parsed.operator) {
		case "<":
			return cardValueNum < parsed.value;
		case "<=":
			return cardValueNum <= parsed.value;
		case "=":
			return cardValueNum === parsed.value;
		case ">=":
			return cardValueNum >= parsed.value;
		case ">":
			return cardValueNum > parsed.value;
	}
}

export function categorizeToken(token: string): TokenCategory {
	const q = token.trim().toLowerCase();
	if (!q) return "text";
	if (q.startsWith("artist:")) return "artist";
	if (q.startsWith("set:")) return "set";
	// Explicit prefix required (like artist:/set: above), no bare form such as
	// "modern" recognized on its own: unlike a color/rarity name, a format
	// name has no reserved vocabulary of its own (nothing prevents a card from
	// being named "Legacy" or "Standard"), so the ambiguity can only be lifted
	// by requiring a prefix — "legal:"/"banned:"/"restricted:", see
	// LEGALITY_STATUS_PREFIXES.
	if (matchLegalityPrefix(q)) return "legality";
	// Same reasoning as "legal:" above: "border" has no reserved vocabulary of
	// its own (nothing prevents a card from being named "Showcase" or
	// "Retro"), so the explicit prefix is required.
	if (q.startsWith("border:")) return "border";
	if (q.startsWith("oracle:")) return "oracle";
	if (/^#\d+\S*$/.test(q)) return "cardnum";
	const numericMatch = parseNumericToken(token);
	if (numericMatch) return numericMatch.field.category;
	if (Object.keys(COLOR_SEARCH_KEYWORDS).some((name) => name.startsWith(q))) return "color";
	if (q.length >= 3 && ("multicolor".startsWith(q) || "colorless".startsWith(q))) return "color";
	if (RARITY_SEARCH_KEYWORDS.some((r) => r.startsWith(q))) return "rarity";
	// The condition must be checked before the language: "po" (abbreviation of
	// "Poor") is also a valid prefix of "Portuguese" — without this order, the
	// "Poor" chip silently filtered by Portuguese language instead of the
	// "Poor" condition (found through the SUGGESTABLE_KEYWORDS/categorizeToken
	// audit).
	if (
		q.length >= 2 &&
		(CONDITION_SEARCH_ENTRIES.some((e) => e.keywords.some((k) => k.startsWith(q))) ||
			"none".startsWith(q))
	)
		return "condition";
	if (LANGUAGES.some((l) => l.label.toLowerCase().startsWith(q))) return "language";
	if (
		q.length >= 3 &&
		(["foil", "nonfoil", "etched", "surged", "proxy"] as const).some((k) => k.startsWith(q))
	)
		return "foil";
	if (q.length >= 3 && "recent".startsWith(q)) return "recentlyadded";
	if (TYPE_SEARCH_KEYWORDS.some((t) => t.toLowerCase().startsWith(q))) return "type";
	if (q.length >= 3 && KEYWORD_ABILITIES.some((k) => k.toLowerCase().startsWith(q)))
		return "keyword";
	return "text";
}

// Resolves a color name (prefix, e.g. "bl") to its WUBRG letter — logic
// shared by colorTokenMatches below, chipTokenToScryfallClause ("color" case)
// and exact color identity ("=color", see isExactToken further down): each of
// the three had its own copy of this same
// `Object.entries(COLOR_SEARCH_KEYWORDS).find(...)` before this 3rd consumer
// made the duplication triple rather than double.
function resolveColorLetter(name: string): string | null {
	const q = name.trim().toLowerCase();
	const entry = Object.entries(COLOR_SEARCH_KEYWORDS).find(([n]) => n.startsWith(q));
	return entry ? entry[1] : null;
}

export function colorTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	const letter = resolveColorLetter(q);
	if (letter && (card.colors ?? []).includes(letter)) return true;
	if (q.length >= 3 && "multicolor".startsWith(q) && (card.colors ?? []).length > 1) return true;
	if (
		q.length >= 3 &&
		"colorless".startsWith(q) &&
		(card.colors ?? []).length === 0 &&
		!isLand(card.typeLine)
	)
		return true;
	return false;
}

export function rarityTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	return !!card.rarity && card.rarity.toLowerCase().startsWith(q);
}

export function languageTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	const matches = LANGUAGES.filter((l) => l.label.toLowerCase().startsWith(q));
	return matches.some((l) => (card.language ?? "en") === l.code);
}

export function conditionTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if ("none".startsWith(q) && (card.condition ?? "") === "") return true;
	return CONDITION_SEARCH_ENTRIES.some(
		(e) => e.keywords.some((k) => k.startsWith(q)) && (card.condition ?? "") === e.value
	);
}

export function foilTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	const finish = card.finish ?? "regular";
	if (q.length >= 3 && "etched".startsWith(q)) return finish === "etched";
	if (q.length >= 3 && "surged".startsWith(q)) return finish === "surged";
	if (q.length >= 3 && "proxy".startsWith(q)) return finish === "proxy";
	if (q.length >= 3 && "nonfoil".startsWith(q)) return finish === "regular" || finish === "proxy";
	if ("foil".startsWith(q)) return finish === "foiled" || finish === "etched" || finish === "surged";
	return false;
}

// Prefix match on the value OR the label (same convention as
// legalityTokenMatches further down), e.g. "border:ext" and "border:extended
// art" both resolve to the "extended" entry. A card id not yet caught up by
// MTGCollectionPlugin.backfillBorderData() (borderColor/frame/frameEffects
// all undefined) simply matches no entry — each matches() above compares to
// a precise value, never true on undefined — until the catch-up arrives,
// with no special handling needed here unlike legalityTokenMatches (no
// external Map to consult, this data lives directly on the card).
export function borderTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if (!q.startsWith("border:")) return false;
	const valueQuery = q.slice("border:".length);
	if (!valueQuery) return false;
	const entry = BORDER_SEARCH_OPTIONS.find(
		(o) => o.value.startsWith(valueQuery) || o.label.toLowerCase().startsWith(valueQuery)
	);
	return !!entry && entry.matches(card);
}

// Unlike borderTokenMatches above (values from a finite set, combined with
// OR like any orCategories entry), a text search is a free substring match —
// several "oracle:" tokens therefore combine with AND (each phrase must be
// found somewhere), same convention as textTokenMatches below rather than
// TOKEN_MATCHERS/orCategories (see its separate handling in
// cardMatchesTokens). Case-insensitive substring match on the raw text as
// supplied by Scryfall — mana symbols are written there as "{X}"/"{C}" etc.,
// so "oracle:add mana" will not match unless the braces are included
// ("oracle:add {c}"); documented in the help modals rather than normalized
// here.
export function oracleTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if (!q.startsWith("oracle:")) return false;
	const valueQuery = q.slice("oracle:".length).trim();
	if (!valueQuery) return false;
	return !!card.oracleText && card.oracleText.toLowerCase().includes(valueQuery);
}

export function typeTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	return !!card.typeLine && card.typeLine.toLowerCase().includes(q);
}

// These tokens are always built through a suggestion (never typed by hand,
// since an artist/set name can contain spaces): we therefore compare with
// strict equality rather than by prefix, with no possible ambiguity.
export function artistTokenMatches(card: SearchableCard, token: string): boolean {
	const value = token.trim().slice("artist:".length).toLowerCase();
	return card.artist.toLowerCase() === value;
}

export function setTokenMatches(card: SearchableCard, token: string): boolean {
	const value = token.trim().slice("set:".length).toLowerCase();
	return (card.setCode ?? "").toLowerCase() === value;
}

export function cardNumTokenMatches(card: SearchableCard, token: string): boolean {
	const value = token.trim().slice(1).toLowerCase();
	return (card.collectorNumber ?? "").toLowerCase() === value;
}

// Corresponds directly to the "keywords" array supplied by Scryfall for each
// card (e.g. ["Flying", "First strike"]): so it covers every existing
// ability, not only those listed in KEYWORD_ABILITIES.
export function keywordTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	return !!card.keywords?.some((k) => k.toLowerCase().startsWith(q));
}

// Unlike all the other matchers above, it cannot join TOKEN_MATCHERS (fixed
// signature (card, token) => boolean, with no external context): a card's
// legality isn't a field it carries itself (see SearchableCard.scryfallId
// above), it has to be resolved through a Map supplied by the caller — same
// reason as the "recentlyadded" category, handled separately in
// cardMatchesTokens for the same reason. An id missing from the Map
// (legalities not yet fetched for that card) never matches a positive token
// nor a negative one — a future re-render, once the background fetch has
// resolved (see MTGCollectionPlugin.bulkFetchLegalities), will then
// re-apply the filter with the data now known.
export function legalityTokenMatches(
	card: SearchableCard,
	token: string,
	legalitiesByScryfallId?: Map<string, Record<string, string>>
): boolean {
	const q = token.trim().toLowerCase();
	const legalityMatch = matchLegalityPrefix(q);
	if (!legalityMatch) return false;
	const formatQuery = q.slice(legalityMatch.prefix.length);
	if (!formatQuery) return false;
	const entry = LEGALITY_SEARCH_FORMATS.find(
		(f) => f.key.startsWith(formatQuery) || f.label.toLowerCase().startsWith(formatQuery)
	);
	if (!entry || !card.scryfallId) return false;
	const legalities = legalitiesByScryfallId?.get(card.scryfallId);
	return legalities?.[entry.key] === legalityMatch.status;
}

export function textTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if (!q) return true;
	if (card.name.toLowerCase().includes(q)) return true;
	if (card.typeLine && card.typeLine.toLowerCase().includes(q)) return true;
	if (card.setName && card.setName.toLowerCase().includes(q)) return true;
	if (card.artist && card.artist.toLowerCase().includes(q)) return true;
	if (card.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
	return false;
}

export const TOKEN_MATCHERS: Record<
	Exclude<TokenCategory, "text" | "recentlyadded" | "legality" | "oracle">,
	(card: SearchableCard, token: string) => boolean
> = {
	color: colorTokenMatches,
	rarity: rarityTokenMatches,
	language: languageTokenMatches,
	condition: conditionTokenMatches,
	foil: foilTokenMatches,
	type: typeTokenMatches,
	keyword: keywordTokenMatches,
	artist: artistTokenMatches,
	set: setTokenMatches,
	cardnum: cardNumTokenMatches,
	numeric_cmc: numericTokenMatches,
	numeric_price: numericTokenMatches,
	numeric_qty: numericTokenMatches,
	numeric_added: numericTokenMatches,
	border: borderTokenMatches,
};

// A token starting with "-" (e.g. "-red") excludes any card that would match
// that same token without the prefix, whatever its category. It is a global
// exclusion, independent of the OR/AND system of the positive tokens.
export function isNegatedToken(token: string): boolean {
	return token.trim().startsWith("-") && token.trim().length > 1;
}

export function stripNegation(token: string): string {
	return token.trim().slice(1);
}

// A token starting with "=" (e.g. "=blue") expresses an EXACT color identity
// rather than a simple containment: "blue" matches any card containing blue
// (including a white-blue multicolor card), whereas "=blue" ONLY matches
// cards whose colors are exactly {blue}, no more, no less — see
// cardMatchesTokens for the AND combination between several "=" tokens (e.g.
// "=blue" + "=white" = exactly blue-white, the equivalent of Scryfall's c=uw
// operator). Same mechanism as isNegatedToken/stripNegation above (prefix
// recognized whether it was typed by hand or set via the dedicated
// chip/icon), deliberately a prefix distinct from "-" rather than a combined
// state: the two are mutually exclusive (see the "=" toggle in
// renderChipFilter/renderSearchChipBar, which removes the other prefix when
// setting this one) but make no sense combined ("neither exactly blue nor
// not blue" would express nothing useful). Concept reserved for the "color"
// category (no other facet has a notion of "exact identity" to date) — an
// "=" token outside color is a fallback handled separately in
// cardMatchesTokens/buildScryfallQueryFromChips rather than being a
// validation error here.
export function isExactToken(token: string): boolean {
	return token.trim().startsWith("=") && token.trim().length > 1;
}

export function stripExact(token: string): string {
	return token.trim().slice(1);
}

// A multi-word phrase (e.g. after "oracle:") must be able to contain
// spaces without the "a space validates the chip being typed" mechanism
// (see renderChipFilter, view.ts, and its equivalent in
// add-cards-modal.ts) splitting it into several separate chips — reported
// bug: typing oracle:"prevent all damage" was cut at the first space, so
// the complete chip was never formed. As long as the number of straight
// quotes in the text being typed is odd (a quoted phrase still "open"), a
// space must NOT validate the chip — the standard behavior of a
// quote-aware search bar (Scryfall itself works this way). Generic, not
// specific to "oracle:": a future prefix needing a multi-word phrase
// benefits from the same mechanism with nothing to change here.
export function hasUnclosedQuote(text: string): boolean {
	return (text.match(/"/g) ?? []).length % 2 === 1;
}

// Once the chip is validated (space or Enter), removes the quotes that
// surrounded the value — the stored/compared token (categorizeToken,
// oracleTokenMatches, chipTokenToScryfallClause, recognizeKeywordToken)
// never needs nor handles quotes, which only serve to protect spaces while
// typing (see hasUnclosedQuote above). Scoped to the "oracle:" prefix: it's
// the only case today where a multi-word phrase is expected after the
// prefix.
export function stripQuotesFromCommittedToken(raw: string): string {
	const trimmed = raw.trim();
	const negated = isNegatedToken(trimmed);
	const base = negated ? stripNegation(trimmed) : trimmed;
	if (!base.toLowerCase().startsWith("oracle:")) return trimmed;
	const value = base.slice("oracle:".length).trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return `${negated ? "-" : ""}oracle:${value.slice(1, -1).trim()}`;
	}
	return trimmed;
}

// Categories that make no sense for a Scryfall search (they are attributes
// specific to OUR collection, not to the card at Scryfall): physical
// condition, quantity owned, date added. Set and artist have their own
// dedicated field in the search modal (not the chip), so they are excluded
// here too to avoid a double system.
export const SEARCH_EXCLUDED_CATEGORIES: TokenCategory[] = [
	"condition",
	"numeric_qty",
	"numeric_added",
	"recentlyadded",
	"artist",
	"set",
];

// Translates a single token (e.g. "blue", "-rare", "cmc>3") into the matching
// Scryfall clause (e.g. "c:u", "-r:rare", "cmc>3"). Returns null if the
// category is excluded from the search or unrecognized.
export function chipTokenToScryfallClause(token: string): string | null {
	const negated = isNegatedToken(token);
	const base = negated ? stripNegation(token) : token;
	const q = base.trim().toLowerCase();
	if (!q) return null;
	const cat = categorizeToken(base);
	if (SEARCH_EXCLUDED_CATEGORIES.includes(cat)) return null;
	const prefix = negated ? "-" : "";

	switch (cat) {
		case "color": {
			if ("multicolor".startsWith(q)) return `${prefix}c:m`;
			if ("colorless".startsWith(q)) return `${prefix}c:c`;
			const letter = resolveColorLetter(q);
			return letter ? `${prefix}c:${letter.toLowerCase()}` : null;
		}
		case "rarity": {
			const r = RARITY_SEARCH_KEYWORDS.find((r) => r.startsWith(q));
			return r ? `${prefix}r:${r}` : null;
		}
		case "type": {
			const t = TYPE_SEARCH_KEYWORDS.find((t) => t.toLowerCase().startsWith(q));
			return t ? `${prefix}t:${t.toLowerCase()}` : null;
		}
		case "keyword": {
			const k = KEYWORD_ABILITIES.find((k) => k.toLowerCase().startsWith(q));
			return k ? `${prefix}keyword:"${k}"` : null;
		}
		case "foil": {
			// "proxy" and "surged" have no equivalent on Scryfall's side ("surged" is
			// a status specific to our collection — Scryfall has no documented
			// is:surgefoil operator, unlike is:etched): ignored here, the chip remains
			// useful for filtering our own owned cards.
			if (q.length >= 3 && "etched".startsWith(q)) return `${prefix}is:etched`;
			if (q.length >= 3 && "surged".startsWith(q)) return null;
			if (q.length >= 3 && "proxy".startsWith(q)) return null;
			if (q.length >= 3 && "nonfoil".startsWith(q)) return negated ? "is:foil" : "-is:foil";
			if ("foil".startsWith(q)) return `${prefix}is:foil`;
			return null;
		}
		case "language": {
			const l = LANGUAGES.find((l) => l.label.toLowerCase().startsWith(q));
			return l ? `${prefix}lang:${l.code}` : null;
		}
		case "numeric_cmc": {
			const parsed = parseNumericToken(base);
			return parsed ? `${prefix}cmc${parsed.operator}${parsed.value}` : null;
		}
		case "numeric_price": {
			const parsed = parseNumericToken(base);
			return parsed ? `${prefix}usd${parsed.operator}${parsed.value}` : null;
		}
		case "legality": {
			// Unlike condition/qty/added (excluded via SEARCH_EXCLUDED_CATEGORIES,
			// specific to our collection), legality IS a Scryfall concept —
			// legal:/banned:/restricted: exist as is on Scryfall's side (see
			// LEGALITY_STATUS_PREFIXES), so the "Add Cards" modal can pass the token
			// through directly rather than filter it out.
			const legalityMatch = matchLegalityPrefix(q);
			if (!legalityMatch) return null;
			const formatQ = q.slice(legalityMatch.prefix.length);
			const entry = LEGALITY_SEARCH_FORMATS.find(
				(f) => f.key.startsWith(formatQ) || f.label.toLowerCase().startsWith(formatQ)
			);
			return entry ? `${prefix}${legalityMatch.prefix}${entry.key}` : null;
		}
		case "border": {
			// Same reasoning as "legality" above: border/frame ARE Scryfall concepts
			// (border:/frame: exist as is), so passed through directly rather than
			// filtered (see BORDER_SEARCH_OPTIONS for the value → clause translation).
			const valueQ = q.slice("border:".length);
			const entry = BORDER_SEARCH_OPTIONS.find(
				(o) => o.value.startsWith(valueQ) || o.label.toLowerCase().startsWith(valueQ)
			);
			return entry ? `${prefix}${entry.scryfallClause}` : null;
		}
		case "oracle": {
			// Unlike condition/qty/added (excluded), "oracle:" IS the real Scryfall
			// operator (oracle:"...") — passed through directly, in quotes to cover a
			// multi-word phrase. Any quote in the typed value is removed rather than
			// escaped: it would otherwise break the generated clause.
			const value = q.slice("oracle:".length).trim().replace(/"/g, "");
			return value ? `${prefix}oracle:"${value}"` : null;
		}
		default:
			return null;
	}
}

// Builds the complete Scryfall query from our chip tokens: free text (card
// name) goes through as is, each recognized facet becomes a Scryfall clause
// (see chipTokenToScryfallClause).
// Regexes specific to the add search bar (not to the collection filter):
// "#235" for a collector number, "set:xyz" (code, not full name) for a set
// chosen via suggestion in this same bar. Intercepted before categorizeToken
// so as not to collide with the meaning of "set:" in the collection filter
// (which stores a full name, not a code).
export const SEARCH_COLLECTOR_NUM_RE = /^#\d+\S*$/;
export const SEARCH_SET_CODE_RE = /^set:/i;

export function buildScryfallQueryFromChips(tokens: string[], draft: string): string {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	const parts: string[] = [];

	// Exact color identity ("=blue" [+ "=white" ...], see isExactToken): unlike
	// every other facet (chipTokenToScryfallClause translates an isolated token
	// without knowing the others), several "=" tokens must merge into ONE
	// combined Scryfall clause ("c=uw") — Scryfall's c= operator asserts an
	// EXACT color identity by itself, so two separate "c=u" and "c=w" clauses
	// (combined with AND as Scryfall does between space-separated clauses) would
	// never match any card, since an identity cannot equal two different values
	// at once. Extracted separately, before the generic loop below, rather than
	// in chipTokenToScryfallClause (which only sees an isolated token).
	const exactColorLetters = new Set<string>();
	const remainingTokens: string[] = [];
	allTokens.forEach((token) => {
		if (!isExactToken(token)) {
			remainingTokens.push(token);
			return;
		}
		const base = stripExact(token);
		const letter = categorizeToken(base) === "color" ? resolveColorLetter(base) : null;
		if (letter) {
			exactColorLetters.add(letter);
			return;
		}
		// Fallback: non-color "=" token (never produced by the UI, which only sets
		// this toggle on a color chip, but a hand-typed/imported token remains
		// possible) — treated as an ordinary token, the "=" would make no sense to
		// pass through here.
		remainingTokens.push(base);
	});
	if (exactColorLetters.size > 0) {
		// Canonical WUBRG order rather than the chips' insertion order —
		// COLOR_SEARCH_KEYWORDS is already declared in that order.
		const ordered = Object.values(COLOR_SEARCH_KEYWORDS).filter((l) => exactColorLetters.has(l));
		parts.push(`c=${ordered.join("").toLowerCase()}`);
	}

	// Sets ("set:xyz"): like the exact color identity above, several POSITIVE
	// "set:" tokens must merge into ONE clause using Scryfall's "or" operator
	// in parentheses — reported bug ("impossible to display the cards of two
	// expansions at the same time"): treated like any other clause (one per
	// token, joined by a space = AND for Scryfall), two separate "s:x s:y"
	// clauses would require a card to belong to TWO sets at once, which no
	// card can ever satisfy. "set" is nevertheless in orCategories (see
	// cardMatchesTokens further up, which correctly filters with OR on the
	// already-owned collection) — the bug was specific to THIS function, which
	// builds a textual Scryfall query rather than evaluating a predicate card
	// by card, and had never received the same merge treatment as the exact
	// color identity above. A NEGATIVE "set:" token stays a separate "-s:x"
	// clause, ANDed with the rest like any other negation (excluding TWO sets
	// at once is a perfectly valid AND, unlike inclusion) — left as is in the
	// generic loop below.
	const positiveSetCodes: string[] = [];
	const tokensAfterSetExtraction: string[] = [];
	remainingTokens.forEach((token) => {
		const negated = isNegatedToken(token);
		const base = negated ? stripNegation(token) : token;
		if (!negated && SEARCH_SET_CODE_RE.test(base)) {
			positiveSetCodes.push(base.slice(4).toLowerCase());
		} else {
			tokensAfterSetExtraction.push(token);
		}
	});
	if (positiveSetCodes.length === 1) {
		parts.push(`s:${positiveSetCodes[0]}`);
	} else if (positiveSetCodes.length > 1) {
		parts.push(`(${positiveSetCodes.map((c) => `s:${c}`).join(" or ")})`);
	}

	tokensAfterSetExtraction.forEach((token) => {
		const negated = isNegatedToken(token);
		const base = negated ? stripNegation(token) : token;
		if (!base.trim()) return;
		const prefix = negated ? "-" : "";

		if (SEARCH_SET_CODE_RE.test(base)) {
			parts.push(`${prefix}s:${base.slice(4).toLowerCase()}`);
			return;
		}
		if (SEARCH_COLLECTOR_NUM_RE.test(base)) {
			parts.push(`${prefix}cn:${base.slice(1)}`);
			return;
		}

		const cat = categorizeToken(base);
		if (SEARCH_EXCLUDED_CATEGORIES.includes(cat)) return;
		if (cat === "text") {
			const words = base.trim();
			parts.push(negated ? `-${words}` : words);
			return;
		}
		const clause = chipTokenToScryfallClause(token);
		if (clause) parts.push(clause);
	});
	return parts.join(" ");
}

// If both the "set:xyz" and "#number" chips are present (and not excluded),
// we can still use searchScryfall's fast exact lookup rather than going back
// through the general search on every keystroke. A set+number identifies a
// single printing -> applies only if there is EXACTLY one positive "set:"
// chip: with two or more set: chips (e.g. "The Hobbit" + "The Hobbit Eternal"
// + "#139"), there is no longer a single "obvious" printing to target (the
// number may exist in one set or the other, never both) — returning the last
// set seen here (as before this fix) silently pinned the search to THAT set
// alone, contradicting the "(s:x or s:y)" merge that
// buildScryfallQueryFromChips applies elsewhere for this same case (see its
// own comment): searchScryfall would then AND that single set with the
// correct OR clause, cancelling the OR and returning no result if the card
// was in the other set. setCode stays "" in that case, so that searchScryfall
// falls back to the general search (which does see the chipQuery merged with
// OR).
export function extractExactLookupHints(
	tokens: string[],
	draft: string
): { setCode: string; collectorNumber: string } {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	const setCodes: string[] = [];
	let collectorNumber = "";
	allTokens.forEach((token) => {
		if (isNegatedToken(token)) return;
		if (SEARCH_SET_CODE_RE.test(token)) setCodes.push(token.slice(4).toLowerCase());
		else if (SEARCH_COLLECTOR_NUM_RE.test(token)) collectorNumber = token.slice(1);
	});
	return { setCode: setCodes.length === 1 ? setCodes[0] : "", collectorNumber };
}

export function cardMatchesTokens(
	card: SearchableCard,
	tokens: string[],
	draft: string,
	recentlyAddedIds?: Set<string>,
	legalitiesByScryfallId?: Map<string, Record<string, string>>
): boolean {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	if (allTokens.length === 0) return true;

	const positiveTokens: string[] = [];
	const negativeTokens: string[] = [];
	// Exact color identity ("=blue" [+ "=white" ...], see isExactToken) —
	// extracted separately rather than into positiveTokens/buckets.color: it
	// is not an OR alternative like an ordinary color token, but a constraint
	// in its own right ("the card's color set must EXACTLY equal this"),
	// checked just after this loop.
	const exactColorLetters = new Set<string>();
	allTokens.forEach((t) => {
		if (isNegatedToken(t)) {
			negativeTokens.push(stripNegation(t));
			return;
		}
		if (isExactToken(t)) {
			const base = stripExact(t);
			const letter = categorizeToken(base) === "color" ? resolveColorLetter(base) : null;
			if (letter) {
				exactColorLetters.add(letter);
				return;
			}
			// Fallback: non-color "=" token (never produced by the UI, but a
			// hand-typed/imported token remains possible) — becomes an ordinary
			// positive token again rather than being silently ignored.
			positiveTokens.push(base);
			return;
		}
		positiveTokens.push(t);
	});

	// Checked right away, before the early "return true" further down (no
	// other positive token present) which would otherwise short-circuit it: an
	// "=" token combines several colors with AND (the card's color set must
	// EXACTLY equal the union of the marked letters, no more, no less).
	if (exactColorLetters.size > 0) {
		const cardColors = new Set(card.colors ?? []);
		if (cardColors.size !== exactColorLetters.size) return false;
		for (const letter of exactColorLetters) {
			if (!cardColors.has(letter)) return false;
		}
	}

	// Pure boolean category, depending on session state
	// (this.plugin.recentlyAddedCardIds) rather than on an intrinsic field of
	// the card — TOKEN_MATCHERS (signature (card, token) => boolean, with no
	// access to an external context) cannot express it, so it is handled
	// separately rather than adding an entry there that would ignore this
	// state.
	const isRecentlyAdded = () =>
		recentlyAddedIds?.has((card as { id?: string }).id ?? "") ?? false;

	for (const negToken of negativeTokens) {
		const cat = categorizeToken(negToken);
		if (cat === "recentlyadded") {
			if (isRecentlyAdded()) return false;
			continue;
		}
		// Same separate handling as "recentlyadded" above, see
		// legalityTokenMatches for why. An id not yet resolved never matches
		// legalityTokenMatches (positive or negative): a card whose legality isn't
		// known yet is therefore NOT excluded by a negative token until the data
		// has arrived — the safe default behavior, a future render will
		// re-evaluate it.
		if (cat === "legality") {
			if (legalityTokenMatches(card, negToken, legalitiesByScryfallId)) return false;
			continue;
		}
		const matcher =
			cat === "text" ? textTokenMatches : cat === "oracle" ? oracleTokenMatches : TOKEN_MATCHERS[cat];
		if (matcher(card, negToken)) return false;
	}

	if (positiveTokens.length === 0) return true;

	const buckets: Record<TokenCategory, string[]> = {
		color: [],
		rarity: [],
		language: [],
		condition: [],
		foil: [],
		type: [],
		keyword: [],
		artist: [],
		set: [],
		cardnum: [],
		numeric_cmc: [],
		numeric_price: [],
		numeric_qty: [],
		numeric_added: [],
		recentlyadded: [],
		legality: [],
		border: [],
		oracle: [],
		text: [],
	};
	positiveTokens.forEach((t) => buckets[categorizeToken(t)].push(t));

	const orCategories = [
		"color",
		"rarity",
		"language",
		"condition",
		"foil",
		"type",
		"keyword",
		"artist",
		"set",
		"cardnum",
		"border",
	] as const;
	for (const cat of orCategories) {
		const catTokens = buckets[cat];
		if (catTokens.length === 0) continue;
		const matcher = TOKEN_MATCHERS[cat];
		if (!catTokens.some((t) => matcher(card, t))) return false;
	}

	// Numeric fields: several constraints on the same field form a range
	// ("cmc>2" + "cmc<5" = AND), not an alternative.
	const numericCategories = ["numeric_cmc", "numeric_price", "numeric_qty", "numeric_added"] as const;
	for (const cat of numericCategories) {
		const catTokens = buckets[cat];
		if (catTokens.length === 0) continue;
		const matcher = TOKEN_MATCHERS[cat];
		if (!catTokens.every((t) => matcher(card, t))) return false;
	}

	if (buckets.recentlyadded.length > 0 && !isRecentlyAdded()) return false;

	// Several formats with OR ("legal:modern" + "legal:legacy" = legal in one
	// OR the other), same convention as orCategories above.
	if (
		buckets.legality.length > 0 &&
		!buckets.legality.some((t) => legalityTokenMatches(card, t, legalitiesByScryfallId))
	)
		return false;

	// AND between several "oracle:" tokens (each phrase must appear), same
	// convention as buckets.text below — see oracleTokenMatches.
	if (buckets.oracle.length > 0 && !buckets.oracle.every((t) => oracleTokenMatches(card, t)))
		return false;

	if (buckets.text.length > 0 && !buckets.text.every((t) => textTokenMatches(card, t)))
		return false;

	return true;
}

// True if at least one token (validated or draft being typed) is a legality
// filter — used by MTGCollectionView to trigger the background pre-fetch of
// the open list's legalities (see MTGCollectionPlugin.bulkFetchLegalities)
// only when it is actually needed, not on every render.
export function tokensNeedLegalityData(tokens: string[], draft: string): boolean {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	return allTokens.some((t) => {
		const base = isNegatedToken(t) ? stripNegation(t) : t;
		return categorizeToken(base) === "legality";
	});
}

// A word is "recognized" if it exactly matches a known keyword: it then gets
// a special rendering (icon/badge) in its chip.
export type RecognizedToken =
	| { kind: "color"; letter: string }
	| { kind: "rarity"; label: string }
	| { kind: "language"; flag: string; label: string }
	| { kind: "condition"; glyph: string; color: string; label: string }
	| { kind: "type"; label: string }
	| { kind: "foil"; label: string }
	| { kind: "keyword"; label: string }
	| { kind: "numeric"; label: string }
	| { kind: "artist"; label: string }
	| { kind: "set"; code: string; label: string }
	| { kind: "cardnum"; label: string };

export const OPERATOR_SYMBOLS: Record<NumericOperator, string> = {
	"<": "<",
	"<=": "≤",
	"=": "=",
	">=": "≥",
	">": ">",
};

export function recognizeKeywordToken(token: string): RecognizedToken | null {
	const q = token.trim().toLowerCase();

	if (q.startsWith("artist:")) return { kind: "artist", label: token.trim().slice(7) };
	if (q.startsWith("set:")) {
		const code = token.trim().slice(4);
		return { kind: "set", code, label: code.toUpperCase() };
	}
	if (/^#\d+\S*$/.test(q)) return { kind: "cardnum", label: `# ${token.trim().slice(1)}` };
	const legalityMatch = matchLegalityPrefix(q);
	if (legalityMatch) {
		// Exact match on the key (not a prefix): a token committed via the
		// suggestion is always "<prefix><full key>" (see SUGGESTABLE_KEYWORDS
		// below) — same logic as color/rarity/language further down in this
		// function, a token typed by hand and validated without going through the
		// suggestion (e.g. "legal:mod") remains a valid filter (see
		// legalityTokenMatches, which matches by prefix) but doesn't get the
		// "recognized" chip rendering.
		const entry = LEGALITY_SEARCH_FORMATS.find(
			(f) => f.key === q.slice(legalityMatch.prefix.length)
		);
		// Reuses the "keyword" rendering (generic badge), same precedent as
		// "recent" a little further down: one more boolean category doesn't
		// justify a dedicated RecognizedToken variant. The label capitalizes the
		// status searched for ("Legal:"/"Banned:"/"Restricted:") from the same
		// status that legalityTokenMatches compares.
		if (entry) {
			const statusLabel =
				legalityMatch.status.charAt(0).toUpperCase() + legalityMatch.status.slice(1);
			return { kind: "keyword", label: `${statusLabel}: ${entry.label}` };
		}
	}
	if (q.startsWith("border:")) {
		// Same precedent as "legal:" above: one more boolean category doesn't
		// justify a dedicated RecognizedToken variant, the generic "keyword"
		// rendering is enough.
		const entry = BORDER_SEARCH_OPTIONS.find((o) => o.value === q.slice("border:".length));
		if (entry) return { kind: "keyword", label: `Border: ${entry.label}` };
	}
	if (q.startsWith("oracle:")) {
		// Unlike legal:/border: above, the value isn't drawn from a finite set —
		// any non-empty phrase counts as "recognized" here. Original case kept
		// (not q, already lowercased) for a more readable chip label.
		const value = token.trim().slice("oracle:".length).trim();
		if (value) return { kind: "keyword", label: `Card text: "${value}"` };
	}

	const numeric = parseNumericToken(token);
	if (numeric) {
		const valueText = numeric.rawDateStr ?? String(numeric.value);
		return {
			kind: "numeric",
			label: `${numeric.field.label} ${OPERATOR_SYMBOLS[numeric.operator]} ${valueText}`,
		};
	}

	const colorEntry = Object.entries(COLOR_SEARCH_KEYWORDS).find(([name]) => name === q);
	if (colorEntry) return { kind: "color", letter: colorEntry[1] };

	const rarity = RARITY_SEARCH_KEYWORDS.find((r) => r === q);
	if (rarity) return { kind: "rarity", label: rarity.charAt(0).toUpperCase() + rarity.slice(1) };

	const language = LANGUAGES.find((l) => l.label.toLowerCase() === q);
	if (language) return { kind: "language", flag: language.flag, label: language.label };

	const conditionEntry = CONDITION_SEARCH_ENTRIES.find((e) => e.keywords.includes(q));
	if (conditionEntry) {
		const cond = getCondition(conditionEntry.value);
		return { kind: "condition", glyph: cond.glyph, color: cond.color, label: cond.label };
	}
	if (q === "none") {
		const cond = getCondition("");
		return { kind: "condition", glyph: cond.glyph, color: cond.color, label: cond.label };
	}

	if (q === "foil") return { kind: "foil", label: "Foil" };
	if (q === "nonfoil" || q === "non-foil") return { kind: "foil", label: "Non-foil" };
	if (q === "etched") return { kind: "foil", label: "Etched" };
	if (q === "surged" || q === "surge") return { kind: "foil", label: "Surge Foil" };
	if (q === "proxy") return { kind: "foil", label: "Proxy" };

	// Reuses the "keyword" rendering (generic badge) rather than adding a
	// dedicated RecognizedToken variant for a single boolean category with no
	// need for a visual style of its own.
	if (q === "recent") return { kind: "keyword", label: "Recently added" };

	const type = TYPE_SEARCH_KEYWORDS.find((t) => t.toLowerCase() === q);
	if (type) return { kind: "type", label: type };

	const keyword = KEYWORD_ABILITIES.find((k) => k.toLowerCase() === q);
	if (keyword) return { kind: "keyword", label: keyword };

	return null;
}

export interface SuggestKeyword {
	value: string;
	display: string;
	matchTexts: string[];
	category: TokenCategory;
	flagCode?: string;
	setCode?: string;
	count?: number;
}

// All the keywords offerable in autocompletion. "matchTexts" contains the
// recognized prefixes (e.g. the "Near Mint" condition is suggested when
// typing "nm", "near" or "mint"), whereas "value" is the token actually
// inserted as a chip.
export const SUGGESTABLE_KEYWORDS: SuggestKeyword[] = [
	...Object.keys(COLOR_SEARCH_KEYWORDS).map((name): SuggestKeyword => ({
		value: name,
		display: name.charAt(0).toUpperCase() + name.slice(1),
		matchTexts: [name],
		category: "color",
	})),
	{ value: "multicolor", display: "Multicolor", matchTexts: ["multicolor"], category: "color" },
	{ value: "colorless", display: "Colorless", matchTexts: ["colorless"], category: "color" },
	...RARITY_SEARCH_KEYWORDS.map((r): SuggestKeyword => ({
		value: r,
		display: r.charAt(0).toUpperCase() + r.slice(1),
		matchTexts: [r],
		category: "rarity",
	})),
	...LANGUAGES.map((l): SuggestKeyword => ({
		value: l.label.toLowerCase(),
		display: l.label,
		matchTexts: [l.label.toLowerCase()],
		category: "language",
		flagCode: l.flag,
	})),
	{ value: "mt", display: "Mint", matchTexts: ["mt", "mint"], category: "condition" },
	{ value: "nm", display: "Near Mint", matchTexts: ["nm", "near"], category: "condition" },
	{ value: "ex", display: "Excellent", matchTexts: ["ex", "excellent"], category: "condition" },
	{ value: "gd", display: "Good", matchTexts: ["gd", "good"], category: "condition" },
	{ value: "lp", display: "Light Played", matchTexts: ["lp", "light"], category: "condition" },
	{ value: "pl", display: "Played", matchTexts: ["pl", "played"], category: "condition" },
	{ value: "po", display: "Poor", matchTexts: ["po", "poor"], category: "condition" },
	{ value: "none", display: "None", matchTexts: ["none"], category: "condition" },
	{ value: "foil", display: "Foil", matchTexts: ["foil"], category: "foil" },
	{ value: "nonfoil", display: "Non-foil", matchTexts: ["nonfoil"], category: "foil" },
	{ value: "etched", display: "Etched", matchTexts: ["etched"], category: "foil" },
	{ value: "surged", display: "Surge Foil", matchTexts: ["surged", "surge"], category: "foil" },
	{ value: "proxy", display: "Proxy", matchTexts: ["proxy"], category: "foil" },
	{
		value: "recent",
		display: "Recently added",
		matchTexts: ["recent"],
		category: "recentlyadded",
	},
	...TYPE_SEARCH_KEYWORDS.map((t): SuggestKeyword => ({
		value: t.toLowerCase(),
		display: t,
		matchTexts: [t.toLowerCase()],
		category: "type",
	})),
	...KEYWORD_ABILITIES.map((k): SuggestKeyword => ({
		value: k.toLowerCase(),
		display: k,
		matchTexts: [k.toLowerCase()],
		category: "keyword",
	})),
	// matchTexts includes the prefix itself (not just the bare key/label):
	// categorizeToken requires this prefix (see above), so without it typing
	// "legal:mo" would match no matchText via startsWith (see
	// getKeywordSuggestions, view.ts). The 3 prefixes
	// (LEGALITY_STATUS_PREFIXES) each generate their 23 suggestions rather
	// than just one — they only appear if the user has already typed
	// "banned:"/"restricted:" themselves (no matchText otherwise starts with
	// those prefixes), so no noise is added to the free search/the already
	// existing "legal:" suggestions despite the tripling of the total number
	// of entries.
	...LEGALITY_STATUS_PREFIXES.flatMap(({ prefix, status }) =>
		LEGALITY_SEARCH_FORMATS.map((f): SuggestKeyword => ({
			value: `${prefix}${f.key}`,
			display: `${status.charAt(0).toUpperCase()}${status.slice(1)}: ${f.label}`,
			matchTexts: [`${prefix}${f.key}`, `${prefix}${f.label.toLowerCase()}`],
			category: "legality",
		}))
	),
	// matchTexts includes the "border:" prefix itself, same reason as "legal:"
	// above (categorizeToken requires this prefix).
	...BORDER_SEARCH_OPTIONS.map((o): SuggestKeyword => ({
		value: `border:${o.value}`,
		display: `Border: ${o.label}`,
		matchTexts: [`border:${o.value}`, `border:${o.label.toLowerCase()}`],
		category: "border",
	})),
];

export const CATEGORY_LABELS: Record<TokenCategory, string> = {
	color: "Color",
	rarity: "Rarity",
	language: "Language",
	condition: "Condition",
	foil: "Foil",
	type: "Type",
	keyword: "Ability",
	artist: "Artist",
	set: "Set",
	cardnum: "Number",
	numeric_cmc: "Mana value",
	numeric_price: "Price",
	numeric_qty: "Quantity",
	numeric_added: "Date added",
	recentlyadded: "Recently added",
	legality: "Format legality",
	border: "Border",
	oracle: "Card text",
	text: "",
};

/* -------------------------------------------------------------------------- */
/* English description of the chip bar ("Add cards", add-cards-modal.ts) */
/* -------------------------------------------------------------------------- */

// "and"/"or" between the values of a single clause — "or" reflects the
// real semantics of several tokens WITHIN THE SAME category (see
// cardMatchesTokens/orCategories above: "green" + "blue" = green OR blue),
// "and" that of the categories that on the contrary combine with AND
// (oracle:/free text: each phrase must appear). A single value needs no
// conjunction; two values are written "X and Y" without a comma; three or
// more use the standard Oxford comma.
function joinPhrase(values: string[], conjunction: "and" | "or"): string {
	const unique = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
	if (unique.length === 0) return "";
	if (unique.length === 1) return unique[0];
	if (unique.length === 2) return `${unique[0]} ${conjunction} ${unique[1]}`;
	return `${unique.slice(0, -1).join(", ")}, ${conjunction} ${unique[unique.length - 1]}`;
}

function describeTypeValue(token: string): string {
	return TYPE_SEARCH_KEYWORDS.find((t) => t.toLowerCase() === token.trim().toLowerCase()) ?? token.trim();
}

function describeKeywordValue(token: string): string {
	return KEYWORD_ABILITIES.find((k) => k.toLowerCase() === token.trim().toLowerCase()) ?? token.trim();
}

function describeFoilValue(token: string): string {
	const q = token.trim().toLowerCase();
	if ("etched".startsWith(q) && q.length >= 3) return "etched";
	if (("surged".startsWith(q) || "surge".startsWith(q)) && q.length >= 3) return "surge foil";
	if ("proxy".startsWith(q) && q.length >= 3) return "proxy";
	if ("nonfoil".startsWith(q) && q.length >= 3) return "non-foil";
	return "foil";
}

function describeConditionValue(token: string): string {
	const q = token.trim().toLowerCase();
	if ("none".startsWith(q)) return getCondition("").label.toLowerCase();
	const entry = CONDITION_SEARCH_ENTRIES.find((e) => e.keywords.some((k) => k.startsWith(q)));
	return entry ? getCondition(entry.value).label.toLowerCase() : token.trim();
}

function describeLanguageValue(token: string): string {
	const q = token.trim().toLowerCase();
	const lang = LANGUAGES.find((l) => l.label.toLowerCase().startsWith(q));
	return lang ? lang.label : token.trim();
}

function describeBorderValue(token: string): string {
	const value = token.trim().slice("border:".length).trim().toLowerCase();
	const entry = BORDER_SEARCH_OPTIONS.find((o) => o.value === value);
	return entry ? entry.label.toLowerCase() : value;
}

function describeLegalityValue(token: string): string {
	const q = token.trim().toLowerCase();
	const legalityMatch = matchLegalityPrefix(q);
	const key = (legalityMatch ? q.slice(legalityMatch.prefix.length) : q).trim();
	const entry = LEGALITY_SEARCH_FORMATS.find((f) => f.key === key);
	return entry ? entry.label : key;
}

function describeNumericValue(token: string): string {
	const parsed = parseNumericToken(token);
	if (!parsed) return token.trim();
	const valueText = parsed.rawDateStr ?? String(parsed.value);
	return `${parsed.field.label.toLowerCase()} ${OPERATOR_SYMBOLS[parsed.operator]} ${valueText}`;
}

// Full name of a set rather than its short code ("Innistrad Remastered", not
// "INR") — explicitly requested. resolveSetName is supplied by the caller
// (add-cards-modal.ts, via MTGCollectionPlugin.getCachedSetSummary — a
// SYNCHRONOUS read of an already warm cache, the same function already used
// for the icon/name of the "set:" chip itself in renderSearchChipBar): this
// file otherwise has no dependency on Obsidian/the plugin, so no question of
// fetching this data itself. Falls back to the uppercase code if the cache
// isn't warm yet or if no resolver is supplied (e.g. this file's unit tests)
// — same fallback as renderSearchChipBar.
function describeSetValue(
	token: string,
	resolveSetName?: (code: string) => string | undefined
): string {
	const code = token.trim().slice("set:".length).trim().toLowerCase();
	return resolveSetName?.(code) ?? code.toUpperCase();
}

// A single value of a given category, described for the negation clause
// ("not X") — unlike the positive clauses below (grouped by category with
// "or"), each negative token excludes independently (see
// cardMatchesTokens: AND of negations, each evaluated alone), so no
// grouping here, one clause per token.
function describeNegatedValue(
	token: string,
	resolveSetName?: (code: string) => string | undefined
): string {
	const cat = categorizeToken(token);
	switch (cat) {
		case "color":
			return `${token.trim().toLowerCase()}`;
		case "rarity":
			return `${token.trim().toLowerCase()} rarity`;
		case "type":
			return `of type ${describeTypeValue(token)}`;
		case "keyword":
			return `with the "${describeKeywordValue(token)}" ability`;
		case "oracle":
			return `mentioning "${token.trim().slice("oracle:".length).trim()}"`;
		case "text":
			return `containing "${token.trim()}"`;
		case "artist":
			return `by ${token.trim().slice("artist:".length).trim()}`;
		case "set":
			return `from ${describeSetValue(token, resolveSetName)}`;
		case "cardnum":
			return `numbered #${token.trim().slice(1)}`;
		case "foil":
			return describeFoilValue(token);
		case "condition":
			return `in ${describeConditionValue(token)} condition`;
		case "language":
			return `in ${describeLanguageValue(token)}`;
		case "border":
			return `with a ${describeBorderValue(token)} border`;
		case "legality": {
			const legalityMatch = matchLegalityPrefix(token.trim().toLowerCase());
			return `${legalityMatch?.status ?? "legal"} in ${describeLegalityValue(token)}`;
		}
		case "recentlyadded":
			return "recently added";
		default:
			return token.trim();
	}
}

// Best-effort English description of the chip bar's current state — "Show
// every green card containing "Aragorn", with the "Vigilance" ability." (see
// add-cards-modal.ts, updateFilterDescription). A DETERMINISTIC snapshot
// built from the same tables/categories as the rest of this file, NOT real
// natural-language generation: it faithfully reflects the real semantics of
// cardMatchesTokens (different categories with AND, several tokens of THE
// SAME category with OR — except oracle:/free text, with AND, and
// cmc/price/qty/date, as a range intersection — see its own comment at the
// top of this file), but stays mechanical rather than elegant for the most
// unusual combinations (several negations stacked on very different
// categories, for example). An unrecognized token (a hand-typed abbreviation
// before being validated, a free word) falls back to its raw text, same
// fallback as renderSearchChipBar (add-cards-modal.ts/view.ts) for displaying
// the chips themselves.
// One clause builder per category — all share the same shape (list of this
// category's tokens -> complete phrase), so they can be called generically in
// CATEGORY_CLAUSE_BUILDERS below rather than through a long repetitive chain
// of ifs. "color" isn't in there: handled separately, as a qualifier of the
// SUBJECT rather than as a clause (see describeSearchFilters). "set" neither:
// unlike the others, its description needs the optional resolver of
// describeSearchFilters (full set name, see describeSetValue) — a builder in
// this array, built once at module level, cannot close over a parameter
// specific to a given call, so "set" is handled separately, directly in
// describeSearchFilters.
const CATEGORY_CLAUSE_BUILDERS: Partial<Record<TokenCategory, (values: string[]) => string>> = {
	rarity: (v) => `with ${joinPhrase(v.map((t) => t.toLowerCase()), "or")} rarity`,
	type: (v) => `of type ${joinPhrase(v.map(describeTypeValue), "or")}`,
	keyword: (v) =>
		`with the ${joinPhrase(
			v.map((t) => `"${describeKeywordValue(t)}"`),
			"or"
		)} ability`,
	oracle: (v) =>
		`whose rules text mentions ${joinPhrase(
			v.map((t) => `"${t.slice("oracle:".length).trim()}"`),
			"and"
		)}`,
	text: (v) => `containing ${joinPhrase(v.map((t) => `"${t}"`), "and")}`,
	artist: (v) =>
		`by ${joinPhrase(
			v.map((t) => t.slice("artist:".length).trim()),
			"or"
		)}`,
	cardnum: (v) => `numbered ${joinPhrase(v.map((t) => `#${t.slice(1)}`), "or")}`,
	foil: (v) => `in ${joinPhrase(v.map(describeFoilValue), "or")} finish`,
	condition: (v) => `in ${joinPhrase(v.map(describeConditionValue), "or")} condition`,
	language: (v) => `in ${joinPhrase(v.map(describeLanguageValue), "or")}`,
	border: (v) => `with a ${joinPhrase(v.map(describeBorderValue), "or")} border`,
	// Groups first by the status searched for (legal:/banned:/restricted: —
	// same "legality" bucket, see cardMatchesTokens) before describing,
	// otherwise a mix like "legal:modern" + "banned:legacy" in the same query
	// would wrongly display "legal in Modern or Legacy" — silently wrong for
	// the second token. Each status group keeps its own internal "or" (same
	// formats, same status), the groups of different statuses also join with
	// "or" among themselves — reflects the real semantics of the bucket (OR
	// between ALL "legality" tokens, whatever their status, see
	// cardMatchesTokens).
	legality: (v) => {
		const byStatus = new Map<string, string[]>();
		v.forEach((t) => {
			const status = matchLegalityPrefix(t.trim().toLowerCase())?.status ?? "legal";
			const group = byStatus.get(status) ?? [];
			group.push(t);
			byStatus.set(status, group);
		});
		return joinPhrase(
			Array.from(byStatus.entries()).map(
				([status, group]) => `${status} in ${joinPhrase(group.map(describeLegalityValue), "or")}`
			),
			"or"
		);
	},
	recentlyadded: () => "recently added",
	numeric_cmc: (v) => joinPhrase(v.map(describeNumericValue), "and"),
	numeric_price: (v) => joinPhrase(v.map(describeNumericValue), "and"),
	numeric_qty: (v) => joinPhrase(v.map(describeNumericValue), "and"),
	numeric_added: (v) => joinPhrase(v.map(describeNumericValue), "and"),
};

export function describeSearchFilters(
	tokens: string[],
	resolveSetName?: (code: string) => string | undefined
): string {
	const trimmed = tokens.map((t) => t.trim()).filter(Boolean);
	if (trimmed.length === 0) return "";

	const positive: string[] = [];
	const negative: string[] = [];
	const exactColorValues: string[] = [];

	trimmed.forEach((t) => {
		if (isNegatedToken(t)) {
			negative.push(stripNegation(t));
			return;
		}
		if (isExactToken(t)) {
			const base = stripExact(t);
			if (categorizeToken(base) === "color") {
				exactColorValues.push(base);
				return;
			}
			positive.push(base);
			return;
		}
		positive.push(t);
	});

	// Groups by category while remembering each category's ORDER OF APPEARANCE
	// (categoryOrder) — not a fixed/arbitrary order: the result thus follows
	// the order in which the user actually typed their filters ("green" then
	// "aragorn" then "vigilance" produces the clauses in THAT order), rather
	// than a per-category ranking that could reorder the sentence in a
	// surprising way compared with what was typed.
	const buckets: Partial<Record<TokenCategory, string[]>> = {};
	const categoryOrder: TokenCategory[] = [];
	positive.forEach((t) => {
		const cat = categorizeToken(t);
		if (!buckets[cat]) categoryOrder.push(cat);
		(buckets[cat] ??= []).push(t);
	});

	// Subject of the sentence: "every X card" — the color drives the subject's
	// adjective when present (as in the example that started this feature),
	// otherwise just "every card". The exact color identity (=green, see
	// isExactToken) is a separate constraint, added as a qualifier of the
	// subject rather than treated as a clause among others — neither follows
	// categoryOrder, both are qualifiers of the SUBJECT, not clauses.
	let subject = "every card";
	if (buckets.color?.length) {
		subject = `every ${joinPhrase(buckets.color.map((t) => t.toLowerCase()), "or")} card`;
	}
	if (exactColorValues.length > 0) {
		subject += ` whose color identity is exactly ${joinPhrase(
			exactColorValues.map((t) => t.toLowerCase()),
			"and"
		)}`;
	}

	const clauses: string[] = [];
	categoryOrder.forEach((cat) => {
		if (cat === "color") return; // already folded into the subject above
		if (cat === "set") {
			// Special case, see CATEGORY_CLAUSE_BUILDERS: needs the resolver specific
			// to this call, not a module-level builder.
			const values = buckets.set;
			if (values?.length) {
				clauses.push(`from ${joinPhrase(values.map((t) => describeSetValue(t, resolveSetName)), "or")}`);
			}
			return;
		}
		const builder = CATEGORY_CLAUSE_BUILDERS[cat];
		const values = buckets[cat];
		if (builder && values?.length) clauses.push(builder(values));
	});

	negative.forEach((t) => clauses.push(`not ${describeNegatedValue(t, resolveSetName)}`));

	return clauses.length > 0 ? `Show ${subject} ${clauses.join(", ")}.` : `Show ${subject}.`;
}
