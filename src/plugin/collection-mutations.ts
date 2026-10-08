import {
	Finish,
	GradingCompany,
	CollectionCard,
} from "../core/card-model";
import {
	ScryfallCard,
	getImageUrl,
	getArtCropUrl,
	buildCardTextInfo,
} from "../api/scryfall";
import {
	CollectionList,
	genId,
	ListIcon,
} from "../core/data-model";
import { AddCardOptions } from "../modals/shared-search-ui";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  My Collection: card + list mutations (add/remove/bulk-*, list CRUD,
    copy/move to another list or wantlist). Split out of plugin.ts on
    2026-09-10.  */
/* -------------------------------------------------------------------------- */

export function createListSilent(this: MTGCollectionPlugin, name: string): CollectionList {
	const list: CollectionList = { id: genId(), name, dateCreated: Date.now() };
	this.settings.lists.push(list);
	return list;
}

// Cards added before the introduction of grouping/sorting (artist, colors,
// mana value, release date) don't have this information: we fetch it in a
// handful of grouped requests to Scryfall.

export function getOrCreateListByName(this: MTGCollectionPlugin, name: string): CollectionList {
	const existing = this.settings.lists.find((l) => l.name === name);
	if (existing) return existing;
	return this.createListSilent(name || "Unsorted");
}


export function addCardToCollection(this: MTGCollectionPlugin, 
	card: ScryfallCard,
	listId: string,
	options: AddCardOptions
): CollectionCard {
	const existing = this.settings.collection.find(
		(c) =>
			c.scryfallId === card.id &&
			c.listId === listId &&
			c.finish === options.finish &&
			c.language === options.language &&
			c.condition === options.condition
	);
	if (existing) {
		existing.count += 1;
		existing.dateModified = Date.now();
		this.recentlyAddedCollectionCardIds.add(existing.id);
		void this.saveSettings();
		return existing;
	} else {
		const now = Date.now();
		const newId = genId();
		const entry: CollectionCard = {
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
			language: options.language,
			condition: options.condition,
			listId,
			dateAdded: now,
			dateModified: now,
			borderColor: card.border_color ?? "",
			frame: card.frame ?? "",
			frameEffects: card.frame_effects ?? [],
			oracleText: buildCardTextInfo(card).oracleText,
		};
		this.settings.collection.push(entry);
		this.recentlyAddedCollectionCardIds.add(newId);
		void this.saveSettings();
		return entry;
	}
}


export function changeCollectionCardCount(this: MTGCollectionPlugin, rowId: string, delta: number, onDone: () => void) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	// The minimum is 1: to remove a card completely from the collection, we
	// use the delete button rather than going down to 0.
	card.count = Math.max(1, card.count + delta);
	card.dateModified = Date.now();
	void this.saveSettings();
	onDone();
}


export function removeCollectionCard(this: MTGCollectionPlugin, rowId: string) {
	this.settings.collection = this.settings.collection.filter(
		(c) => c.id !== rowId
	);
	void this.saveSettings();
}

// Undoes `delta` copies added from "Add cards" (see AddCardsModal's "Add history"
// panel, onUndoAdd in shared-search-ui.ts) — finds the row by the SAME deduplication
// key that addCardToCollection already uses to MERGE an addition (scryfallId + listId
// + finish/language/condition), rather than a row id that could become invalid between
// a "disable" (which can delete the row) and a later "re-enable".
// changeCollectionCardCount() doesn't fit here: it caps at 1, never 0, whereas undoing
// the very first contribution must be able to remove the row entirely (see the
// computation below, which itself decides decrement vs deletion according to the
// remaining balance — a +/- adjustment made in the meantime on the same row, via the
// carousel tile's stepper or from My Collection, thus remains intact: only what THIS
// session contributed is taken back, never the original real count). Returns the
// resulting row (or undefined if deleted) so that AddCardsModal can resynchronize its
// own carousel tile on the real state.

export function undoAddToCollection(this: MTGCollectionPlugin, 
	scryfallId: string,
	listId: string,
	options: AddCardOptions,
	delta: number
): CollectionCard | undefined {
	const row = this.settings.collection.find(
		(c) =>
			c.scryfallId === scryfallId &&
			c.listId === listId &&
			c.finish === options.finish &&
			c.language === options.language &&
			c.condition === options.condition
	);
	if (!row) return undefined;
	if (row.count - delta <= 0) {
		this.removeCollectionCard(row.id);
		return undefined;
	}
	row.count -= delta;
	row.dateModified = Date.now();
	void this.saveSettings();
	return row;
}


