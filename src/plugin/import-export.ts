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
		// "mainboard" reste absent plutôt que persisté explicitement — voir
		// DeckCard.category (data-model.ts), le cas de très loin le plus
		// courant.
		const category: DeckCardCategory | undefined =
			line.category === "mainboard" ? undefined : line.category;
		// Fusionne uniquement avec une entrée déjà présente pour la MÊME
		// catégorie ET le même statut Commander — une carte peut
		// légitimement apparaître à la fois comme Commander et comme carte
		// du deck principal (les Backgrounds, par exemple, ou simplement 2
		// copies d'un même Commander de partenaire comptées séparément),
		// fusionner les deux compterait à tort les deux rôles ensemble.
		// Category seule ne suffit plus à les distinguer depuis que
		// Commander est devenu une Function plutôt qu'une 4e catégorie
		// (les deux valent désormais "mainboard") — d'où ce 2e critère.
		const existing = deck.cards.find(
			(c) =>
				c.scryfallId === scry.id &&
				getDeckCardCategory(c) === (category ?? "mainboard") &&
				isDeckCommander(c) === line.isCommander
		);
		if (existing) {
			existing.count += line.quantity;
			existing.dateModified = Date.now();
			// Une ligne Commander qui fusionne dans une entrée déjà taguée
			// Commander n'a rien de plus à faire ici (deckFunctionOverride
			// déjà posé) — pas de branche séparée nécessaire, contrairement à
			// category, qui n'a jamais eu besoin d'être réécrit sur un merge
			// non plus.
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
				// "Commander" (voir isDeckCommander/DECK_FUNCTION_CATEGORIES,
				// data-model.ts/deck-function.ts) — jamais posé pour une ligne
				// mainboard/sideboard/maybeboard ordinaire, laissé absent
				// plutôt que persisté explicitement, même repli que category
				// ci-dessus.
				deckFunctionOverride: line.isCommander ? "Commander" : undefined,
			});
		}
		added++;
	});

	await this.saveSettings();
	return { added, unresolved };
}

// Import CSV pour UN SEUL deck (DeckSettingsModal, "Import" → "Import CSV",
// harmonisé sur ListSettingsModal) — jusqu'ici un deck n'avait aucun chemin
// d'import CSV (voir "Data model notes" dans CLAUDE.md, "deck CSV reste
// export-only"), seul l'import de decklist ci-dessus existait. Même
// mécanique qu'importCsv plus bas (résolution Scryfall des lignes sans
// Scryfall Id, une seule retentative après une courte pause, un seul
// fetchScryfallCollection groupé), même en-tête de colonnes que
// buildDeckCsvString (view.ts) — mais retrouve une ligne existante par
// scryfallId + catégorie (même clé d'identité que mergeDeckDuplicates/
// changeDeckCardPrinting, deck-mutations.ts, et l'import de decklist ci-dessus, même fichier), pas par
// listId+finish+langue+condition comme importCsv. Aucune colonne
// "Category"/board dans ce format CSV — chaque ligne importée devient une
// entrée mainboard (même repli que toute carte ajoutée hors import de
// decklist, voir DeckCardCategory). La branche "ligne déjà présente" ne
// touche PAS finish/language/condition d'une entrée existante — même
// convention déjà établie pour importCsv (un merge ne rafraîchit que les
// champs sourcés de Scryfall + count, jamais ces trois-là).

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
				// Même geste que importCsv (My Collection) — un merge rafraîchit
				// le prix (pas immuable, contrairement à border/frame/oracleText,
				// jamais touchés au merge), sans écraser finish/language/
				// condition existants (voir le commentaire de cette méthode).
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

// Import de decklist externe (Moxfield/Archidekt/texte brut, "Import TXT"
// de ListSettingsModal) directement dans une liste de My Collection — même
// mécanique qu'importDecklistToDeck juste au-dessus (parseDecklistText,
// résolution ligne par ligne via searchScryfall, enrichissement groupé via
// fetchScryfallCollection), mais fusionne/crée des CollectionCard (settings.
// collection) plutôt que des DeckCard, avec le même jeu de champs que la
// branche "nouvelle ligne" d'importCsv plus bas (même source de données —
// un ScryfallCard résolu — donc même forme). line.category/isCommander
// sont ignorés ici : ce découpage n'a de sens que pour un deck, une liste
// de collection n'a pas cette notion — chaque ligne devient une carte
// "normale" de la liste. finish/language/condition
// n'existent pas dans un fichier texte : mêmes replis qu'importCsv quand
// ces colonnes sont absentes du CSV ("regular"/""/"").

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
		// Une seule retentative après une courte pause sur un échec réseau/
		// HTTP — même raisonnement qu'importDecklistToDeck ci-dessus.
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

