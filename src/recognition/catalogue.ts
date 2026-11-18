// The catalogue of card names, English and localized: one row per card, the English name (the card's identity, what a Scryfall lookup takes) and its
// name in each language the plugin knows. Pure. The file is built from MTGJSON's AtomicCards by tools/android/probes/card-scan/build-catalogue.mjs
// (a tab-separated text: English, fr, de, es, it, pt, ja, ko, ru, zhs, zht; a cell is empty when MTGJSON has no name or the English one again).

import { buildNameIndex, normalizeName, type NameIndex } from "./name-match";

/** The columns after the English name, in file order. Same codes as the plugin's language option list. */
export const CATALOGUE_LANGUAGES = ["fr", "de", "es", "it", "pt", "ja", "ko", "ru", "zhs", "zht"] as const;
export type CatalogueLanguage = (typeof CATALOGUE_LANGUAGES)[number];

export interface CatalogueRow {
	english: string;
	/** the localized names that exist */
	names: Partial<Record<CatalogueLanguage, string>>;
}

/** Parses the tab-separated catalogue; blank lines are skipped, a row with no English name is ignored. */
export function parseCatalogue(tsv: string): CatalogueRow[] {
	const rows: CatalogueRow[] = [];
	for (const line of tsv.split("\n")) {
		if (!line) continue;
		const cells = line.replace(/\r$/, "").split("\t");
		const english = cells[0];
		if (!english) continue;
		const names: Partial<Record<CatalogueLanguage, string>> = {};
		CATALOGUE_LANGUAGES.forEach((lang, i) => {
			const cell = cells[i + 1];
			if (cell) names[lang] = cell;
		});
		rows.push({ english, names });
	}
	return rows;
}

/**
 * The index over the English names and the localized names of the languages asked for. An entry's owner is its row number: `rows[owner]` is the card.
 * Only Latin-script languages are worth asking for: the English OCR model cannot read the others, and their names normalise to nothing.
 */
export function catalogueIndex(rows: readonly CatalogueRow[], languages: readonly CatalogueLanguage[]): NameIndex {
	const strings: string[] = [];
	const owners: number[] = [];
	rows.forEach((row, i) => {
		strings.push(row.english);
		owners.push(i);
		for (const lang of languages) {
			const name = row.names[lang];
			if (name) {
				strings.push(name);
				owners.push(i);
			}
		}
	});
	return buildNameIndex(strings, owners);
}

/** The names the short-name reader knows: 3 to 5 letters once normalised (229 English and 84 French names of the 35 000 cards). */
export const SHORT_NAME_MIN_LENGTH = 3;
export const SHORT_NAME_MAX_LENGTH = 5;

/**
 * The index of ONLY the short names (English and the languages asked for; an "A // B" name is always longer): a name that short matches inside any noise, so the whole-catalogue reader
 * refuses it (`READING_CONFIG.minKeyLength`), and it is read here instead, by a reader that takes nothing but a whole line (`SHORT_NAME_CONFIG`). An entry's owner is its row, as in `catalogueIndex`.
 */
export function shortNameIndex(rows: readonly CatalogueRow[], languages: readonly CatalogueLanguage[]): NameIndex {
	const strings: string[] = [];
	const owners: number[] = [];
	const isShort = (name: string): boolean => {
		const n = normalizeName(name).length;
		return n >= SHORT_NAME_MIN_LENGTH && n <= SHORT_NAME_MAX_LENGTH;
	};
	rows.forEach((row, i) => {
		for (const name of [row.english, ...languages.map((l) => row.names[l])]) {
			if (name && isShort(name)) {
				strings.push(name);
				owners.push(i);
			}
		}
	});
	return buildNameIndex(strings, owners);
}

/**
 * In which language a card's name matched: `key` is the normalised name an index entry gave (NameMatch.key). A face of a double-faced card is a part of
 * the combined name, so a name "contains" the key; the English name wins a tie (a localized name equal to it is not a language signal).
 */
export function matchedLanguage(row: CatalogueRow, key: string): CatalogueLanguage | "en" {
	const has = (name: string) => normalizeName(name) === key || name.split(" // ").some((face) => normalizeName(face) === key);
	if (has(row.english)) return "en";
	for (const lang of CATALOGUE_LANGUAGES) {
		const name = row.names[lang];
		if (name && has(name)) return lang;
	}
	return "en";
}

/** The row of each card by its lower-cased English name, and by each face of a double name ("fire // ice" and "fire", "ice"): the first row wins a name two share. */
export function rowIndexByName(rows: readonly CatalogueRow[]): Map<string, number> {
	const byName = new Map<string, number>();
	rows.forEach((row, i) => {
		for (const key of [row.english, ...row.english.split(" // ")]) {
			const k = key.toLowerCase();
			if (k && !byName.has(k)) byName.set(k, i);
		}
	});
	return byName;
}

/** The names a card's title can bear: the English one, then the localized ones of the languages the index was built for (each name only once). */
export function namesOfRow(row: CatalogueRow, languages: readonly CatalogueLanguage[]): string[] {
	const names = [row.english];
	for (const lang of languages) {
		const name = row.names[lang];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * The index of the cards of ONE SET, from their English names (Scryfall's list of the set): a card the catalogue knows is owned by its row (so its localized names are in the index
 * too and the result reads like any other); a card it does not know (newer than the snapshot, a name written differently) gets a row of its own pushed on `extraRows`, numbered after
 * the catalogue's, which the caller hands back with the catalogue's rows (`rows[owner]` is then the card, whichever kind it is). `extraRows` is shared between calls so that two sets
 * asked for in one scan never reuse a number.
 */
export function buildSetScopeIndex(
	names: readonly string[],
	rows: readonly CatalogueRow[],
	rowByName: ReadonlyMap<string, number>,
	languages: readonly CatalogueLanguage[],
	extraRows: CatalogueRow[],
): NameIndex {
	const strings: string[] = [];
	const owners: number[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const key = name.toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		let owner = rowByName.get(key);
		let list: string[];
		if (owner === undefined) {
			owner = rows.length + extraRows.length;
			extraRows.push({ english: name, names: {} });
			list = [name];
		} else list = namesOfRow(rows[owner], languages);
		for (const n of list) {
			strings.push(n);
			owners.push(owner);
		}
	}
	return buildNameIndex(strings, owners);
}
