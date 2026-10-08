/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */


// Physical state of the copy, replaces the old "foil" boolean. "proxy" is
// not a Scryfall finish — it is an unofficial copy owned by the user,
// excluded from the value calculation (see cardValue). "surged" (Surge Foil,
// a treatment specific to Kaldheim) has — unlike etched — no dedicated
// Scryfall price field (`prices.usd_etched`/`eur_etched` exist, the "surge"
// equivalent doesn't exist in their API): each surge foil printing is its
// own card object at Scryfall (foil finish only for that precise printing),
// so its price is already found in the usual foil fields — no separate
// fields needed, see getRawCardPrice further down.
export type Finish = "regular" | "foiled" | "etched" | "surged" | "proxy";

export const FINISH_OPTIONS: { value: Finish; label: string }[] = [
	{ value: "regular", label: "Regular" },
	{ value: "foiled", label: "Foiled" },
	{ value: "etched", label: "Etched" },
	{ value: "surged", label: "Surge Foil" },
	{ value: "proxy", label: "Proxy" },
];

export function getFinishLabel(finish: Finish): string {
	return FINISH_OPTIONS.find((f) => f.value === finish)?.label ?? "Regular";
}

// True for the finishes that have a shiny/textured look on the image
// ("foil" overlay on the thumbnail) — Regular and Proxy have none.
export function finishHasFoilLook(finish: Finish): boolean {
	return finish === "foiled" || finish === "etched" || finish === "surged";
}

// Recognizes both the CSV "Finish" column (values
// Regular/Foiled/Etched/Surge Foil/Proxy) and the old "Foil"/"foil/etched"
// column (values like "foil", "etched", "true", "1", or empty) — a CSV
// exported by an earlier version of the plugin must remain importable as
// is.
export function parseFinishValue(raw: string | undefined): Finish {
	const v = (raw ?? "").trim().toLowerCase();
	if (v === "etched") return "etched";
	if (v === "surged" || v === "surge" || v === "surge foil") return "surged";
	if (v === "proxy") return "proxy";
	if (v === "foiled" || v === "foil" || v === "true" || v === "yes" || v === "1") return "foiled";
	return "regular";
}

// Grading/custom price — My Collection only (a wantlist card isn't owned
// yet, so not graded yet; a DeckCard doesn't have a finish either, same
// asymmetry already established). Deliberately minimal scale (company + a
// single 1-10 grade, no sub-grades/certificate number) — PSA/BGS/CGC all use
// a 1-10 scale in 0.5 steps over most of the range (checked via
// comics.ha.com/tutorial/tcg-card-grading.s).
export type GradingCompany = "PSA" | "BGS" | "CGC" | "Other";

export const GRADING_COMPANY_OPTIONS: { value: GradingCompany; label: string }[] = [
	{ value: "PSA", label: "PSA" },
	{ value: "BGS", label: "BGS" },
	{ value: "CGC", label: "CGC" },
	{ value: "Other", label: "Other" },
];

export interface GradingTerm {
	grade: number | undefined;
	label: string;
	name: string;
}