export function setCollectionCardLanguage(this: MTGCollectionPlugin, rowId: string, language: string) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.language = language;
	card.dateModified = Date.now();
	void this.saveSettings();
}


export function setCollectionCardCondition(this: MTGCollectionPlugin, rowId: string, condition: string) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.condition = condition;
	card.dateModified = Date.now();
	void this.saveSettings();
}


export function setCollectionCardFinish(this: MTGCollectionPlugin, rowId: string, finish: Finish) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.finish = finish;
	card.dateModified = Date.now();
	void this.saveSettings();
}


export function setCollectionCardGrading(this: MTGCollectionPlugin, 
	rowId: string,
	gradingCompany: GradingCompany | undefined,
	gradingGrade: number | undefined,
	gradingLabel: string | undefined
) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.gradingCompany = gradingCompany;
	card.gradingGrade = gradingGrade;
	card.gradingLabel = gradingLabel;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// Separate from setCollectionCardGrading: the "Custom Price" box is now edited inline
// (not via GradingModal, which now only concerns grading), so its own plugin call
// must not be able to overwrite gradingCompany/gradingGrade by passing default
// values.

export function setCollectionCardCustomPrice(this: MTGCollectionPlugin, rowId: string, customPrice: string) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.customPrice = customPrice.trim() ? customPrice.trim() : undefined;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// Directly sets the quantity (rather than by increment), for inline editing
// of the number. Minimum 1, like changeCollectionCardCount.

export function setCollectionCardCount(this: MTGCollectionPlugin, rowId: string, newCount: number, onDone: () => void) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.count = Math.max(1, Math.floor(newCount) || 1);
	card.dateModified = Date.now();
	void this.saveSettings();
	onDone();
}

// Changes the printing (set/number/price/rarity...) of a card already in
// the collection, keeping quantity/foil/language/condition/list unchanged.

