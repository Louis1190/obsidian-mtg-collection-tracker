import {
	Finish,
	parseFinishValue,
	GradingCompany,
	GRADING_COMPANY_OPTIONS,
	LANGUAGES,
} from "../core/card-model";
import {
	searchScryfall,
	getImageUrl,
	getArtCropUrl,
	parseCsv,
	sleep,
	fetchScryfallCollection,
	buildCardTextInfo,
} from "../api/scryfall";
import {
	genId,
	SavedSearchFilter,
	DeckCardCategory,
	getDeckCardCategory,
	isDeckCommander,
} from "../core/data-model";
import { parseDecklistText, ParsedDecklistLine } from "../core/decklist-import";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  CSV + decklist import (Collection/Wantlist/Deck), saved search filters.
    Split out of plugin.ts on 2026-09-10.  */
/* -------------------------------------------------------------------------- */

export async function importDecklistToDeck(this: MTGCollectionPlugin, 
	deckId: string,
	text: string,
	onProgress: (msg: string) => void
): Promise<{ added: number; unresolved: string[] }> {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) throw new Error("Deck not found.");

	const { lines, unparsedLines } = parseDecklistText(text);
	if (lines.length === 0) {
		return { added: 0, unresolved: unparsedLines };
	}

	onProgress(`Parsed ${lines.length} card(s)…`);

	interface ResolvedLine {
		line: ParsedDecklistLine;
		scryfallId?: string;
	}
	const resolvedLines: ResolvedLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		onProgress(`Resolving ${line.name} (${i + 1}/${lines.length})…`);
		let scryfallId: string | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const { cards: results } = await searchScryfall(
					line.name,
					line.setCode ?? "",
					line.collectorNumber ?? ""
				);
				scryfallId = results[0]?.id;
				break;
			} catch {
				if (attempt === 0) await sleep(300);
			}
		}
		resolvedLines.push({ line, scryfallId });
	}

	const resolved = resolvedLines.filter((r) => r.scryfallId);
	const unresolved = [
		...unparsedLines,
		...resolvedLines.filter((r) => !r.scryfallId).map((r) => r.line.raw),
	];

	const uniqueIds = Array.from(new Set(resolved.map((r) => r.scryfallId!)));
	const enrichMap = await fetchScryfallCollection(uniqueIds, onProgress);

	let added = 0;
	resolved.forEach(({ line, scryfallId }) => {
		const scry = enrichMap.get(scryfallId!);
		if (!scry) return;
		// "mainboard" stays absent rather than explicitly persisted — see
		// DeckCard.category (data-model.ts), by far the most common case.
		const category: DeckCardCategory | undefined =
			line.category === "mainboard" ? undefined : line.category;
		// Merges only with an entry already present for the SAME category AND the
		// same Commander status — a card can legitimately appear both as Commander
		// and as a card of the main deck (Backgrounds, for example, or simply 2
		// copies of a same partner Commander counted separately), merging the two
		// would wrongly count both roles together. Category alone is no longer
		// enough to tell them apart since Commander became a Function rather than
		// a 4th category (both are now "mainboard") — hence this 2nd criterion.
		const existing = deck.cards.find(
			(c) =>
				c.scryfallId === scry.id &&
				getDeckCardCategory(c) === (category ?? "mainboard") &&
				isDeckCommander(c) === line.isCommander
		);
		if (existing) {
			existing.count += line.quantity;
			existing.dateModified = Date.now();
			// A Commander line that merges into an entry already tagged Commander has
			// nothing more to do here (deckFunctionOverride already set) — no separate
			// branch needed, unlike category, which never needed rewriting on a merge
			// either.
		} else {
			const now = Date.now();
			deck.cards.push({
				scryfallId: scry.id,
				name: scry.name,
				setCode: scry.set,
				setName: scry.set_name,
				collectorNumber: scry.collector_number,
				imageUrl: getImageUrl(scry),
				artCropUrl: getArtCropUrl(scry),
				manaCost: scry.mana_cost ?? "",
				manaValue: scry.cmc ?? 0,
				typeLine: scry.type_line,
				rarity: scry.rarity,
				artist: scry.artist ?? "",
				colors: scry.colors ?? [],
				keywords: scry.keywords ?? [],
				count: line.quantity,
				dateAdded: now,
				dateModified: now,
				borderColor: scry.border_color ?? "",
				frame: scry.frame ?? "",
				frameEffects: scry.frame_effects ?? [],
				oracleText: buildCardTextInfo(scry).oracleText,
				priceUsd: scry.prices?.usd ?? "",
				priceUsdFoil: scry.prices?.usd_foil ?? "",
				priceEur: scry.prices?.eur ?? "",
				priceEurFoil: scry.prices?.eur_foil ?? "",
				priceUsdEtched: scry.prices?.usd_etched ?? "",
				priceEurEtched: scry.prices?.eur_etched ?? "",
				category,
				// "Commander" (see isDeckCommander/DECK_FUNCTION_CATEGORIES,
				// data-model.ts/deck-function.ts) — never set for an ordinary
				// mainboard/sideboard/maybeboard line, left absent rather than explicitly
				// persisted, same fallback as category above.
				deckFunctionOverride: line.isCommander ? "Commander" : undefined,
			});
		}
		added++;
	});

	await this.saveSettings();
	return { added, unresolved };
}

