import {
	Finish,
	WantlistCard,
} from "../core/card-model";
import {
	ScryfallCard,
	getImageUrl,
	getArtCropUrl,
	buildCardTextInfo,
} from "../api/scryfall";
import {
	Wantlist,
	genId,
	ListIcon,
} from "../core/data-model";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  My Wantlists: card + wantlist mutations. Split out of plugin.ts on
    2026-09-10.  */
/* -------------------------------------------------------------------------- */

export function getOrCreateWantlistByName(this: MTGCollectionPlugin, name: string): Wantlist {
	const existing = this.settings.wantlists.find((w) => w.name === name);
	if (existing) return existing;
	return this.createWantlistSilent(name || "Unsorted");
}

export function changeWantlistCardPrinting(this: MTGCollectionPlugin, rowId: string, scry: ScryfallCard) {
	const card = this.settings.wantlist.find((c) => c.id === rowId);
	if (!card) return;
	card.scryfallId = scry.id;
	card.name = scry.name;
	card.setCode = scry.set;
	card.setName = scry.set_name;
	card.collectorNumber = scry.collector_number;
	card.rarity = scry.rarity;
	card.manaCost = scry.mana_cost ?? "";
	card.manaValue = scry.cmc ?? 0;
	card.typeLine = scry.type_line;
	card.artist = scry.artist ?? "";
	card.colors = scry.colors ?? [];
	card.keywords = scry.keywords ?? [];
	card.releasedAt = scry.released_at ?? "";
	card.imageUrl = getImageUrl(scry);
	card.artCropUrl = getArtCropUrl(scry);
	card.priceUsd = scry.prices?.usd ?? "";
	card.priceUsdFoil = scry.prices?.usd_foil ?? "";
	card.priceEur = scry.prices?.eur ?? "";
	card.priceEurFoil = scry.prices?.eur_foil ?? "";
	card.priceUsdEtched = scry.prices?.usd_etched ?? "";
	card.priceEurEtched = scry.prices?.eur_etched ?? "";
	card.borderColor = scry.border_color ?? "";
	card.frame = scry.frame ?? "";
	card.frameEffects = scry.frame_effects ?? [];
	card.oracleText = buildCardTextInfo(scry).oracleText;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// Returns the resulting entry (existing or newly created) — used by
// AddCardsModal to turn its "Add" button into a +/- stepper right after
// the addition, without having to find the entry separately.

export function addCardToWantlist(this: MTGCollectionPlugin, card: ScryfallCard, wantlistId: string, options: { finish: Finish }): WantlistCard {
	const existing = this.settings.wantlist.find(
		(c) => c.scryfallId === card.id && c.listId === wantlistId && c.finish === options.finish
	);
	if (existing) {
		existing.count += 1;
		existing.dateModified = Date.now();
		this.recentlyAddedWantlistCardIds.add(existing.id);
		void this.saveSettings();
		return existing;
	} else {
		const now = Date.now();
		const newId = genId();
		const entry: WantlistCard = {
			id: newId,
			scryfallId: card.id,
			name: card.name,
			setCode: card.set,
			setName: card.set_name,
			collectorNumber: card.collector_number,
			rarity: card.rarity,
			manaCost: card.mana_cost ?? "",
			manaValue: card.cmc ?? 0,
			typeLine: card.type_line,
			artist: card.artist ?? "",
			colors: card.colors ?? [],
			keywords: card.keywords ?? [],
			releasedAt: card.released_at ?? "",
			imageUrl: getImageUrl(card),
			artCropUrl: getArtCropUrl(card),
			priceUsd: card.prices?.usd ?? "",
			priceUsdFoil: card.prices?.usd_foil ?? "",
			priceEur: card.prices?.eur ?? "",
			priceEurFoil: card.prices?.eur_foil ?? "",
			priceUsdEtched: card.prices?.usd_etched ?? "",
			priceEurEtched: card.prices?.eur_etched ?? "",
			count: 1,
			finish: options.finish,
			listId: wantlistId,
			dateAdded: now,
			dateModified: now,
			borderColor: card.border_color ?? "",
			frame: card.frame ?? "",
			frameEffects: card.frame_effects ?? [],
			oracleText: buildCardTextInfo(card).oracleText,
		};
		this.settings.wantlist.push(entry);
		this.recentlyAddedWantlistCardIds.add(newId);
		void this.saveSettings();
		return entry;
	}
}


export function changeWantlistCardCount(this: MTGCollectionPlugin, rowId: string, delta: number, onDone: () => void) {
	const card = this.settings.wantlist.find((c) => c.id === rowId);
	if (!card) return;
	card.count = Math.max(1, card.count + delta);
	card.dateModified = Date.now();
	void this.saveSettings();
	onDone();
}


export function setWantlistCardCount(this: MTGCollectionPlugin, rowId: string, newCount: number, onDone: () => void) {
	const card = this.settings.wantlist.find((c) => c.id === rowId);
	if (!card) return;
	card.count = Math.max(1, Math.floor(newCount) || 1);
	card.dateModified = Date.now();
	void this.saveSettings();
	onDone();
}


export function removeWantlistCard(this: MTGCollectionPlugin, rowId: string) {
	this.settings.wantlist = this.settings.wantlist.filter((c) => c.id !== rowId);
	void this.saveSettings();
}

// See undoAddToCollection (collection-mutations.ts) — same reasoning, on the wantlist
// side. addCardToWantlist only deduplicates by scryfallId + listId + finish (not
// language/condition, a wantlist item never has either), so this key is shorter than its
// collection counterpart.

export function undoAddToWantlist(this: MTGCollectionPlugin, 
	scryfallId: string,
	wantlistId: string,
	finish: Finish,
	delta: number
): WantlistCard | undefined {
	const row = this.settings.wantlist.find(
		(c) => c.scryfallId === scryfallId && c.listId === wantlistId && c.finish === finish
	);
	if (!row) return undefined;
	if (row.count - delta <= 0) {
		this.removeWantlistCard(row.id);
		return undefined;
	}
	row.count -= delta;
	row.dateModified = Date.now();
	void this.saveSettings();
	return row;
}


export function setWantlistCardFinish(this: MTGCollectionPlugin, rowId: string, finish: Finish) {
	const card = this.settings.wantlist.find((c) => c.id === rowId);
	if (!card) return;
	card.finish = finish;
	card.dateModified = Date.now();
	void this.saveSettings();
}


export function createWantlist(this: MTGCollectionPlugin, name: string): Wantlist {
	const wantlist: Wantlist = { id: genId(), name, dateCreated: Date.now() };
	this.settings.wantlists.push(wantlist);
	void this.saveSettings();
	return wantlist;
}


export function createWantlistSilent(this: MTGCollectionPlugin, name: string): Wantlist {
	const wantlist: Wantlist = { id: genId(), name, dateCreated: Date.now() };
	this.settings.wantlists.push(wantlist);
	return wantlist;
}


export function deleteWantlist(this: MTGCollectionPlugin, wantlistId: string) {
	this.settings.wantlists = this.settings.wantlists.filter((w) => w.id !== wantlistId);
	this.settings.wantlist = this.settings.wantlist.filter((c) => c.listId !== wantlistId);
	void this.saveSettings();
}

// Empties a wantlist (removes all its cards) without deleting it — same
// distinction/same reasoning as clearList on the collection side
// (WantlistSettingsModal, "Clear wantlist").

export function clearWantlist(this: MTGCollectionPlugin, wantlistId: string) {
	this.settings.wantlist = this.settings.wantlist.filter((c) => c.listId !== wantlistId);
	void this.saveSettings();
}

// Same principle as setListCoverCard (collection-mutations.ts), on the wantlist side
// — see Wantlist.coverCardId/resolveCoverImage (core/price.ts).

export function setWantlistCoverCard(this: MTGCollectionPlugin, wantlistId: string, cardId: string | undefined) {
	const wantlist = this.settings.wantlists.find((w) => w.id === wantlistId);
	if (!wantlist) return;
	wantlist.coverCardId = cardId;
	void this.saveSettings();
}

// Same principle as setListIcon (collection-mutations.ts), on the wantlist side
// — see Wantlist.listIcon (core/data-model.ts).

export function setWantlistIcon(this: MTGCollectionPlugin, wantlistId: string, icon: ListIcon | undefined) {
	const wantlist = this.settings.wantlists.find((w) => w.id === wantlistId);
	if (!wantlist) return;
	wantlist.listIcon = icon;
	void this.saveSettings();
}

// Grouped version of deleteWantlist above — see bulkDeleteLists.

export function bulkDeleteWantlists(this: MTGCollectionPlugin, wantlistIds: string[]) {
	const idSet = new Set(wantlistIds);
	this.settings.wantlists = this.settings.wantlists.filter((w) => !idSet.has(w.id));
	this.settings.wantlist = this.settings.wantlist.filter((c) => !idSet.has(c.listId));
	void this.saveSettings();
}

// Equivalent of findListDuplicateGroups/mergeListDuplicateGroup (see
// collection-mutations.ts) for wantlists — no dedicated "Merge duplicate cards"
// feature exists here, so written directly rather than reused. Deduplication key
// without language/condition: WantlistCard has neither (a card not yet owned has no
// physical copy to grade/classify), same asymmetry already established elsewhere in
// this file.

export function findWantlistDuplicateGroups(this: MTGCollectionPlugin): WantlistCard[][] {
	const groups = new Map<string, WantlistCard[]>();
	this.settings.wantlist.forEach((c) => {
		const key = `${c.scryfallId}|${c.listId}|${c.finish}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(c);
	});
	return Array.from(groups.values())
		.filter((g) => g.length > 1)
		.map((g) => [...g].sort((a, b) => a.dateAdded - b.dateAdded));
}


export function mergeWantlistDuplicateGroup(this: MTGCollectionPlugin, entries: WantlistCard[]): { removed: number } {
	if (entries.length < 2) return { removed: 0 };
	const keep = this.settings.wantlist.find((c) => c.id === entries[0].id);
	if (!keep) return { removed: 0 };

	const removeIds = new Set(entries.slice(1).map((c) => c.id));
	let removed = 0;
	this.settings.wantlist.forEach((c) => {
		if (removeIds.has(c.id)) {
			keep.count += c.count;
			removed++;
		}
	});
	this.settings.wantlist = this.settings.wantlist.filter((c) => !removeIds.has(c.id));
	keep.dateModified = Date.now();
	void this.saveSettings();
	return { removed };
}

// Merges all the strict-duplicate groups (findWantlistDuplicateGroups) of ONE SINGLE
// wantlist — same principle as mergeListDuplicates (collection-mutations.ts), on the
// wantlist side (WantlistSettingsModal, "Merge duplicates").

export function mergeWantlistDuplicates(this: MTGCollectionPlugin, wantlistId: string): { merged: number; removed: number } {
	const groups = this.findWantlistDuplicateGroups().filter((g) => g[0].listId === wantlistId);
	let removed = 0;
	groups.forEach((g) => {
		removed += this.mergeWantlistDuplicateGroup(g).removed;
	});
	return { merged: groups.length, removed };
}

// "Merge" — selection mode of the "My Wantlists" grid (see
// MTGCollectionView.wantlistGallerySelectMode/MergeWantlistsModal). Same
// principle as mergeLists (collection-mutations.ts), on the wantlist side.

export function mergeWantlists(this: MTGCollectionPlugin, wantlistIds: string[], name: string): Wantlist {
	const newWantlist = this.createWantlistSilent(name);
	const idSet = new Set(wantlistIds);
	this.settings.wantlist.forEach((c) => {
		if (idSet.has(c.listId)) c.listId = newWantlist.id;
	});
	this.settings.wantlists = this.settings.wantlists.filter((w) => !idSet.has(w.id));
	this.findWantlistDuplicateGroups()
		.filter((g) => g[0].listId === newWantlist.id)
		.forEach((g) => this.mergeWantlistDuplicateGroup(g));
	void this.saveSettings();
	return newWantlist;
}


export function renameWantlist(this: MTGCollectionPlugin, wantlistId: string, name: string) {
	const wantlist = this.settings.wantlists.find((w) => w.id === wantlistId);
	if (!wantlist) return;
	wantlist.name = name;
	void this.saveSettings();
}

// Copies a wantlist card to another wantlist (or the same one) without removing the
// original — same self-exclusion as copyCollectionCardToList, so that a copy into
// its own wantlist creates a deliberate duplicate.

export function copyWantlistCardToWantlist(this: MTGCollectionPlugin, cardId: string, targetWantlistId: string) {
	const card = this.settings.wantlist.find((c) => c.id === cardId);
	if (!card) return;
	const existing = this.settings.wantlist.find(
		(c) =>
			c.id !== card.id &&
			c.scryfallId === card.scryfallId &&
			c.listId === targetWantlistId &&
			c.finish === card.finish
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
	} else {
		const now = Date.now();
		this.settings.wantlist.push({
			...card,
			id: genId(),
			listId: targetWantlistId,
			dateAdded: now,
			dateModified: now,
		});
	}
	void this.saveSettings();
}

// Moves a wantlist card to another wantlist: reuses
// copyWantlistCardToWantlist then removes the original by its own id (the
// new/merged entry always has a different id, see above).

export function moveWantlistCardToWantlist(this: MTGCollectionPlugin, cardId: string, targetWantlistId: string) {
	this.copyWantlistCardToWantlist(cardId, targetWantlistId);
	this.settings.wantlist = this.settings.wantlist.filter((c) => c.id !== cardId);
	void this.saveSettings();
}

// Copies a wantlist card to My Collection, without removing it from the
// wantlist (unlike "Mark as acquired"): condition/language are not known
// for a card not yet owned, so set to "" for both (no value chosen — see
// getCondition/getLanguage, types.ts, which describe this fallback as
// "None" without it appearing as a choice in a picker) rather than
// reopening a second dialog — the user can adjust them afterwards on the
// card.

export function copyWantlistCardToList(this: MTGCollectionPlugin, cardId: string, targetListId: string) {
	const card = this.settings.wantlist.find((c) => c.id === cardId);
	if (!card) return;
	const existing = this.settings.collection.find(
		(c) =>
			c.scryfallId === card.scryfallId &&
			c.listId === targetListId &&
			c.finish === card.finish &&
			c.language === "" &&
			c.condition === ""
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
	} else {
		const now = Date.now();
		this.settings.collection.push({
			id: genId(),
			scryfallId: card.scryfallId,
			name: card.name,
			setCode: card.setCode,
			setName: card.setName,
			collectorNumber: card.collectorNumber,
			rarity: card.rarity,
			manaCost: card.manaCost,
			manaValue: card.manaValue,
			typeLine: card.typeLine,
			artist: card.artist,
			colors: card.colors,
			keywords: card.keywords,
			releasedAt: card.releasedAt,
			imageUrl: card.imageUrl,
			artCropUrl: card.artCropUrl,
			priceUsd: card.priceUsd,
			priceUsdFoil: card.priceUsdFoil,
			priceEur: card.priceEur,
			priceEurFoil: card.priceEurFoil,
			priceUsdEtched: card.priceUsdEtched,
			priceEurEtched: card.priceEurEtched,
			count: card.count,
			finish: card.finish,
			language: "",
			condition: "",
			listId: targetListId,
			dateAdded: now,
			dateModified: now,
			borderColor: card.borderColor,
			frame: card.frame,
			frameEffects: card.frameEffects,
			oracleText: card.oracleText,
		});
	}
	void this.saveSettings();
}


export function bulkRemoveWantlistCards(this: MTGCollectionPlugin, ids: string[]) {
	const idSet = new Set(ids);
	this.settings.wantlist = this.settings.wantlist.filter((c) => !idSet.has(c.id));
	void this.saveSettings();
}


export function bulkSetWantlistCardFinish(this: MTGCollectionPlugin, ids: string[], finish: Finish) {
	const idSet = new Set(ids);
	const now = Date.now();
	this.settings.wantlist.forEach((c) => {
		if (idSet.has(c.id)) {
			c.finish = finish;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}


export function bulkSetWantlistCardCount(this: MTGCollectionPlugin, ids: string[], count: number) {
	const idSet = new Set(ids);
	const safeCount = Math.max(1, Math.floor(count) || 1);
	const now = Date.now();
	this.settings.wantlist.forEach((c) => {
		if (idSet.has(c.id)) {
			c.count = safeCount;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}

// Same merge logic as copyCollectionCardToList, for the wantlist.

export function bulkMoveWantlistCardsToWantlist(this: MTGCollectionPlugin, ids: string[], targetWantlistId: string) {
	const idSet = new Set(ids);
	const now = Date.now();
	const toMove = this.settings.wantlist.filter((c) => idSet.has(c.id));

	toMove.forEach((card) => {
		const existing = this.settings.wantlist.find(
			(c) =>
				c.id !== card.id &&
				c.listId === targetWantlistId &&
				c.scryfallId === card.scryfallId &&
				c.finish === card.finish
		);
		if (existing) {
			existing.count += card.count;
			existing.dateModified = now;
		} else {
			card.listId = targetWantlistId;
			card.dateModified = now;
		}
	});

	const mergedAwayIds = new Set(
		toMove.filter((card) => card.listId !== targetWantlistId).map((c) => c.id)
	);
	if (mergedAwayIds.size > 0) {
		this.settings.wantlist = this.settings.wantlist.filter((c) => !mergedAwayIds.has(c.id));
	}
	void this.saveSettings();
}

// "Mark as acquired": removes the card from the wantlist and adds it (or
// merges, if an identical entry already exists) to My Collection, with the
// condition/language chosen at transfer time (the wantlist doesn't track
// them) and the foil already known from the wantlist.

export function moveWantlistCardToCollection(this: MTGCollectionPlugin, 
	wantlistCardId: string,
	targetListId: string,
	condition: string,
	language: string
) {
	this.moveWantlistCardToCollectionNoSave(wantlistCardId, targetListId, condition, language);
	void this.saveSettings();
}

// "Bulk" version: moves several wantlist cards in a single save, rather
// than calling moveWantlistCardToCollection in a loop (which would trigger
// as many disk writes as cards).

export function moveWantlistCardsToCollection(this: MTGCollectionPlugin, 
	wantlistCardIds: string[],
	targetListId: string,
	condition: string,
	language: string
) {
	wantlistCardIds.forEach((id) =>
		this.moveWantlistCardToCollectionNoSave(id, targetListId, condition, language)
	);
	void this.saveSettings();
}


export function moveWantlistCardToCollectionNoSave(this: MTGCollectionPlugin, 
	wantlistCardId: string,
	targetListId: string,
	condition: string,
	language: string
) {
	const card = this.settings.wantlist.find((c) => c.id === wantlistCardId);
	if (!card) return;
	const existing = this.settings.collection.find(
		(c) =>
			c.scryfallId === card.scryfallId &&
			c.listId === targetListId &&
			c.finish === card.finish &&
			c.language === language &&
			c.condition === condition
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
	} else {
		const now = Date.now();
		this.settings.collection.push({
			id: genId(),
			scryfallId: card.scryfallId,
			name: card.name,
			setCode: card.setCode,
			setName: card.setName,
			collectorNumber: card.collectorNumber,
			rarity: card.rarity,
			manaCost: card.manaCost,
			manaValue: card.manaValue,
			typeLine: card.typeLine,
			artist: card.artist,
			colors: card.colors,
			keywords: card.keywords,
			releasedAt: card.releasedAt,
			imageUrl: card.imageUrl,
			artCropUrl: card.artCropUrl,
			priceUsd: card.priceUsd,
			priceUsdFoil: card.priceUsdFoil,
			priceEur: card.priceEur,
			priceEurFoil: card.priceEurFoil,
			priceUsdEtched: card.priceUsdEtched,
			priceEurEtched: card.priceEurEtched,
			count: card.count,
			finish: card.finish,
			language,
			condition,
			listId: targetListId,
			dateAdded: now,
			dateModified: now,
			borderColor: card.borderColor,
			frame: card.frame,
			frameEffects: card.frameEffects,
			oracleText: card.oracleText,
		});
	}
	this.settings.wantlist = this.settings.wantlist.filter((c) => c.id !== wantlistCardId);
}

/* ------------------------------- Decks -------------------------------- */

// `format`: a LEGALITY_SEARCH_FORMATS key (card-search.ts, e.g.
// "commander") chosen in NewDeckModal, or undefined ("None") — see
// Deck.format (data-model.ts) for the full reasoning.
