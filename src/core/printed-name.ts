import { LANGUAGES } from "./card-model";

/* -------------------------------------------------------------------------- */
/*  The name a copy is printed with, in its own language                      */
/* -------------------------------------------------------------------------- */

// A copy in French is still stored as the ENGLISH print (see core/foreign-print.ts), so its
// `name` is "Rocky Rebuke". The name printed on it ("Blâme de pierre") is a fact about a
// (printing, language) pair, so it is kept in a cache of its own under that pair
// (plugin/printed-names.ts) rather than on the copy: changing a copy's language or printing
// then changes its name by itself, and nothing about it travels through the sync merge.
// Pure on purpose: the cache and the requests live in the plugin layer.

// Which name the lists show: the English one (the default, and what every export writes) or the
// one printed on the copy when its language is not English.
export type CardNameMode = "english" | "printed";

export const CARD_NAME_MODES: readonly CardNameMode[] = ["english", "printed"];

// Which picture the lists and the detail window show for a copy in another language: the English print's (the
// default) or the one of the print in the copy's own language, when Scryfall has a real scan of it.
export type CardImageMode = "english" | "printed";

// The fields of a collection or deck copy these helpers read.
export interface PrintedNameSubject {
	name: string;
	// Optional because the search layer's own card type (SearchableCard) leaves them optional.
	setCode?: string;
	collectorNumber?: string;
	language?: string;
}

// Key of a name in the cache: set, collector number and language of the copy
// ("tla:193:fr"). Null for a copy that has no printed name of its own to look up: English, no
// language chosen, a language the plugin has no entry for (he, la, grc, ar, sa, ph), or no set.
export function printedNameKey(card: Omit<PrintedNameSubject, "name">): string | null {
	const lang = card.language ?? "";
	if (!lang || lang === "en") return null;
	if (!LANGUAGES.some((l) => l.code === lang)) return null;
	if (!card.setCode || !card.collectorNumber) return null;
	return `${card.setCode.toLowerCase()}:${card.collectorNumber}:${lang}`;
}

// The same key for a Scryfall card that carries `lang` (what the add-cards search hands over):
// lets a copy added by its French name have its name known without any request.
export function printedNameKeyOfHit(card: { set: string; collector_number: string; lang?: string }): string | null {
	return printedNameKey({ setCode: card.set, collectorNumber: card.collector_number, language: card.lang });
}

export interface PrintedNameParts {
	set: string;
	collectorNumber: string;
	lang: string;
}

// The language is the last segment, the set the first: a collector number may hold anything in between.
export function parsePrintedNameKey(key: string): PrintedNameParts | null {
	const first = key.indexOf(":");
	const last = key.lastIndexOf(":");
	if (first <= 0 || last <= first) return null;
	return { set: key.slice(0, first), collectorNumber: key.slice(first + 1, last), lang: key.slice(last + 1) };
}

// Scryfall's card by set, number and language. Not one of the 2-requests-per-second endpoints.
export function printedNameUrl(parts: PrintedNameParts): string {
	return `https://api.scryfall.com/cards/${encodeURIComponent(parts.set)}/${encodeURIComponent(parts.collectorNumber)}/${encodeURIComponent(parts.lang)}`;
}

// What a 200 answer gives: the printed name, or "" when the print has none of its own (the cache
// then remembers "no localized name", so the card is not asked about again).
export function printedNameFromBody(body: unknown): string {
	const value = (body as { printed_name?: unknown } | null | undefined)?.printed_name;
	return typeof value === "string" ? value.trim() : "";
}

// The picture address of a foreign print, from the body of the same answer that gives its name — or "" when Scryfall has no real
// picture of it. Scryfall's `image_status` says which: "highres_scan" and "lowres" are real scans (lowres is a smaller one), while
// "placeholder" (a stand-in drawn by Scryfall, common for older sets) and "missing" are not and must never replace the English
// picture. A double-faced card has its pictures on its faces: the front one is used, as for the English print (getImageUrl).
const REAL_SCAN_STATUSES = new Set(["highres_scan", "lowres"]);

export function printedImageFromBody(body: unknown): string {
	const card = body as
		| { image_status?: unknown; image_uris?: { normal?: unknown }; card_faces?: { image_uris?: { normal?: unknown } }[] }
		| null
		| undefined;
	if (!card || typeof card.image_status !== "string" || !REAL_SCAN_STATUSES.has(card.image_status)) return "";
	const url = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
	// https only, like every picture the plugin fetches ahead (isFetchableImageUrl): an address taken from an answer is not trusted further.
	return typeof url === "string" && url.startsWith("https://") ? url : "";
}

// The picture to show for a copy. `printedImage` is what the cache knows (undefined = not known yet, "" = no real printed
// picture): in every doubtful case the English picture is shown.
export function displayImage(englishImageUrl: string, mode: CardImageMode, printedImage: string | undefined): string {
	return mode === "printed" && printedImage ? printedImage : englishImageUrl;
}

// The text without its accents and in lower case, for comparing what a user types with a printed name: Scryfall ignores accents in
// its own searches ("l'ile" finds "l'île"), and the collection search must too. Only used on printed names: English names are
// compared as they always were.
export function foldAccents(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// The name to show for a copy. `printedName` is what the cache knows for it (undefined = not known
// yet, "" = known to have none): in every doubtful case the English name is shown.
export function displayName(card: Pick<PrintedNameSubject, "name">, mode: CardNameMode, printedName: string | undefined): string {
	return mode === "printed" && printedName ? printedName : card.name;
}