// CSV import for ONE SINGLE deck (DeckSettingsModal, "Import" → "Import CSV", harmonized with
// ListSettingsModal) — until now a deck had no CSV import path (see "Data model notes" in CLAUDE.md,
// "deck CSV remains export-only"), only the decklist import above existed. Same mechanism as importCsv
// further down (Scryfall resolution of the lines without Scryfall Id, a single retry after a short
// pause, a single grouped fetchScryfallCollection), same column header as buildDeckCsvString (view.ts)
// — but finds an existing row by scryfallId + category (same identity key as
// mergeDeckDuplicates/changeDeckCardPrinting, deck-mutations.ts, and the decklist import above, same
// file), not by listId+finish+language+condition like importCsv. No "Category"/board column in this
// CSV format — each imported row becomes a mainboard entry (same fallback as any card added outside a
// decklist import, see DeckCardCategory). The "row already present" branch does NOT touch
// finish/language/condition of an existing entry — same convention already established for importCsv
// (a merge only refreshes the Scryfall-sourced fields + count, never those three).

export async function importDeckCsv(this: MTGCollectionPlugin, 
	deckId: string,
	text: string,
	onProgress: (msg: string) => void
): Promise<{ added: number; updated: number; skipped: number }> {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) throw new Error("Deck not found.");
	const rows = parseCsv(text);
	if (rows.length < 2) throw new Error("Empty or invalid CSV file.");

	const header = rows[0].map((h) => h.trim().toLowerCase());
	const idx = (names: string[]) => {
		for (const n of names) {
			const i = header.indexOf(n.toLowerCase());
			if (i !== -1) return i;
		}
		return -1;
	};

	const qtyIdx = idx(["quantity", "count"]);
	const nameIdx = idx(["card name", "name"]);
	const setCodeIdx = idx(["set code", "setcode"]);
	const setNameIdx = idx(["set", "set name", "edition"]);
	const numberIdx = idx(["number", "collector number", "collectornumber"]);
	const finishIdx = idx(["finish"]);
	const legacyFoilIdx = idx(["foil/etched", "foil"]);
	const languageIdx = idx(["language", "lang"]);
	const conditionIdx = idx(["condition"]);
	const scryfallIdIdx = idx(["scryfall id", "scryfallid"]);
	const rarityIdx = idx(["rarity"]);
	const typeLineIdx = idx(["type line", "typeline"]);
	const manaCostIdx = idx(["mana cost", "manacost"]);
	const gradingCompanyIdx = idx(["grading company", "graded by", "gradingcompany"]);
	const gradingGradeIdx = idx(["grade", "grading grade", "gradinggrade"]);
	const gradingLabelIdx = idx(["grading label", "gradinglabel"]);
	const customPriceIdx = idx(["custom price", "customprice"]);

	if (nameIdx === -1) {
		throw new Error(
			"CSV must have a 'Card Name' or 'Name' column. Columns found: " + rows[0].join(", ")
		);
	}

	interface PendingDeckRow {
		scryfallId?: string;
		name: string;
		setCode: string;
		setName: string;
		number: string;
		rarity: string;
		typeLine: string;
		manaCost: string;
		qty: number;
		finish: Finish;
		language: string;
		condition: string;
		gradingCompany?: GradingCompany;
		gradingGrade?: number;
		gradingLabel?: string;
		customPrice?: string;
	}

	const pending: PendingDeckRow[] = [];
	for (let r = 1; r < rows.length; r++) {
		const row = rows[r];
		const name = nameIdx !== -1 ? row[nameIdx]?.trim() : "";
		if (!name) continue;
		const qty = qtyIdx !== -1 ? Math.max(1, parseInt(row[qtyIdx], 10) || 1) : 1;
		const finishRaw = finishIdx !== -1 ? row[finishIdx] : legacyFoilIdx !== -1 ? row[legacyFoilIdx] : "";
		const langRaw = languageIdx !== -1 ? row[languageIdx]?.trim().toLowerCase() : "";
		const gradingCompanyRaw = gradingCompanyIdx !== -1 ? row[gradingCompanyIdx]?.trim() : "";
		const gradingCompany = GRADING_COMPANY_OPTIONS.some((g) => g.value === gradingCompanyRaw)
			? (gradingCompanyRaw as GradingCompany)
			: undefined;
		const gradingGradeRaw = gradingGradeIdx !== -1 ? row[gradingGradeIdx]?.trim() : "";
		const gradingGrade =
			gradingGradeRaw && !Number.isNaN(parseFloat(gradingGradeRaw))
				? parseFloat(gradingGradeRaw)
				: undefined;
		const gradingLabel = gradingLabelIdx !== -1 ? row[gradingLabelIdx]?.trim() : "";
		const customPrice = customPriceIdx !== -1 ? row[customPriceIdx]?.trim() : "";
		pending.push({
			scryfallId: scryfallIdIdx !== -1 ? row[scryfallIdIdx]?.trim() : undefined,
			name,
			setCode: setCodeIdx !== -1 ? row[setCodeIdx]?.trim() : "",
			setName: setNameIdx !== -1 ? row[setNameIdx]?.trim() : "",
			number: numberIdx !== -1 ? row[numberIdx]?.trim() : "",
			rarity: rarityIdx !== -1 ? row[rarityIdx]?.trim() : "",
			typeLine: typeLineIdx !== -1 ? row[typeLineIdx]?.trim() : "",
			manaCost: manaCostIdx !== -1 ? row[manaCostIdx]?.trim() : "",
			qty,
			finish: parseFinishValue(finishRaw),
			language: LANGUAGES.some((l) => l.code === langRaw) ? langRaw : "",
			condition: conditionIdx !== -1 ? row[conditionIdx]?.trim() : "",
			gradingCompany,
			gradingGrade,
			gradingLabel,
			customPrice,
		});
	}

	onProgress(`Parsed ${pending.length} rows…`);

	const toResolve = pending.filter((r) => !r.scryfallId);
	for (let i = 0; i < toResolve.length; i++) {
		const row = toResolve[i];
		onProgress(`Resolving ${row.name} (${i + 1}/${toResolve.length})…`);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const { cards: results } = await searchScryfall(row.name, row.setCode, row.number);
				if (results.length > 0) row.scryfallId = results[0].id;
				break;
			} catch {
				if (attempt === 0) await sleep(300);
			}
		}
		await new Promise((res) => window.setTimeout(res, 100));
	}

	const resolved = pending.filter((r) => r.scryfallId);
	const skipped = pending.length - resolved.length;

	const uniqueIds = Array.from(new Set(resolved.map((r) => r.scryfallId!)));
	const enrichMap = await fetchScryfallCollection(uniqueIds, onProgress);

	let added = 0;
	let updated = 0;

	resolved.forEach((row) => {
		const id = row.scryfallId!;
		const scry = enrichMap.get(id);
		const existing = deck.cards.find(
			(c) => c.scryfallId === id && getDeckCardCategory(c) === "mainboard"
		);
		if (existing) {
			existing.count += row.qty;
			existing.dateModified = Date.now();
			if (scry) {
				existing.imageUrl = getImageUrl(scry) || existing.imageUrl;
				// Same gesture as importCsv (My Collection) — a merge refreshes the price
				// (not immutable, unlike border/frame/oracleText, never touched on merge),
				// without overwriting existing finish/language/condition (see this
				// method's comment).
				existing.priceUsd = scry.prices?.usd ?? existing.priceUsd;
				existing.priceUsdFoil = scry.prices?.usd_foil ?? existing.priceUsdFoil;
				existing.priceEur = scry.prices?.eur ?? existing.priceEur;
				existing.priceEurFoil = scry.prices?.eur_foil ?? existing.priceEurFoil;
				existing.priceUsdEtched = scry.prices?.usd_etched ?? existing.priceUsdEtched;
				existing.priceEurEtched = scry.prices?.eur_etched ?? existing.priceEurEtched;
			}
			updated++;
		} else {
			const now = Date.now();
			deck.cards.push({
				scryfallId: id,
				name: scry?.name ?? row.name,
				setCode: (scry?.set ?? row.setCode).toLowerCase(),
				setName: scry?.set_name ?? row.setName ?? row.setCode ?? "Imported",
				collectorNumber: scry?.collector_number ?? row.number,
				imageUrl: scry ? getImageUrl(scry) : "",
				artCropUrl: scry ? getArtCropUrl(scry) : "",
				manaCost: scry?.mana_cost ?? row.manaCost,
				manaValue: scry?.cmc ?? 0,
				typeLine: scry?.type_line ?? row.typeLine,
				rarity: scry?.rarity ?? row.rarity,
				artist: scry?.artist ?? "",
				colors: scry?.colors ?? [],
				keywords: scry?.keywords ?? [],
				count: row.qty,
				dateAdded: now,
				dateModified: now,
				borderColor: scry?.border_color ?? "",
				frame: scry?.frame ?? "",
				frameEffects: scry?.frame_effects ?? [],
				oracleText: scry ? buildCardTextInfo(scry).oracleText : "",
				priceUsd: scry?.prices?.usd ?? "",
				priceUsdFoil: scry?.prices?.usd_foil ?? "",
				priceEur: scry?.prices?.eur ?? "",
				priceEurFoil: scry?.prices?.eur_foil ?? "",
				priceUsdEtched: scry?.prices?.usd_etched ?? "",
				priceEurEtched: scry?.prices?.eur_etched ?? "",
				finish: row.finish,
				language: row.language,
				condition: row.condition,
				gradingCompany: row.gradingCompany,
				gradingGrade: row.gradingGrade,
				gradingLabel: row.gradingLabel,
				customPrice: row.customPrice,
			});
			added++;
		}
	});

	await this.saveSettings();
	return { added, updated, skipped };
}