// Import de decklist externe (Moxfield/Archidekt/texte brut, "Import TXT"
// de WantlistSettingsModal) directement dans une wantlist — même mécanique
// qu'importDecklistToList juste au-dessus, mais fusionne/crée des
// WantlistCard (settings.wantlist) plutôt que des CollectionCard, sans
// langue/condition (WantlistCard n'a ni l'un ni l'autre — voir "Data
// model notes" dans CLAUDE.md), donc une clé de fusion scryfallId+listId+
// finish plutôt que +langue+condition comme importDecklistToList.
// line.category/isCommander sont ignorés ici pour la même raison que côté
// liste : pas de notion de "board" pour une wantlist.

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
		// Une seule retentative après une courte pause sur un échec réseau/
		// HTTP — même raisonnement qu'importDecklistToList ci-dessus.
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
		// Math.max(1, ...) : même clamp que changeCollectionCardCount/setCollectionCardCount ailleurs
		// dans ce fichier — sans lui, une valeur négative ou à zéro dans la
		// colonne Quantity (faute de frappe, export tiers malformé) créait
		// silencieusement une entrée à count négatif/nul, faussant les totaux
		// de liste, la valeur de collection et le tri par prix.
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
			// Colonne Language absente/vide (langRaw === "") ou valeur importée
			// non reconnue (ex. "Klingon") aboutissent toutes les deux au même
			// repli "" (aucune langue choisie, voir getLanguage/types.ts) plutôt
			// qu'un English arbitraire.
			language: LANGUAGES.some((l) => l.code === langRaw) ? langRaw : "",
			condition: conditionIdx !== -1 ? row[conditionIdx]?.trim() : "",
			gradingCompany,
			gradingGrade,
			gradingLabel,
			customPrice,
		});
	}

	onProgress(`Parsed ${pending.length} rows…`);

	// Les lignes sans Scryfall Id (format CSV générique) sont résolues une par
	// une via la recherche classique, avec une petite pause pour rester
	// raisonnable vis-à-vis de l'API Scryfall.
	const toResolve = pending.filter((r) => !r.scryfallId);
	for (let i = 0; i < toResolve.length; i++) {
		const row = toResolve[i];
		onProgress(`Resolving ${row.name} (${i + 1}/${toResolve.length})…`);
		// Une seule retentative après une courte pause sur un échec RÉSEAU/
		// HTTP — même correctif/raisonnement qu'importDecklistToDeck plus bas
		// (voir son propre commentaire pour le bug réel qui l'a motivé, sur
		// un import de decklist, mais exactement la même faille latente ici :
		// searchScryfall ne lève une exception QUE sur un vrai échec réseau/
		// HTTP transitoire, jamais sur un "aucune carte trouvée" confirmé
		// — cards: [] — donc rien à perdre à retenter une fois ici).
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const { cards: results } = await searchScryfall(row.name, row.setCode, row.number);
				if (results.length > 0) row.scryfallId = results[0].id;
				break;
			} catch {
				if (attempt === 0) await sleep(300);
				// sinon carte non résolue, elle sera comptée comme "skipped"
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

// Même logique qu'importCsv, sans condition/langue : une carte de
// wantlist n'est pas encore possédée, donc ces colonnes (si présentes
// dans le CSV) sont simplement ignorées.

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
		// Math.max(1, ...) : même clamp que changeCollectionCardCount/setCollectionCardCount ailleurs
		// dans ce fichier — sans lui, une valeur négative ou à zéro dans la
		// colonne Quantity (faute de frappe, export tiers malformé) créait
		// silencieusement une entrée à count négatif/nul, faussant les totaux
		// de liste, la valeur de collection et le tri par prix.
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

	// Même correctif qu'importCsv ci-dessus (retentative unique après une
	// courte pause sur un échec réseau/HTTP transitoire) — voir son propre
	// commentaire.
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
				// sinon carte non résolue, elle sera comptée comme "skipped"
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

// "Save filter" (Add cards, add-cards-modal.ts) — capture l'état courant de
// la barre de puces (+ tri actif le cas échéant) sous un nom choisi par
// l'utilisateur, pour la retrouver ensuite dans la liste de suggestions
// sans avoir à la retaper. `tokens` est copié (pas la référence de
// chipTokens) : ce tableau est muté en place par la modale à chaque
// interaction (ajout/retrait de puce), un instantané enregistré ne doit
// pas continuer à bouger avec lui après coup.

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