export const GRADING_TERMS: Record<"PSA" | "BGS" | "CGC", GradingTerm[]> = {
	PSA: [
		{ grade: 10, label: "GEM MT", name: "Gem Mint" },
		{ grade: 9, label: "MINT", name: "Mint" },
		{ grade: 8, label: "NM-MT", name: "Near Mint / Mint" },
		{ grade: 7, label: "MT", name: "Near Mint" },
		{ grade: 6, label: "EX-MT", name: "Excellent / Mint" },
		{ grade: 5, label: "EX", name: "Excellent" },
		{ grade: 4, label: "VG-EX", name: "Very Good / Excellent" },
		{ grade: 3, label: "VG", name: "Very Good" },
		{ grade: 2, label: "GOOD", name: "Good" },
		{ grade: 1.5, label: "FR", name: "Fair" },
		{ grade: 1, label: "PR", name: "Poor" },
		{ grade: undefined, label: "A", name: "Authentic" },
		{ grade: undefined, label: "AA", name: "Authentic Altered" },
	],
	BGS: [
		{ grade: 10, label: "PRST-BL", name: "Pristine 10 - Black Label" },
		{ grade: 10, label: "PRST", name: "Pristine 10" },
		{ grade: 9.5, label: "GEM MT", name: "Gem Mint" },
		{ grade: 9, label: "MT", name: "Mint" },
		{ grade: 8, label: "NM-MT", name: "Near Mint / Mint" },
		{ grade: 7, label: "NM", name: "Near Mint" },
		{ grade: 6, label: "EX-MT", name: "Excellent / Mint" },
		{ grade: 5, label: "EX", name: "Excellent" },
		{ grade: 4, label: "VG-EX", name: "Very Good / Excellent" },
		{ grade: 3, label: "VG", name: "Very Good" },
		{ grade: 2, label: "GOOD", name: "Good" },
		{ grade: 1, label: "PR", name: "Poor" },
	],
	CGC: [
		{ grade: 10, label: "PRST", name: "Pristine" },
		{ grade: 10, label: "GEM MT", name: "Gem Mint" },
		{ grade: 9.5, label: "MT+", name: "Mint+" },
		{ grade: 9, label: "MT", name: "Mint" },
		{ grade: 8.5, label: "NM-MT+", name: "Near Mint / Mint+" },
		{ grade: 8, label: "NM-MT", name: "Near Mint / Mint" },
		{ grade: 7.5, label: "NM+", name: "Near Mint+" },
		{ grade: 7, label: "NM", name: "Near Mint" },
		{ grade: 6.5, label: "EX-NM+", name: "Excellent / Near Mint+" },
		{ grade: 6, label: "EX-NM", name: "Excellent / Near Mint" },
		{ grade: 5.5, label: "EX+", name: "Excellent+" },
		{ grade: 5, label: "EX", name: "Excellent" },
		{ grade: 4.5, label: "VG-EX+", name: "Very Good / Excellent+" },
		{ grade: 4, label: "VG-EX", name: "Very Good / Excellent" },
		{ grade: 3.5, label: "VG+", name: "Very Good+" },
		{ grade: 3, label: "VG", name: "Very Good" },
		{ grade: 2.5, label: "GOOD+", name: "Good+" },
		{ grade: 2, label: "GOOD", name: "Good" },
		{ grade: 1.5, label: "FR", name: "Fair" },
		{ grade: 1, label: "PR", name: "Poor" },
	],
};

export interface CollectionCard {
	id: string;
	scryfallId: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	rarity: string;
	manaCost: string;
	manaValue: number;
	typeLine: string;
	artist: string;
	colors: string[];
	keywords: string[];
	releasedAt: string;
	imageUrl: string;
	artCropUrl: string;
	priceUsd: string;
	priceUsdFoil: string;
	priceEur: string;
	priceEurFoil: string;
	priceUsdEtched: string;
	priceEurEtched: string;
	count: number;
	finish: Finish;
	language: string;
	condition: string;
	listId: string;
	dateAdded: number;
	dateModified: number;
	gradingCompany?: GradingCompany;
	gradingGrade?: number; // 1-10, in steps of 0.5
	// Official abbreviation (e.g. "GEM MT") chosen from GRADING_TERMS, stored
	// separately from gradingGrade because BGS/CGC each have two different
	// labels at grade 10 — the grade alone isn't enough to tell them apart.
	// undefined if the grade was typed by hand without going through the
	// labels dropdown.
	gradingLabel?: string;
	customPrice?: string; // free note, never used in price calculations
	// Border/frame ("border:" filter, card-search.ts) — unlike gradingCompany/etc.
	// above, optional not because the value can legitimately be missing, but because
	// this data is IMMUTABLE (a printed card never changes border) and was added to
	// an already mature data model: an entry created before this feature simply
	// doesn't have these fields in memory until
	// MTGCollectionPlugin.backfillBorderData() has caught them up once — see its own
	// comment (plugin.ts) for why a simple one-off catch-up is enough here, unlike
	// the TTL cache for legalities. Populated directly from
	// ScryfallCard.border_color/frame/frame_effects at each site that builds an
	// entry from a Scryfall response (addCardToCollection, importCsv,
	// changeCollectionCardPrinting, etc.).
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	// Rules text ("oracle:" filter, card-search.ts) — same reason for being
	// optional as borderColor/frame/frameEffects above (immutable data, added
	// to an already mature model, caught up once by
	// MTGCollectionPlugin.backfillOracleTextData()). Combines both faces for a
	// double-faced card (see buildCardTextInfo, scryfall.ts).
	oracleText?: string;
}