// Import of an external decklist (Moxfield/Archidekt/plain text, "Import
// TXT" of ListSettingsModal) directly into a My Collection list — same
// mechanism as importDecklistToDeck just above (parseDecklistText,
// line-by-line resolution via searchScryfall, grouped enrichment via
// fetchScryfallCollection), but merges/creates CollectionCards
// (settings.collection) rather than DeckCards, with the same set of fields
// as the "new row" branch of importCsv further down (same data source — a
// resolved ScryfallCard — hence same shape). line.category/isCommander are
// ignored here: this split only makes sense for a deck, a collection list
// has no such notion — each line becomes a "normal" card of the list.
// finish/language/condition don't exist in a text file: same fallbacks as
// importCsv when these columns are absent from the CSV ("regular"/""/"").

export async function importDecklistToList(this: MTGCollectionPlugin, 
	listId: string,
	text: string,
	onProgress: (msg: string) => void
): Promise<{ added: number; updated: number; unresolved: string[] }> {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (!list) throw new Error("List not found.");

	const { lines, unparsedLines } = parseDecklistText(text);
	if (lines.length === 0) {
		return { added: 0, updated: 0, unresolved: unparsedLines };
	}

	onProgress(`Parsed ${lines.length} card(s)…`);

	interface ResolvedLine {
		line: ParsedDecklistLine;
		scryfallId?: string;
	}
	const resolvedLines: ResolvedLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		onProgress(`Resolving ${line.name} (${i + 1}/${lines.length})…`);
		let scryfallId: string | undefined;
		// A single retry after a short pause on a network/HTTP failure — same
		// reasoning as importDecklistToDeck above.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const { cards: results } = await searchScryfall(
					line.name,
					line.setCode ?? "",
					line.collectorNumber ?? ""
				);
				scryfallId = results[0]?.id;
				break;
			} catch {
				if (attempt === 0) await sleep(300);
			}
		}
		resolvedLines.push({ line, scryfallId });
	}

	const resolved = resolvedLines.filter((r) => r.scryfallId);
	const unresolved = [
		...unparsedLines,
		...resolvedLines.filter((r) => !r.scryfallId).map((r) => r.line.raw),
	];

	const uniqueIds = Array.from(new Set(resolved.map((r) => r.scryfallId!)));
	const enrichMap = await fetchScryfallCollection(uniqueIds, onProgress);

	let added = 0;
	let updated = 0;
	resolved.forEach(({ line, scryfallId }) => {
		const scry = enrichMap.get(scryfallId!);
		if (!scry) return;
		const existing = this.settings.collection.find(
			(c) =>
				c.scryfallId === scry.id &&
				c.listId === listId &&
				c.finish === "regular" &&
				c.language === "" &&
				c.condition === ""
		);
		if (existing) {
			existing.count += line.quantity;
			existing.dateModified = Date.now();
			existing.imageUrl = getImageUrl(scry) || existing.imageUrl;
			existing.priceUsd = scry.prices?.usd ?? existing.priceUsd;
			existing.priceUsdFoil = scry.prices?.usd_foil ?? existing.priceUsdFoil;
			existing.priceEur = scry.prices?.eur ?? existing.priceEur;
			existing.priceEurFoil = scry.prices?.eur_foil ?? existing.priceEurFoil;
			existing.priceUsdEtched = scry.prices?.usd_etched ?? existing.priceUsdEtched;
			existing.priceEurEtched = scry.prices?.eur_etched ?? existing.priceEurEtched;
			updated++;
			this.recentlyAddedCollectionCardIds.add(existing.id);
		} else {
			const now = Date.now();
			const newId = genId();
			this.settings.collection.push({
				id: newId,
				scryfallId: scry.id,
				name: scry.name,
				setCode: scry.set,
				setName: scry.set_name,
				collectorNumber: scry.collector_number,
				rarity: scry.rarity,
				manaCost: scry.mana_cost ?? "",
				manaValue: scry.cmc ?? 0,
				typeLine: scry.type_line,
				artist: scry.artist ?? "",
				colors: scry.colors ?? [],
				keywords: scry.keywords ?? [],
				releasedAt: scry.released_at ?? "",
				imageUrl: getImageUrl(scry),
				artCropUrl: getArtCropUrl(scry),
				priceUsd: scry.prices?.usd ?? "",
				priceUsdFoil: scry.prices?.usd_foil ?? "",
				priceEur: scry.prices?.eur ?? "",
				priceEurFoil: scry.prices?.eur_foil ?? "",
				priceUsdEtched: scry.prices?.usd_etched ?? "",
				priceEurEtched: scry.prices?.eur_etched ?? "",
				count: line.quantity,
				finish: "regular",
				language: "",
				condition: "",
				listId,
				dateAdded: now,
				dateModified: now,
				borderColor: scry.border_color ?? "",
				frame: scry.frame ?? "",
				frameEffects: scry.frame_effects ?? [],
				oracleText: buildCardTextInfo(scry).oracleText,
			});
			added++;
			this.recentlyAddedCollectionCardIds.add(newId);
		}
	});

	await this.saveSettings();
	return { added, updated, unresolved };
}