export function changeCollectionCardPrinting(this: MTGCollectionPlugin, rowId: string, scry: ScryfallCard) {
	const card = this.settings.collection.find((c) => c.id === rowId);
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


// Spots strictly identical entries (same Scryfall card, same list, same foil
// status, same language, same condition) without modifying anything — see
// mergeListDuplicateGroup for the merge itself. Can happen e.g. after a set
// change that makes two cards converge on the exact same printing within a
// same list. Each returned group is sorted by date added (the oldest first,
// the one mergeListDuplicateGroup will keep).

export function findListDuplicateGroups(this: MTGCollectionPlugin): CollectionCard[][] {
	const groups = new Map<string, CollectionCard[]>();
	this.settings.collection.forEach((c) => {
		const key = `${c.scryfallId}|${c.listId}|${c.finish}|${c.language}|${c.condition}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(c);
	});
	return Array.from(groups.values())
		.filter((g) => g.length > 1)
		.map((g) => [...g].sort((a, b) => a.dateAdded - b.dateAdded));
}

// Merges a specific group (already identified by findListDuplicateGroups):
// quantities are added together into the oldest entry (the first element
// of the group), the others are deleted.

export function mergeListDuplicateGroup(this: MTGCollectionPlugin, entries: CollectionCard[]): { removed: number } {
	if (entries.length < 2) return { removed: 0 };
	const keep = this.settings.collection.find((c) => c.id === entries[0].id);
	if (!keep) return { removed: 0 };

	const removeIds = new Set(entries.slice(1).map((c) => c.id));
	let removed = 0;
	this.settings.collection.forEach((c) => {
		if (removeIds.has(c.id)) {
			keep.count += c.count;
			removed++;
		}
	});
	this.settings.collection = this.settings.collection.filter(
		(c) => !removeIds.has(c.id)
	);
	keep.dateModified = Date.now();
	void this.saveSettings();
	return { removed };
}

// Merges all the strict-duplicate groups (findListDuplicateGroups) of ONE
// SINGLE list — same computation as mergeLists higher up (which already
// applies it, scoped to the merged list), just exposed here as its own
// action for an already existing list from ListSettingsModal ("Merge
// duplicates"): acts immediately, without a group-by-group review screen,
// consistent with the rest of this window, where each button acts right
// away rather than opening a second screen.

export function mergeListDuplicates(this: MTGCollectionPlugin, listId: string): { merged: number; removed: number } {
	const groups = this.findListDuplicateGroups().filter((g) => g[0].listId === listId);
	let removed = 0;
	groups.forEach((g) => {
		removed += this.mergeListDuplicateGroup(g).removed;
	});
	return { merged: groups.length, removed };
}

// Light anti-spam against repeated/accidental clicks on "Refresh now":
// doesn't prevent a legitimate one-off check (unlike the delay configured
// in the settings, which only governs the automatic background check).

// Asks Scryfall again for the current price of each distinct printing of the
// collection AND the wantlist, in grouped requests (75 per batch, slight
// delay between each — see fetchScryfallCollection). An identifier present
// in both is only requested once (uniqueIds deduplicates over the two sets
// combined). A single disk write at the end, not one per card.

export function bulkRemoveCollectionCards(this: MTGCollectionPlugin, ids: string[]) {
	const idSet = new Set(ids);
	this.settings.collection = this.settings.collection.filter((c) => !idSet.has(c.id));
	void this.saveSettings();
}


export function bulkSetCollectionCardCondition(this: MTGCollectionPlugin, ids: string[], condition: string) {
	const idSet = new Set(ids);
	const now = Date.now();
	this.settings.collection.forEach((c) => {
		if (idSet.has(c.id)) {
			c.condition = condition;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}


export function bulkSetCollectionCardLanguage(this: MTGCollectionPlugin, ids: string[], language: string) {
	const idSet = new Set(ids);
	const now = Date.now();
	this.settings.collection.forEach((c) => {
		if (idSet.has(c.id)) {
			c.language = language;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}


export function bulkSetCollectionCardFinish(this: MTGCollectionPlugin, ids: string[], finish: Finish) {
	const idSet = new Set(ids);
	const now = Date.now();
	this.settings.collection.forEach((c) => {
		if (idSet.has(c.id)) {
			c.finish = finish;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}


export function bulkSetCollectionCardCount(this: MTGCollectionPlugin, ids: string[], count: number) {
	const idSet = new Set(ids);
	const safeCount = Math.max(1, Math.floor(count) || 1);
	const now = Date.now();
	this.settings.collection.forEach((c) => {
		if (idSet.has(c.id)) {
			c.count = safeCount;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}

/* ------------------------------- Lists -------------------------------- */


export function createList(this: MTGCollectionPlugin, name: string): CollectionList {
	const list: CollectionList = { id: genId(), name, dateCreated: Date.now() };
	this.settings.lists.push(list);
	void this.saveSettings();
	return list;
}

// isInbox: never deletable, even by this direct call — the interface
// (ListSettingsModal) already no longer shows a "Delete" button for Inbox,
// but this safeguard remains here as defense in depth for any future
// caller that would invoke it directly.

export function deleteList(this: MTGCollectionPlugin, listId: string) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (list?.isInbox) return;
	this.settings.lists = this.settings.lists.filter((l) => l.id !== listId);
	this.settings.collection = this.settings.collection.filter(
		(c) => c.listId !== listId
	);
	void this.saveSettings();
}

// Empties a list (removes all its cards) without deleting the list itself,
// unlike deleteList just above which deletes both at once — a distinct
// "cleanup" action, explicitly requested from ListSettingsModal ("Empty
// the list").

export function clearList(this: MTGCollectionPlugin, listId: string) {
	this.settings.collection = this.settings.collection.filter(
		(c) => c.listId !== listId
	);
	void this.saveSettings();
}

// Sets (or clears, cardId undefined) a list's cover image — see
// CollectionList.coverCardId/resolveCoverImage (core/price.ts) for the
// resolution on the display side. Doesn't validate that cardId really
// belongs to this list: ListSettingsModal only offers cards from the list
// itself, and resolveCoverImage silently falls back to the automatic
// choice if the id no longer matches anything anyway.

export function setListCoverCard(this: MTGCollectionPlugin, listId: string, cardId: string | undefined) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (!list) return;
	list.coverCardId = cardId;
	void this.saveSettings();
}

// Sets (or clears, icon undefined) a list's pictogram — see
// CollectionList.listIcon (core/data-model.ts) for the resolution on the
// display side (renderListTile/CopyCardModal.renderTile).

export function setListIcon(this: MTGCollectionPlugin, listId: string, icon: ListIcon | undefined) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (!list) return;
	list.listIcon = icon;
	void this.saveSettings();
}

// Grouped version of deleteList above — selection mode of the "My
// Collection" grid (MTGCollectionView.listGallerySelectMode), a single
// settings write for all the ids rather than one call per list. Inbox is
// already never selectable in this grid (see renderListTile), but removed
// here too for the same reason as deleteList above.

export function bulkDeleteLists(this: MTGCollectionPlugin, listIds: string[]) {
	const inboxId = this.settings.lists.find((l) => l.isInbox)?.id;
	const idSet = new Set(listIds.filter((id) => id !== inboxId));
	this.settings.lists = this.settings.lists.filter((l) => !idSet.has(l.id));
	this.settings.collection = this.settings.collection.filter((c) => !idSet.has(c.listId));
	void this.saveSettings();
}

// "Merge" — selection mode of the "My Collection" grid (see
// MTGCollectionView.listGallerySelectMode/MergeListsModal). Creates a new
// list, reassigns to it all the cards of the selected lists (a simple listId
// change, not a copy — the existing CollectionCards are kept as is, with
// their id/finish/language/condition/grading/custom price), deletes the
// original lists, then automatically merges the duplicates now in the same
// list (same card present in several of the merged lists, same
// finish/language/condition) by reusing as is the already established logic
// of findListDuplicateGroups/mergeListDuplicateGroup ("Merge duplicate
// cards") — rather than a reimplementation, since it is exactly the same
// computation once the cards share the same listId.

export function mergeLists(this: MTGCollectionPlugin, listIds: string[], name: string): CollectionList {
	const newList = this.createListSilent(name);
	// Inbox is already never selectable in the grid (see renderListTile), so
	// never actually present in listIds in practice — removed anyway as
	// defense in depth, since mergeLists DELETES each original list once its
	// cards are reassigned (see below), which would violate the protection
	// against deleting Inbox if it were ever reached through another path.
	const inboxId = this.settings.lists.find((l) => l.isInbox)?.id;
	const idSet = new Set(listIds.filter((id) => id !== inboxId));
	this.settings.collection.forEach((c) => {
		if (idSet.has(c.listId)) c.listId = newList.id;
	});
	this.settings.lists = this.settings.lists.filter((l) => !idSet.has(l.id));
	this.findListDuplicateGroups()
		.filter((g) => g[0].listId === newList.id)
		.forEach((g) => this.mergeListDuplicateGroup(g));
	void this.saveSettings();
	return newList;
}

// isInbox: never renamable — same safeguard/reasoning as deleteList above
// (the UI already no longer shows the rename field for Inbox, this remains
// a defense in depth).

export function renameList(this: MTGCollectionPlugin, listId: string, name: string) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (!list || list.isInbox) return;
	list.name = name;
	void this.saveSettings();
}

// Copies a card from the collection to another list (or the same one)
// without removing the original — unlike moveCollectionCardToList which
// moves. c.id !== card.id excludes the entry itself from a merge onto
// itself: copying into its own list creates a deliberate duplicate rather
// than simply doubling its quantity in place.

export function copyCollectionCardToList(this: MTGCollectionPlugin, cardId: string, targetListId: string) {
	const card = this.settings.collection.find((c) => c.id === cardId);
	if (!card) return;
	const existing = this.settings.collection.find(
		(c) =>
			c.id !== card.id &&
			c.scryfallId === card.scryfallId &&
			c.listId === targetListId &&
			c.finish === card.finish &&
			c.language === card.language &&
			c.condition === card.condition
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
	} else {
		const now = Date.now();
		this.settings.collection.push({
			...card,
			id: genId(),
			listId: targetListId,
			dateAdded: now,
			dateModified: now,
		});
	}
	void this.saveSettings();
}

// Copies a card from the collection to a wantlist: condition/language make
// no sense for a wanted card (see WantlistCard), so they are simply
// omitted rather than carried over.

export function copyCollectionCardToWantlist(this: MTGCollectionPlugin, cardId: string, targetWantlistId: string) {
	const card = this.settings.collection.find((c) => c.id === cardId);
	if (!card) return;
	const existing = this.settings.wantlist.find(
		(c) =>
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
			listId: targetWantlistId,
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

// Moves (rather than copies) a card from the collection to another list: reuses
// copyCollectionCardToList for the merge/creation logic on the destination side,
// then removes the original.

export function moveCollectionCardToList(this: MTGCollectionPlugin, cardId: string, targetListId: string) {
	this.copyCollectionCardToList(cardId, targetListId);
	this.removeCollectionCard(cardId);
}


export function moveCollectionCardToWantlist(this: MTGCollectionPlugin, cardId: string, targetWantlistId: string) {
	this.copyCollectionCardToWantlist(cardId, targetWantlistId);
	this.removeCollectionCard(cardId);
}

/* ----------------------------- Wantlists ------------------------------ */

// Returns the resulting entry (existing or newly created) — same reason as
// the return added to addCardToCollection above.