// Same shape as CollectionCard, without condition/language: a wanted card isn't
// owned yet, so its physical state makes no sense here. finish and price remain
// useful (one may specifically want a foil version, and the price helps assess
// the cost of acquisition).
export interface WantlistCard {
	id: string;
	scryfallId: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	rarity: string;
	manaCost: string;
	manaValue: number;
	typeLine: string;
	artist: string;
	colors: string[];
	keywords: string[];
	releasedAt: string;
	imageUrl: string;
	artCropUrl: string;
	priceUsd: string;
	priceUsdFoil: string;
	priceEur: string;
	priceEurFoil: string;
	priceUsdEtched: string;
	priceEurEtched: string;
	count: number;
	finish: Finish;
	listId: string;
	dateAdded: number;
	dateModified: number;
	// See the equivalent comment on CollectionCard above.
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	oracleText?: string;
}

export interface LanguageOption {
	code: string;
	label: string;
	flag: string;
}

// Official Magic: The Gathering print languages. "flag" is an ISO 3166-1
// alpha-2 country code, a key into FLAG_SVGS below. No "None" entry here
// (tried once, reverted on explicit request): a card with no language
// chosen no longer appears as a selectable choice in the pickers, only as a
// visual fallback — see getLanguage/createLanguageIcon
// (ui/option-icons.ts).
export const LANGUAGES: LanguageOption[] = [
	{ code: "en", label: "English", flag: "us" },
	{ code: "es", label: "Spanish", flag: "es" },
	{ code: "fr", label: "French", flag: "fr" },
	{ code: "de", label: "German", flag: "de" },
	{ code: "it", label: "Italian", flag: "it" },
	{ code: "pt", label: "Portuguese", flag: "pt" },
	{ code: "ja", label: "Japanese", flag: "jp" },
	{ code: "ko", label: "Korean", flag: "kr" },
	{ code: "ru", label: "Russian", flag: "ru" },
	{ code: "zhs", label: "Chinese (Simplified)", flag: "cn" },
	{ code: "zht", label: "Chinese (Traditional)", flag: "tw" },
];

// Virtual object returned for an empty/unrecognized code — never a member of
// LANGUAGES (so never iterated in a picker), just a description for text
// display (e.g. the "Language" box of the Graded/Custom Price panel) and for
// supplying flag: "" to createLanguageIcon (ui/option-icons.ts).
const UNSET_LANGUAGE: LanguageOption = { code: "", label: "None", flag: "" };

export function getLanguage(code: string): LanguageOption {
	return LANGUAGES.find((l) => l.code === code) ?? UNSET_LANGUAGE;
}

// Builds the list of languages offerable in a card picker: the languages
// confirmed available for this printing (availableCodes, already filtered by
// plugin.getAvailableLanguages), or the full list if Scryfall reported none.
// Small DRY helper for the 3 pickers that need it (list row, Card view tile,
// detail panel) rather than logic duplicated three times.
export function languagePickerOptions(availableCodes: string[]): LanguageOption[] {
	const available = LANGUAGES.filter((l) => availableCodes.includes(l.code));
	return available.length > 0 ? available : LANGUAGES;
}

export interface ConditionOption {
	value: string;
	label: string;
	glyph: string;
	color: string;
}

export const CONDITIONS: ConditionOption[] = [
	{ value: "MT", label: "Mint", glyph: "MT", color: "#4ba0b5" },
	{ value: "NM", label: "Near Mint", glyph: "NM", color: "#5fad60" },
	{ value: "EX", label: "Excellent", glyph: "EX", color: "#838934" },
	{ value: "GD", label: "Good", glyph: "GD", color: "#f5c344" },
	{ value: "LP", label: "Light Played", glyph: "LP", color: "#ee9144" },
	{ value: "PL", label: "Played", glyph: "PL", color: "#d66f76" },
	{ value: "PO", label: "Poor", glyph: "PO", color: "#cb444a" },
];

// Virtual object returned for an empty/unrecognized value — never a member
// of CONDITIONS (so never iterated in a picker), same role as UNSET_LANGUAGE
// above: describes the state for text display (e.g. the chip search, which
// already treats "none" as its own condition keyword — see card-search.ts)
// and for supplying glyph "–" to the old badge rendering still used by that
// search chip.
const UNSET_CONDITION: ConditionOption = { value: "", label: "None", glyph: "–", color: "var(--text-faint)" };

export function getCondition(value: string): ConditionOption {
	return CONDITIONS.find((c) => c.value === value) ?? UNSET_CONDITION;
}

// Limited Edition Alpha (1993) had visibly more rounded corners than the
// rest of the Magic printings — reproduced via a dedicated CSS class
// wherever a card image is displayed.
export function isAlphaSet(setCode: string): boolean {
	return setCode.toLowerCase() === "lea";
}