// Import of an external decklist (Moxfield/Archidekt/plain text, "Import
// TXT" of WantlistSettingsModal) directly into a wantlist — same mechanism
// as importDecklistToList just above, but merges/creates WantlistCards
// (settings.wantlist) rather than CollectionCards, without
// language/condition (WantlistCard has neither — see "Data model notes" in
// CLAUDE.md), hence a merge key scryfallId+listId+finish rather than
// +language+condition like importDecklistToList. line.category/isCommander
// are ignored here for the same reason as on the list side: no notion of
// "board" for a wantlist.

export async function importDecklistToWantlist(this: MTGCollectionPlugin, 
	wantlistId: string,
	text: string,
	onProgress: (msg: string) => void
): Promise<{ added: number; updated: number; unresolved: string[] }> {
	const wantlist = this.settings.wantlists.find((w) => w.id === wantlistId);
	if (!wantlist) throw new Error("Wantlist not found.");

	const { lines, unparsedLines } = parseDecklistText(text);
	if (lines.length === 0) {
		return { added: 0, updated: 0, unresolved: unparsedLines };
	}

	onProgress(`Parsed ${lines.length} card(s)…`);

	interface ResolvedLine {
		line: ParsedDecklistLine;
		scryfallId?: string;
	}
	const resolvedLines: ResolvedLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		onProgress(`Resolving ${line.name} (${i + 1}/${lines.length})…`);
		let scryfallId: string | undefined;
		// A single retry after a short pause on a network/HTTP failure — same
		// reasoning as importDecklistToList above.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const { cards: results } = await searchScryfall(
					line.name,
					line.setCode ?? "",
					line.collectorNumber ?? ""
				);
				scryfallId = results[0]?.id;
				break;
			} catch {
				if (attempt === 0) await sleep(300);
			}
		}
		resolvedLines.push({ line, scryfallId });
	}

	const resolved = resolvedLines.filter((r) => r.scryfallId);
	const unresolved = [
		...unparsedLines,
		...resolvedLines.filter((r) => !r.scryfallId).map((r) => r.line.raw),
	];

	const uniqueIds = Array.from(new Set(resolved.map((r) => r.scryfallId!)));
	const enrichMap = await fetchScryfallCollection(uniqueIds, onProgress);

	let added = 0;
	let updated = 0;
	resolved.forEach(({ line, scryfallId }) => {
		const scry = enrichMap.get(scryfallId!);
		if (!scry) return;
		const existing = this.settings.wantlist.find(
			(c) => c.scryfallId === scry.id && c.listId === wantlistId && c.finish === "regular"
		);
		if (existing) {
			existing.count += line.quantity;
			existing.dateModified = Date.now();
			existing.imageUrl = getImageUrl(scry) || existing.imageUrl;
			existing.priceUsd = scry.prices?.usd ?? existing.priceUsd;
			existing.priceUsdFoil = scry.prices?.usd_foil ?? existing.priceUsdFoil;
			existing.priceEur = scry.prices?.eur ?? existing.priceEur;
			existing.priceEurFoil = scry.prices?.eur_foil ?? existing.priceEurFoil;
			existing.priceUsdEtched = scry.prices?.usd_etched ?? existing.priceUsdEtched;
			existing.priceEurEtched = scry.prices?.eur_etched ?? existing.priceEurEtched;
			updated++;
			this.recentlyAddedWantlistCardIds.add(existing.id);
		} else {
			const now = Date.now();
			const newId = genId();
			this.settings.wantlist.push({
				id: newId,
				scryfallId: scry.id,
				name: scry.name,
				setCode: scry.set,
				setName: scry.set_name,
				collectorNumber: scry.collector_number,
				rarity: scry.rarity,
				manaCost: scry.mana_cost ?? "",
				manaValue: scry.cmc ?? 0,
				typeLine: scry.type_line,
				artist: scry.artist ?? "",
				colors: scry.colors ?? [],
				keywords: scry.keywords ?? [],
				releasedAt: scry.released_at ?? "",
				imageUrl: getImageUrl(scry),
				artCropUrl: getArtCropUrl(scry),
				priceUsd: scry.prices?.usd ?? "",
				priceUsdFoil: scry.prices?.usd_foil ?? "",
				priceEur: scry.prices?.eur ?? "",
				priceEurFoil: scry.prices?.eur_foil ?? "",
				priceUsdEtched: scry.prices?.usd_etched ?? "",
				priceEurEtched: scry.prices?.eur_etched ?? "",
				count: line.quantity,
				finish: "regular",
				listId: wantlistId,
				dateAdded: now,
				dateModified: now,
				borderColor: scry.border_color ?? "",
				frame: scry.frame ?? "",
				frameEffects: scry.frame_effects ?? [],
				oracleText: buildCardTextInfo(scry).oracleText,
			});
			added++;
			this.recentlyAddedWantlistCardIds.add(newId);
		}
	});

	await this.saveSettings();
	return { added, updated, unresolved };
}


