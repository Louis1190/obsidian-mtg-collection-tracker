import { LANGUAGES, getLanguage } from "./card-model";

/* -------------------------------------------------------------------------- */
/*  Cards printed in a language other than English                            */
/* -------------------------------------------------------------------------- */

// Scryfall holds one card object per (printing, language): the French Rocky
// Rebuke has its own id, its own picture and its own `printed_name`, but its
// `name` is still the English one and ALL of its prices are null (prices exist
// only on the English print, checked live 2026-11-07). The plugin therefore
// keeps the ENGLISH print as a card's identity (price, legalities, rules text
// and price history all hang on it) and records the language as a per-copy tag
// (`language`). These helpers decide when a search hit is such a foreign print
// and how it is folded back onto its English counterpart. Pure on purpose: the
// network half lives in api/scryfall.ts.

// The fields of a Scryfall card these helpers read. Structural, so this file
// stays free of the (Obsidian-importing) API layer.
export interface PrintFields {
	id: string;
	set: string;
	collector_number: string;
	lang?: string;
	printed_name?: string;
}

// True for a print that is not in English. A card object with no `lang` at all
// (old cached data, test doubles) counts as English.
export function isForeignPrint(card: { lang?: string }): boolean {
	return !!card.lang && card.lang !== "en";
}

// The value to store in a copy's `language` for this print: "" for English
// (the tag stays empty as it always has), the plugin's own code for a language
// it knows, and "" for one it has no flag/label for yet (he, la, grc, ar, sa,
// ph: Scryfall has prints in them, the plugin's LANGUAGES list does not).
export function languageCodeOfPrint(card: { lang?: string }): string {
	if (!isForeignPrint(card)) return "";
	const lang = card.lang as string;
	return LANGUAGES.some((l) => l.code === lang) ? lang : "";
}

// Key of a printing across languages: the same set and collector number is the
// same printing in English and in French.
export function printKey(card: { set: string; collector_number: string }): string {
	return `${card.set.toLowerCase()}/${card.collector_number}`;
}

// Folds a foreign hit onto its English counterpart: the English card (id,
// name, picture, prices, rules text) carrying the hit's `lang` and
// `printed_name`. Without a counterpart, or when the "counterpart" is itself
// not English (a printing that exists in a single foreign language, such as
// the Japanese-only alternate arts of Strixhaven Mystical Archive, which have
// prices of their own), the hit is kept as it is.
export function withPrintLanguage<T extends PrintFields>(hit: T, counterpart: T | null | undefined): T {
	if (!counterpart || counterpart.id === hit.id) return hit;
	if (isForeignPrint(counterpart)) return hit;
	return { ...counterpart, lang: hit.lang, printed_name: hit.printed_name };
}

// Does the query already say which language it wants (`lang:fr`, `-lang:any`,
// `language:ja`)? Then the search must not be widened behind the user's back.
export function hasLangClause(query: string): boolean {
	return /(?:^|[\s(])-?(?:lang|language):/i.test(query);
}

// A term that is "a clause" (`t:elf`, `c=r`, `cmc>=3`, `-is:foil`, `s:tla`)
// rather than a piece of a card name. ASCII letters only on purpose: a word in
// kana, hangul or Cyrillic is never a Scryfall keyword.
const CLAUSE_TERM = /^-?\(*[a-z][a-z0-9_]*(?::|=|!=|<=|>=|<|>)/i;
const BOOLEAN_TERM = /^(?:and|or|\(|\)|-)$/i;

// Splits a query on spaces that are not inside double quotes.
function queryTerms(query: string): string[] {
	const terms: string[] = [];
	let current = "";
	let quoted = false;
	for (const ch of query) {
		if (ch === '"') quoted = !quoted;
		if (!quoted && /\s/.test(ch)) {
			if (current) terms.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current) terms.push(current);
	return terms;
}

// Does the query contain at least one piece of a card name? Only then is it
// worth asking Scryfall again in every language when nothing was found: a
// search made of clauses alone (`c:r t:elf cmc>=9`) has no name to translate.
export function hasNameTerm(query: string): boolean {
	return queryTerms(query).some((term) => !CLAUSE_TERM.test(term) && !BOOLEAN_TERM.test(term));
}

// Does a piece of the card name contain a letter outside ASCII (an accent, kana, hanzi, Cyrillic…)?
// Almost no English card name has one (Lim-Dûl's Vault, Juzám Djinn, Jötun Grunt… a dozen in all), so a name typed
// that way is looked for in every language straight away instead of only when English finds nothing: an English
// partial match ("Blâme" contained in some English name) must not hide the card the user means.
export function hasNonAsciiNameLetter(query: string): boolean {
	return queryTerms(query)
		.filter((term) => !CLAUSE_TERM.test(term) && !BOOLEAN_TERM.test(term))
		.some((term) => Array.from(term).some((ch) => ch.charCodeAt(0) > 127 && /\p{L}/u.test(ch)));
}

// The widened query: same terms, every language. Scryfall answers a search for
// a foreign name only when asked for `lang:any` (or the language itself).
export function inAnyLanguage(query: string): string {
	return `${query} lang:any`;
}

// Whether an empty English search deserves a second try in every language.
export function shouldTryAnyLanguage(query: string): boolean {
	return !hasLangClause(query) && hasNameTerm(query);
}

// Whether the search should skip the English-only try and ask for every language at once: a name that
// cannot be an English name (see hasNonAsciiNameLetter). `lang:any` includes the English prints, so nothing is lost.
export function shouldSearchAnyLanguageFirst(query: string): boolean {
	return shouldTryAnyLanguage(query) && hasNonAsciiNameLetter(query);
}

// Tooltip of the language button of a copy's detail window. A copy in another
// language is priced as its English print (a foreign print has no price of its
// own), which is worth one discreet sentence where the language is shown.
export function languageTooltip(code: string): string {
	const label = getLanguage(code).label;
	return isForeignPrint({ lang: code }) ? `${label}. Prices are those of the English printing.` : label;
}