export async function importCsv(this: MTGCollectionPlugin, 
	text: string,
	onProgress: (msg: string) => void,
	targetListId?: string
): Promise<{ added: number; updated: number; skipped: number }> {
	const rows = parseCsv(text);
	if (rows.length < 2) throw new Error("Empty or invalid CSV file.");

	const header = rows[0].map((h) => h.trim().toLowerCase());
	const idx = (names: string[]) => {
		for (const n of names) {
			const i = header.indexOf(n.toLowerCase());
			if (i !== -1) return i;
		}
		return -1;
	};

	const qtyIdx = idx(["quantity", "count"]);
	const nameIdx = idx(["card name", "name"]);
	const setCodeIdx = idx(["set code", "setcode"]);
	const setNameIdx = idx(["set", "set name", "edition"]);
	const numberIdx = idx(["number", "collector number", "collectornumber"]);
	const finishIdx = idx(["finish"]);
	const legacyFoilIdx = idx(["foil/etched", "foil"]);
	const languageIdx = idx(["language", "lang"]);
	const conditionIdx = idx(["condition"]);
	const scryfallIdIdx = idx(["scryfall id", "scryfallid"]);
	const rarityIdx = idx(["rarity"]);
	const typeLineIdx = idx(["type line", "typeline"]);
	const manaCostIdx = idx(["mana cost", "manacost"]);
	const gradingCompanyIdx = idx(["grading company", "graded by", "gradingcompany"]);
	const gradingGradeIdx = idx(["grade", "grading grade", "gradinggrade"]);
	const gradingLabelIdx = idx(["grading label", "gradinglabel"]);
	const customPriceIdx = idx(["custom price", "customprice"]);

	if (nameIdx === -1) {
		throw new Error(
			"CSV must have a 'Card Name' or 'Name' column. Columns found: " +
				rows[0].join(", ")
		);
	}

	interface PendingRow {
		scryfallId?: string;
		name: string;
		setCode: string;
		setName: string;
		number: string;
		rarity: string;
		typeLine: string;
		manaCost: string;
		qty: number;
		finish: Finish;
		language: string;
		condition: string;
		gradingCompany?: GradingCompany;
		gradingGrade?: number;
		gradingLabel?: string;
		customPrice?: string;
	}

	const pending: PendingRow[] = [];
	for (let r = 1; r < rows.length; r++) {
		const row = rows[r];
		const name = nameIdx !== -1 ? row[nameIdx]?.trim() : "";
		if (!name) continue;
		// Math.max(1, ...): same clamp as changeCollectionCardCount/setCollectionCardCount elsewhere
		// in this file — without it, a negative or zero value in the Quantity column (typo, malformed
		// third-party export) silently created an entry with a negative/zero count, skewing list
		// totals, the collection's value and the sort by price.
		const qty = qtyIdx !== -1 ? Math.max(1, parseInt(row[qtyIdx], 10) || 1) : 1;
		const finishRaw = finishIdx !== -1 ? row[finishIdx] : legacyFoilIdx !== -1 ? row[legacyFoilIdx] : "";
		const langRaw = languageIdx !== -1 ? row[languageIdx]?.trim().toLowerCase() : "";
		const gradingCompanyRaw = gradingCompanyIdx !== -1 ? row[gradingCompanyIdx]?.trim() : "";
		const gradingCompany = GRADING_COMPANY_OPTIONS.some((g) => g.value === gradingCompanyRaw)
			? (gradingCompanyRaw as GradingCompany)
			: undefined;
		const gradingGradeRaw = gradingGradeIdx !== -1 ? row[gradingGradeIdx]?.trim() : "";
		const gradingGrade =
			gradingGradeRaw && !Number.isNaN(parseFloat(gradingGradeRaw))
				? parseFloat(gradingGradeRaw)
				: undefined;
		const gradingLabel = gradingLabelIdx !== -1 ? row[gradingLabelIdx]?.trim() : "";
		const customPrice = customPriceIdx !== -1 ? row[customPriceIdx]?.trim() : "";
		pending.push({
			scryfallId:
				scryfallIdIdx !== -1 ? row[scryfallIdIdx]?.trim() : undefined,
			name,
			setCode: setCodeIdx !== -1 ? row[setCodeIdx]?.trim() : "",
			setName: setNameIdx !== -1 ? row[setNameIdx]?.trim() : "",
			number: numberIdx !== -1 ? row[numberIdx]?.trim() : "",
			rarity: rarityIdx !== -1 ? row[rarityIdx]?.trim() : "",
			typeLine: typeLineIdx !== -1 ? row[typeLineIdx]?.trim() : "",
			manaCost: manaCostIdx !== -1 ? row[manaCostIdx]?.trim() : "",
			qty,
			finish: parseFinishValue(finishRaw),
			// A missing/empty Language column (langRaw === "") or an unrecognized
			// imported value (e.g. "Klingon") both end up at the same "" fallback (no
			// language chosen, see getLanguage/types.ts) rather than an arbitrary
			// English.
			language: LANGUAGES.some((l) => l.code === langRaw) ? langRaw : "",
			condition: conditionIdx !== -1 ? row[conditionIdx]?.trim() : "",
			gradingCompany,
			gradingGrade,
			gradingLabel,
			customPrice,
		});
	}

	onProgress(`Parsed ${pending.length} rows…`);

	// Lines without a Scryfall Id (generic CSV format) are resolved one by one
	// via the classic search, with a small pause to stay reasonable toward the
	// Scryfall API.
	const toResolve = pending.filter((r) => !r.scryfallId);
	for (let i = 0; i < toResolve.length; i++) {
		const row = toResolve[i];
		onProgress(`Resolving ${row.name} (${i + 1}/${toResolve.length})…`);
		// A single retry after a short pause on a NETWORK/HTTP failure — same
		// fix/reasoning as importDecklistToDeck further down (see its own comment
		// for the real bug that motivated it, on a decklist import, but exactly
		// the same latent flaw here: searchScryfall only throws on a real
		// transient network/HTTP failure, never on a confirmed "no card found" —
		// cards: [] — so nothing to lose by retrying once here).
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const { cards: results } = await searchScryfall(row.name, row.setCode, row.number);
				if (results.length > 0) row.scryfallId = results[0].id;
				break;
			} catch {
				if (attempt === 0) await sleep(300);
				// otherwise unresolved card, it will be counted as "skipped"
			}
		}
		await new Promise((res) => window.setTimeout(res, 100));
	}

	const resolved = pending.filter((r) => r.scryfallId);
	const skipped = pending.length - resolved.length;

	const uniqueIds = Array.from(new Set(resolved.map((r) => r.scryfallId!)));
	const enrichMap = await fetchScryfallCollection(uniqueIds, onProgress);

	let added = 0;
	let updated = 0;

	resolved.forEach((row) => {
		const id = row.scryfallId!;
		const scry = enrichMap.get(id);
		const setName = scry?.set_name ?? row.setName ?? row.setCode ?? "Imported";
		const listId = targetListId ?? this.getOrCreateListByName(setName).id;
		const existing = this.settings.collection.find(
			(c) =>
				c.scryfallId === id &&
				c.listId === listId &&
				c.finish === row.finish &&
				c.language === row.language &&
				c.condition === row.condition
		);
		if (existing) {
			existing.count += row.qty;
			existing.dateModified = Date.now();
			if (scry) {
				existing.imageUrl = getImageUrl(scry) || existing.imageUrl;
				existing.priceUsd = scry.prices?.usd ?? existing.priceUsd;
				existing.priceUsdFoil = scry.prices?.usd_foil ?? existing.priceUsdFoil;
				existing.priceEur = scry.prices?.eur ?? existing.priceEur;
				existing.priceEurFoil = scry.prices?.eur_foil ?? existing.priceEurFoil;
				existing.priceUsdEtched = scry.prices?.usd_etched ?? existing.priceUsdEtched;
				existing.priceEurEtched = scry.prices?.eur_etched ?? existing.priceEurEtched;
			}
			updated++;
			this.recentlyAddedCollectionCardIds.add(existing.id);
		} else {
			const now = Date.now();
			const newId = genId();
			this.settings.collection.push({
				id: newId,
				scryfallId: id,
				name: scry?.name ?? row.name,
				setCode: (scry?.set ?? row.setCode).toLowerCase(),
				setName,
				collectorNumber: scry?.collector_number ?? row.number,
				rarity: scry?.rarity ?? row.rarity,
				manaCost: scry?.mana_cost ?? row.manaCost,
				manaValue: scry?.cmc ?? 0,
				typeLine: scry?.type_line ?? row.typeLine,
				artist: scry?.artist ?? "",
				colors: scry?.colors ?? [],
				keywords: scry?.keywords ?? [],
				releasedAt: scry?.released_at ?? "",
				imageUrl: scry ? getImageUrl(scry) : "",
				artCropUrl: scry ? getArtCropUrl(scry) : "",
				priceUsd: scry?.prices?.usd ?? "",
				priceUsdFoil: scry?.prices?.usd_foil ?? "",
				priceEur: scry?.prices?.eur ?? "",
				priceEurFoil: scry?.prices?.eur_foil ?? "",
				priceUsdEtched: scry?.prices?.usd_etched ?? "",
				priceEurEtched: scry?.prices?.eur_etched ?? "",
				count: row.qty,
				finish: row.finish,
				language: row.language,
				condition: row.condition,
				gradingCompany: row.gradingCompany,
				gradingGrade: row.gradingGrade,
				gradingLabel: row.gradingLabel,
				customPrice: row.customPrice,
				listId,
				dateAdded: now,
				dateModified: now,
				borderColor: scry?.border_color ?? "",
				frame: scry?.frame ?? "",
				frameEffects: scry?.frame_effects ?? [],
				oracleText: scry ? buildCardTextInfo(scry).oracleText : "",
			});
			added++;
			this.recentlyAddedCollectionCardIds.add(newId);
		}
	});

	await this.saveSettings();
	return { added, updated, skipped };
}

// Same logic as importCsv, without condition/language: a wantlist card
// isn't owned yet, so these columns (if present in the CSV) are simply
// ignored.

export async function importWantlistCsv(this: MTGCollectionPlugin, 
	text: string,
	onProgress: (msg: string) => void,
	targetWantlistId?: string
): Promise<{ added: number; updated: number; skipped: number }> {
	const rows = parseCsv(text);
	if (rows.length < 2) throw new Error("Empty or invalid CSV file.");

	const header = rows[0].map((h) => h.trim().toLowerCase());
	const idx = (names: string[]) => {
		for (const n of names) {
			const i = header.indexOf(n.toLowerCase());
			if (i !== -1) return i;
		}
		return -1;
	};

	const qtyIdx = idx(["quantity", "count"]);
	const nameIdx = idx(["card name", "name"]);
	const setCodeIdx = idx(["set code", "setcode"]);
	const setNameIdx = idx(["set", "set name", "edition"]);
	const numberIdx = idx(["number", "collector number", "collectornumber"]);
	const finishIdx = idx(["finish"]);
	const legacyFoilIdx = idx(["foil/etched", "foil"]);
	const scryfallIdIdx = idx(["scryfall id", "scryfallid"]);
	const rarityIdx = idx(["rarity"]);
	const typeLineIdx = idx(["type line", "typeline"]);
	const manaCostIdx = idx(["mana cost", "manacost"]);

	if (nameIdx === -1) {
		throw new Error(
			"CSV must have a 'Card Name' or 'Name' column. Columns found: " +
				rows[0].join(", ")
		);
	}

	interface PendingWantlistRow {
		scryfallId?: string;
		name: string;
		setCode: string;
		setName: string;
		number: string;
		rarity: string;
		typeLine: string;
		manaCost: string;
		qty: number;
		finish: Finish;
	}

	const pending: PendingWantlistRow[] = [];
	for (let r = 1; r < rows.length; r++) {
		const row = rows[r];
		const name = nameIdx !== -1 ? row[nameIdx]?.trim() : "";
		if (!name) continue;
		// Math.max(1, ...): same clamp as changeCollectionCardCount/setCollectionCardCount elsewhere
		// in this file — without it, a negative or zero value in the Quantity column (typo, malformed
		// third-party export) silently created an entry with a negative/zero count, skewing list
		// totals, the collection's value and the sort by price.
		const qty = qtyIdx !== -1 ? Math.max(1, parseInt(row[qtyIdx], 10) || 1) : 1;
		const finishRaw = finishIdx !== -1 ? row[finishIdx] : legacyFoilIdx !== -1 ? row[legacyFoilIdx] : "";
		pending.push({
			scryfallId:
				scryfallIdIdx !== -1 ? row[scryfallIdIdx]?.trim() : undefined,
			name,
			setCode: setCodeIdx !== -1 ? row[setCodeIdx]?.trim() : "",
			setName: setNameIdx !== -1 ? row[setNameIdx]?.trim() : "",
			number: numberIdx !== -1 ? row[numberIdx]?.trim() : "",
			rarity: rarityIdx !== -1 ? row[rarityIdx]?.trim() : "",
			typeLine: typeLineIdx !== -1 ? row[typeLineIdx]?.trim() : "",
			manaCost: manaCostIdx !== -1 ? row[manaCostIdx]?.trim() : "",
			qty,
			finish: parseFinishValue(finishRaw),
		});
	}

	onProgress(`Parsed ${pending.length} rows…`);

	// Same fix as importCsv above (a single retry after a short pause on a
	// transient network/HTTP failure) — see its own comment.
	const toResolve = pending.filter((r) => !r.scryfallId);
	for (let i = 0; i < toResolve.length; i++) {
		const row = toResolve[i];
		onProgress(`Resolving ${row.name} (${i + 1}/${toResolve.length})…`);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const { cards: results } = await searchScryfall(row.name, row.setCode, row.number);
				if (results.length > 0) row.scryfallId = results[0].id;
				break;
			} catch {
				if (attempt === 0) await sleep(300);
				// otherwise unresolved card, it will be counted as "skipped"
			}
		}
		await new Promise((res) => window.setTimeout(res, 100));
	}

	const resolved = pending.filter((r) => r.scryfallId);
	const skipped = pending.length - resolved.length;

	const uniqueIds = Array.from(new Set(resolved.map((r) => r.scryfallId!)));
	const enrichMap = await fetchScryfallCollection(uniqueIds, onProgress);

	let added = 0;
	let updated = 0;

	resolved.forEach((row) => {
		const id = row.scryfallId!;
		const scry = enrichMap.get(id);
		const setName = scry?.set_name ?? row.setName ?? row.setCode ?? "Imported";
		const wantlistId = targetWantlistId ?? this.getOrCreateWantlistByName(setName).id;
		const existing = this.settings.wantlist.find(
			(c) => c.scryfallId === id && c.listId === wantlistId && c.finish === row.finish
		);
		if (existing) {
			existing.count += row.qty;
			existing.dateModified = Date.now();
			if (scry) {
				existing.imageUrl = getImageUrl(scry) || existing.imageUrl;
				existing.priceUsd = scry.prices?.usd ?? existing.priceUsd;
				existing.priceUsdFoil = scry.prices?.usd_foil ?? existing.priceUsdFoil;
				existing.priceEur = scry.prices?.eur ?? existing.priceEur;
				existing.priceEurFoil = scry.prices?.eur_foil ?? existing.priceEurFoil;
				existing.priceUsdEtched = scry.prices?.usd_etched ?? existing.priceUsdEtched;
				existing.priceEurEtched = scry.prices?.eur_etched ?? existing.priceEurEtched;
			}
			updated++;
			this.recentlyAddedWantlistCardIds.add(existing.id);
		} else {
			const now = Date.now();
			const newId = genId();
			this.settings.wantlist.push({
				id: newId,
				scryfallId: id,
				name: scry?.name ?? row.name,
				setCode: (scry?.set ?? row.setCode).toLowerCase(),
				setName,
				collectorNumber: scry?.collector_number ?? row.number,
				rarity: scry?.rarity ?? row.rarity,
				manaCost: scry?.mana_cost ?? row.manaCost,
				manaValue: scry?.cmc ?? 0,
				typeLine: scry?.type_line ?? row.typeLine,
				artist: scry?.artist ?? "",
				colors: scry?.colors ?? [],
				keywords: scry?.keywords ?? [],
				releasedAt: scry?.released_at ?? "",
				imageUrl: scry ? getImageUrl(scry) : "",
				artCropUrl: scry ? getArtCropUrl(scry) : "",
				priceUsd: scry?.prices?.usd ?? "",
				priceUsdFoil: scry?.prices?.usd_foil ?? "",
				priceEur: scry?.prices?.eur ?? "",
				priceEurFoil: scry?.prices?.eur_foil ?? "",
				priceUsdEtched: scry?.prices?.usd_etched ?? "",
				priceEurEtched: scry?.prices?.eur_etched ?? "",
				count: row.qty,
				finish: row.finish,
				listId: wantlistId,
				dateAdded: now,
				dateModified: now,
				borderColor: scry?.border_color ?? "",
				frame: scry?.frame ?? "",
				frameEffects: scry?.frame_effects ?? [],
				oracleText: scry ? buildCardTextInfo(scry).oracleText : "",
			});
			added++;
			this.recentlyAddedWantlistCardIds.add(newId);
		}
	});

	await this.saveSettings();
	return { added, updated, skipped };
}

/* ------------------------- Saved search filters ------------------------ */

// "Save filter" (Add cards, add-cards-modal.ts) — captures the current
// state of the chip bar (+ active sort if any) under a name chosen by the
// user, to find it again later in the list of suggestions without having to
// retype it. `tokens` is copied (not the chipTokens reference): that array
// is mutated in place by the modal on every interaction (chip
// added/removed), a saved snapshot must not keep moving with it afterwards.

export function saveSearchFilter(this: MTGCollectionPlugin, 
	label: string,
	tokens: string[],
	sortOverride: { order: string; dir: "asc" | "desc" } | null
): SavedSearchFilter {
	const filter: SavedSearchFilter = { id: genId(), label, tokens: [...tokens], sortOverride };
	this.settings.savedSearchFilters.push(filter);
	void this.saveSettings();
	return filter;
}


export function deleteSearchFilter(this: MTGCollectionPlugin, id: string) {
	this.settings.savedSearchFilters = this.settings.savedSearchFilters.filter((f) => f.id !== id);
	void this.saveSettings();
}
