import {
	Finish,
	GradingCompany,
} from "../core/card-model";
import {
	ScryfallCard,
	getImageUrl,
	getArtCropUrl,
	fetchScryfallCollection,
	buildCardTextInfo,
} from "../api/scryfall";
import {
	DeckSourceCard,
	Deck,
	DeckCard,
	genId,
	DeckCardCategory,
	getDeckCardCategory,
	isDeckCommander,
	getDeckCardFinish,
	getDeckCardCondition,
	getDeckCardLanguage,
	ListIcon,
} from "../core/data-model";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  My Decks: card + deck mutations. Split out of plugin.ts on 2026-09-10.  */
/* -------------------------------------------------------------------------- */

// Same principle as changeCollectionCardPrinting
// (collection-mutations.ts)/changeWantlistCardPrinting
// (wantlist-mutations.ts), for a deck card — DeckCard simply has no id
// field of its own (see "Data model notes" in CLAUDE.md), so the row is
// found by scryfallId + category rather than by id, the same uniqueness key
// already used elsewhere for a deck (see
// addCardToDeck/importDecklistToDeck). No release-date field here (DeckCard
// still persists none, unlike CollectionCard/WantlistCard — the price, for
// its part, is updated below since 2026-09-02);
// count/category/dateAdded/owned/finish/language/condition/grading/customPrice
// stay unchanged (a printing change doesn't change the physical copy
// itself), only the fields derived from the Scryfall printing itself move.

export function changeDeckCardPrinting(this: MTGCollectionPlugin,
	deckId: string,
	scryfallId: string,
	category: DeckCardCategory,
	scry: ScryfallCard
) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find(
		(c) => c.scryfallId === scryfallId && getDeckCardCategory(c) === category
	);
	if (!card) return;
	// Another row of this same deck (same category AND same Commander status —
	// see isDeckCommander, data-model.ts, for why category alone is no longer
	// enough) already points to the chosen printing — merges instead of
	// duplicating, same reasoning as everywhere else that a deck merges by
	// this key rather than accumulating two rows for the same card.
	const wasCommander = isDeckCommander(card);
	const existing = deck.cards.find(
		(c) =>
			c !== card &&
			c.scryfallId === scry.id &&
			getDeckCardCategory(c) === category &&
			isDeckCommander(c) === wasCommander
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
		deck.cards = deck.cards.filter((c) => c !== card);
		void this.saveSettings();
		return;
	}
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
	card.imageUrl = getImageUrl(scry);
	card.artCropUrl = getArtCropUrl(scry);
	card.borderColor = scry.border_color ?? "";
	card.frame = scry.frame ?? "";
	card.frameEffects = scry.frame_effects ?? [];
	card.oracleText = buildCardTextInfo(scry).oracleText;
	card.priceUsd = scry.prices?.usd ?? "";
	card.priceUsdFoil = scry.prices?.usd_foil ?? "";
	card.priceEur = scry.prices?.eur ?? "";
	card.priceEurFoil = scry.prices?.eur_foil ?? "";
	card.priceUsdEtched = scry.prices?.usd_etched ?? "";
	card.priceEurEtched = scry.prices?.eur_etched ?? "";
	card.dateModified = Date.now();
	void this.saveSettings();
}

export function createDeck(this: MTGCollectionPlugin, name: string, format?: string): Deck {
	const deck: Deck = {
		id: genId(),
		name,
		cards: [],
		dateCreated: Date.now(),
		format,
	};
	this.settings.decks.push(deck);
	void this.saveSettings();
	return deck;
}

// Editable afterwards from DeckSettingsModal — a format chosen at creation
// isn't frozen forever, same logic as renameDeck just above.

export function setDeckFormat(this: MTGCollectionPlugin, deckId: string, format: string | undefined) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.format = format;
	void this.saveSettings();
}

// Empties a deck (removes all its cards) without deleting it — same
// reasoning/pairing with deleteDeck as clearList/deleteList on the list
// side (see clearList, collection-mutations.ts).

export function clearDeck(this: MTGCollectionPlugin, deckId: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.cards = [];
	void this.saveSettings();
}

// Sets (or clears, scryfallId undefined) a deck's cover image — see
// Deck.coverCardId/resolveDeckCoverImage (core/price.ts). Identified by
// scryfallId rather than by id like setListCoverCard: DeckCard has no id
// field of its own (see "Data model notes" in CLAUDE.md).

export function setDeckCoverCard(this: MTGCollectionPlugin, deckId: string, scryfallId: string | undefined) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.coverCardId = scryfallId;
	void this.saveSettings();
}

// Sets (or clears, icon undefined) a deck's pictogram — see Deck.deckIcon
// (core/data-model.ts) for the resolution on the display side
// (renderDeckGrid/CopyCardModal.renderDecksTab).

export function setDeckIcon(this: MTGCollectionPlugin, deckId: string, icon: ListIcon | undefined) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.deckIcon = icon;
	void this.saveSettings();
}


export function deleteDeck(this: MTGCollectionPlugin, deckId: string) {
	this.settings.decks = this.settings.decks.filter((d) => d.id !== deckId);
	void this.saveSettings();
}

// Grouped version of deleteDeck above — see bulkDeleteLists.

export function bulkDeleteDecks(this: MTGCollectionPlugin, deckIds: string[]) {
	const idSet = new Set(deckIds);
	this.settings.decks = this.settings.decks.filter((d) => !idSet.has(d.id));
	void this.saveSettings();
}


export function renameDeck(this: MTGCollectionPlugin, deckId: string, name: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.name = name;
	void this.saveSettings();
}


export function copyDeck(this: MTGCollectionPlugin, deckId: string): Deck {
	const source = this.settings.decks.find((d) => d.id === deckId);
	const newDeck: Deck = {
		id: genId(),
		name: `${source?.name ?? "Deck"} copy`,
		cards: (source?.cards ?? []).map((c) => ({ ...c })),
		dateCreated: Date.now(),
		// A copy takes over the source deck's format — it really is the same deck,
		// cards AND format, just duplicated (see Deck.format).
		format: source?.format,
	};
	this.settings.decks.push(newDeck);
	void this.saveSettings();
	return newDeck;
}


export function createDeckSilent(this: MTGCollectionPlugin, name: string, format?: string): Deck {
	const deck: Deck = { id: genId(), name, cards: [], dateCreated: Date.now(), format };
	this.settings.decks.push(deck);
	return deck;
}

// Merges the strict duplicates of ONE SINGLE deck — DeckCard has no id field of its
// own (see "Data model notes" in CLAUDE.md), so they are found by scryfallId +
// category + Commander status rather than by id like
// findListDuplicateGroups/mergeListDuplicateGroup (collection-mutations.ts) or
// findWantlistDuplicateGroups/mergeWantlistDuplicateGroup (wantlist-mutations.ts) —
// the same identity key already established elsewhere for decks (addCardToDeck on
// adding, changeDeckCardPrinting, the decklist import), NOT the narrower key
// scryfallId alone that changeDeckCardCount/removeDeckCard/undoAddToDeck use (see
// their own comment): two entries with the same scryfallId+category but one
// Commander and the other not (a Background card counted both as Commander and as
// ordinary mainboard, for example — see isDeckCommander) are NOT duplicates.
// Written directly rather than factored into separate
// findDeckDuplicateGroups/mergeDeckDuplicateGroup (as on the collection/wantlist
// side): no group-by-group review screen is asked for here, just an immediate action
// from DeckSettingsModal — no second caller that would need the selection without
// the application.

export function mergeDeckDuplicates(this: MTGCollectionPlugin, deckId: string): { merged: number; removed: number } {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return { merged: 0, removed: 0 };
	const groups = new Map<string, DeckCard[]>();
	deck.cards.forEach((c) => {
		const key = `${c.scryfallId}|${getDeckCardCategory(c)}|${isDeckCommander(c)}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(c);
	});
	const dupGroups = Array.from(groups.values())
		.filter((g) => g.length > 1)
		.map((g) => [...g].sort((a, b) => a.dateAdded - b.dateAdded));

	let removed = 0;
	dupGroups.forEach((g) => {
		const keep = g[0];
		g.slice(1).forEach((c) => {
			keep.count += c.count;
			removed++;
		});
		keep.dateModified = Date.now();
	});
	const removeSet = new Set(dupGroups.flatMap((g) => g.slice(1)));
	deck.cards = deck.cards.filter((c) => !removeSet.has(c));
	if (removed > 0) void this.saveSettings();
	return { merged: dupGroups.length, removed };
}

// "Merge decks" (DeckSettingsModal, modeled on mergeLists (collection-mutations.ts)/mergeWantlists
// (wantlist-mutations.ts)) — creates a new deck, copies into it all the cards of the selected decks (a copy,
// not a reassignment like mergeLists: unlike CollectionCard, a DeckCard has no listId field to reassign, it
// lives directly in Deck.cards), deletes the original decks, then merges the duplicates now in the same deck
// by reusing mergeDeckDuplicates above.

export function mergeDecks(this: MTGCollectionPlugin, deckIds: string[], name: string): Deck {
	const newDeck = this.createDeckSilent(name);
	const idSet = new Set(deckIds);
	this.settings.decks
		.filter((d) => idSet.has(d.id))
		.forEach((d) => d.cards.forEach((c) => newDeck.cards.push({ ...c })));
	this.settings.decks = this.settings.decks.filter((d) => !idSet.has(d.id));
	this.mergeDeckDuplicates(newDeck.id);
	void this.saveSettings();
	return newDeck;
}

// Returns the resulting row (new or merged) — same convention as
// addCardToCollection/addCardToWantlist, until now only this method
// returned void. Needed so that the Deck's "Add cards" flow can be
// harmonized with Collection/Wantlist (see the call site in view.ts,
// onAdd): AddCardsModalOptions.onAdd expects { id, count, listId } to turn
// the "Add" button into a stepper — DeckCard has no id field of its own
// (see data-model.ts), so the call site uses scryfallId in its place, the
// same key that changeDeckCardCount/removeDeckCard/undoAddToDeck already
// use to find a row in deck.cards.

export function addCardToDeck(this: MTGCollectionPlugin, deckId: string, card: ScryfallCard): DeckCard | undefined {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return undefined;
	const existing = deck.cards.find((c) => c.scryfallId === card.id);
	if (existing) {
		existing.count += 1;
		existing.dateModified = Date.now();
		void this.saveSettings();
		return existing;
	}
	const now = Date.now();
	const newCard: DeckCard = {
		scryfallId: card.id,
		name: card.name,
		setCode: card.set,
		setName: card.set_name,
		collectorNumber: card.collector_number,
		imageUrl: getImageUrl(card),
		artCropUrl: getArtCropUrl(card),
		manaCost: card.mana_cost ?? "",
		manaValue: card.cmc ?? 0,
		typeLine: card.type_line,
		rarity: card.rarity,
		artist: card.artist ?? "",
		colors: card.colors ?? [],
		keywords: card.keywords ?? [],
		count: 1,
		dateAdded: now,
		dateModified: now,
		borderColor: card.border_color ?? "",
		frame: card.frame ?? "",
		frameEffects: card.frame_effects ?? [],
		oracleText: buildCardTextInfo(card).oracleText,
		priceUsd: card.prices?.usd ?? "",
		priceUsdFoil: card.prices?.usd_foil ?? "",
		priceEur: card.prices?.eur ?? "",
		priceEurFoil: card.prices?.eur_foil ?? "",
		priceUsdEtched: card.prices?.usd_etched ?? "",
		priceEurEtched: card.prices?.eur_etched ?? "",
	};
	deck.cards.push(newCard);
	void this.saveSettings();
	return newCard;
}

// Copies a card already present in the collection (a "List") to a deck. A
// card added this way is owned by definition: if it merges with an existing
// entry from a wantlist (owned: false), that entry becomes "owned" — we now
// have at least one real copy.

export function addCollectionCardToDeck(this: MTGCollectionPlugin, card: DeckSourceCard, deckId: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const existing = deck.cards.find((c) => c.scryfallId === card.scryfallId);
	if (existing) {
		existing.count += 1;
		existing.owned = true;
	} else {
		const now = Date.now();
		deck.cards.push({
			scryfallId: card.scryfallId,
			name: card.name,
			setCode: card.setCode,
			setName: card.setName,
			collectorNumber: card.collectorNumber,
			imageUrl: card.imageUrl,
			artCropUrl: card.artCropUrl,
			manaCost: card.manaCost,
			manaValue: card.manaValue,
			typeLine: card.typeLine,
			rarity: card.rarity,
			artist: card.artist,
			colors: card.colors,
			keywords: card.keywords,
			count: 1,
			dateAdded: now,
			dateModified: now,
			owned: true,
			borderColor: card.borderColor,
			frame: card.frame,
			frameEffects: card.frameEffects,
			oracleText: card.oracleText,
			// See DeckSourceCard.finish/condition/language — takes over the real
			// physical copy being copied (a CollectionCard has all three), rather than
			// the default "Regular"/none fallback of a truly new deck card (see
			// addCardToDeck).
			finish: card.finish,
			condition: card.condition,
			language: card.language,
			// See DeckSourceCard.priceUsd/etc. — same reasoning, price already known
			// from the source card rather than a "not yet known" while waiting for
			// backfillDeckCardPrices().
			priceUsd: card.priceUsd,
			priceUsdFoil: card.priceUsdFoil,
			priceEur: card.priceEur,
			priceEurFoil: card.priceEurFoil,
			priceUsdEtched: card.priceUsdEtched,
			priceEurEtched: card.priceEurEtched,
		});
	}
	void this.saveSettings();
}

// Adds a not-yet-owned card (from a wantlist) to a deck. Unlike
// addCollectionCardToDeck, a merge with an already owned entry doesn't
// demote it: owned never goes down, only up.

export function addWantlistCardToDeck(this: MTGCollectionPlugin, card: DeckSourceCard, deckId: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const existing = deck.cards.find((c) => c.scryfallId === card.scryfallId);
	if (existing) {
		existing.count += 1;
	} else {
		const now = Date.now();
		deck.cards.push({
			scryfallId: card.scryfallId,
			name: card.name,
			setCode: card.setCode,
			setName: card.setName,
			collectorNumber: card.collectorNumber,
			imageUrl: card.imageUrl,
			artCropUrl: card.artCropUrl,
			manaCost: card.manaCost,
			manaValue: card.manaValue,
			typeLine: card.typeLine,
			rarity: card.rarity,
			artist: card.artist,
			colors: card.colors,
			keywords: card.keywords,
			count: 1,
			dateAdded: now,
			dateModified: now,
			owned: false,
			borderColor: card.borderColor,
			frame: card.frame,
			frameEffects: card.frameEffects,
			oracleText: card.oracleText,
			// See addCollectionCardToDeck — same reasoning, but condition/language
			// stay absent: a WantlistCard has neither (not owned yet), same asymmetry
			// already established elsewhere for this type of card.
			finish: card.finish,
			priceUsd: card.priceUsd,
			priceUsdFoil: card.priceUsdFoil,
			priceEur: card.priceEur,
			priceEurFoil: card.priceEurFoil,
			priceUsdEtched: card.priceUsdEtched,
			priceEurEtched: card.priceEurEtched,
		});
	}
	void this.saveSettings();
}


export function changeDeckCardCount(this: MTGCollectionPlugin, 
	deckId: string,
	scryfallId: string,
	delta: number,
	onDone: () => void
) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.count = Math.max(0, card.count + delta);
	void this.saveSettings();
	onDone();
}


export function removeDeckCard(this: MTGCollectionPlugin, deckId: string, scryfallId: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.cards = deck.cards.filter((c) => c.scryfallId !== scryfallId);
	void this.saveSettings();
}

// My Decks/My Collection harmonization (2026-08-25) — equivalents of
// setCollectionCardFinish/setCollectionCardCondition/setCollectionCardLanguage/setCollectionCardGrading/setCollectionCardCustomPrice
// (collection-mutations.ts), for a deck card. They find their row by scryfallId ALONE, like
// changeDeckCardCount/removeDeckCard/undoAddToDeck above/below — not by scryfallId + category like
// changeDeckCardPrinting: these are the same two conventions already established for a deck (see their
// own comments), not a new divergence introduced here. A same card present twice in a deck under two
// different categories (e.g. mainboard AND sideboard), or once as Commander and once as non-Commander
// (e.g. decklist import with a Background counted separately — see isDeckCommander), therefore remains
// ambiguous for these 5 methods — a limitation already accepted for
// changeDeckCardCount/removeDeckCard/undoAddToDeck, not specific to
// finish/condition/language/grading/custom price.

export function setDeckCardFinish(this: MTGCollectionPlugin, deckId: string, scryfallId: string, finish: Finish) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.finish = finish;
	card.dateModified = Date.now();
	void this.saveSettings();
}


export function setDeckCardCondition(this: MTGCollectionPlugin, deckId: string, scryfallId: string, condition: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.condition = condition;
	card.dateModified = Date.now();
	void this.saveSettings();
}


export function setDeckCardLanguage(this: MTGCollectionPlugin, deckId: string, scryfallId: string, language: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.language = language;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// "Board" box of DeckCardDetailModal (2026-09-06 under the name
// "Category", renamed "Board" on 2026-09-08 — see DeckCardCategory for why
// Commander is no longer part of it) — manual correction of
// DeckCard.category (Mainboard/Sideboard/Maybeboard), same ambiguity
// accepted for a card present twice under two different categories as the
// 5 methods above (see their comment): the first matching row wins.

export function setDeckCardCategory(this: MTGCollectionPlugin, deckId: string, scryfallId: string, category: DeckCardCategory) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.category = category;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// "Group by Function" (2026-09-02) — manual correction of an
// erroneous/missing automatic detection (see
// DeckCard.deckFunctionOverride, "Group by Function"/Stacks view,
// view.ts). `undefined` = goes back to automatic detection (the picker
// offers "Auto (…)" for that, see DeckCardDetailModal), same convention as
// setDeckCardCustomPrice for "empty field = no forced fallback".

export function setDeckCardFunction(this: MTGCollectionPlugin, deckId: string, scryfallId: string, functionOverride: string | undefined) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.deckFunctionOverride = functionOverride;
	card.dateModified = Date.now();
	void this.saveSettings();
}


export function setDeckCardGrading(this: MTGCollectionPlugin, 
	deckId: string,
	scryfallId: string,
	gradingCompany: GradingCompany | undefined,
	gradingGrade: number | undefined,
	gradingLabel: string | undefined
) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.gradingCompany = gradingCompany;
	card.gradingGrade = gradingGrade;
	card.gradingLabel = gradingLabel;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// See setCollectionCardCustomPrice (collection-mutations.ts) — same reason for being separate
// from setDeckCardGrading.

export function setDeckCardCustomPrice(this: MTGCollectionPlugin, deckId: string, scryfallId: string, customPrice: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.customPrice = customPrice.trim() ? customPrice.trim() : undefined;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// See undoAddToCollection (collection-mutations.ts)/undoAddToWantlist
// (wantlist-mutations.ts) — same reasoning, on the deck side, for the "Add
// history" panel of the "Add cards" window (uniformization explicitly
// requested with Collection/Wantlist). Shorter deduplication key than its
// 2 counterparts: addCardToDeck only merges by scryfallId, never by
// finish/language/condition (unlike undoAddToCollection/undoAddToWantlist)
// — DeckCard does carry these 3 fields since the My Decks/My Collection
// harmonization (2026-08-25), but a deck still only distinguishes ONE row
// per card (see addCardToDeck), not one per finish/language/condition
// combination like Collection/Wantlist — no need for a 2nd "options"
// parameter here.

export function undoAddToDeck(this: MTGCollectionPlugin, scryfallId: string, deckId: string, delta: number): DeckCard | undefined {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return undefined;
	const row = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!row) return undefined;
	if (row.count - delta <= 0) {
		this.removeDeckCard(deckId, scryfallId);
		return undefined;
	}
	row.count -= delta;
	row.dateModified = Date.now();
	void this.saveSettings();
	return row;
}

// "Move card" from the "Deck" box of the detail panel (harmonization with the
// "List"/"Wantlist" box of CardDetailModal/WantlistCardDetailModal,
// 2026-08-25, explicitly requested) — 3 possible destinations
// (List/Deck/Wantlist), see CopyCardModal (sourceKind === "deck"). DeckCard
// still has no releasedAt field (see "Data model notes" in CLAUDE.md — the
// price IS cached since 2026-09-02, but not that field), unlike
// copyCollectionCardToList/copyWantlistCardToList which can reuse as is the
// fields already present on their source card —
// copyDeckCardToList/copyDeckCardToWantlist below therefore always need a
// fresh Scryfall round trip, the same function (fetchScryfallCollection) that
// addCardToDeck already uses to build a DeckCard from a brand-new
// ScryfallCard. The physical copy's finish/condition/language, on the other
// hand, are taken as is from the deck card (getDeckCardFinish/etc.) — they
// are attributes of THAT copy, not Scryfall data to refresh. Return `true`
// only if a card was actually created/merged on the destination side — a
// failed Scryfall round trip (rate limit, network cut) leaves everything
// unchanged rather than build a half-filled card; move*ToList/move*ToWantlist
// below only remove the card from the deck IF this return is `true`, so as
// never to make a card vanish from the deck without it landing anywhere.

export async function copyDeckCardToList(this: MTGCollectionPlugin, 
	deckId: string,
	scryfallId: string,
	category: DeckCardCategory,
	targetListId: string
): Promise<boolean> {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return false;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId && getDeckCardCategory(c) === category);
	if (!card) return false;
	const finish = getDeckCardFinish(card);
	const language = getDeckCardLanguage(card);
	const condition = getDeckCardCondition(card);
	const existing = this.settings.collection.find(
		(c) =>
			c.scryfallId === scryfallId &&
			c.listId === targetListId &&
			c.finish === finish &&
			c.language === language &&
			c.condition === condition
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
		void this.saveSettings();
		return true;
	}
	const results = await fetchScryfallCollection([scryfallId]);
	const scry = results.get(scryfallId);
	if (!scry) return false;
	const now = Date.now();
	this.settings.collection.push({
		id: genId(),
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
		count: card.count,
		finish,
		language,
		condition,
		listId: targetListId,
		dateAdded: now,
		dateModified: now,
		borderColor: scry.border_color ?? "",
		frame: scry.frame ?? "",
		frameEffects: scry.frame_effects ?? [],
		oracleText: buildCardTextInfo(scry).oracleText,
	});
	void this.saveSettings();
	return true;
}


export async function moveDeckCardToList(this: MTGCollectionPlugin, 
	deckId: string,
	scryfallId: string,
	category: DeckCardCategory,
	targetListId: string
): Promise<void> {
	const copied = await this.copyDeckCardToList(deckId, scryfallId, category, targetListId);
	if (copied) this.removeDeckCard(deckId, scryfallId);
}

// See copyDeckCardToList above — same reasoning (Scryfall round trip,
// condition/language omitted as for
// copyCollectionCardToWantlist/copyWantlistCardToWantlist: a wantlist item
// has neither).

export async function copyDeckCardToWantlist(this: MTGCollectionPlugin, 
	deckId: string,
	scryfallId: string,
	category: DeckCardCategory,
	targetWantlistId: string
): Promise<boolean> {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return false;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId && getDeckCardCategory(c) === category);
	if (!card) return false;
	const finish = getDeckCardFinish(card);
	const existing = this.settings.wantlist.find(
		(c) => c.scryfallId === scryfallId && c.listId === targetWantlistId && c.finish === finish
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
		void this.saveSettings();
		return true;
	}
	const results = await fetchScryfallCollection([scryfallId]);
	const scry = results.get(scryfallId);
	if (!scry) return false;
	const now = Date.now();
	this.settings.wantlist.push({
		id: genId(),
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
		count: card.count,
		finish,
		listId: targetWantlistId,
		dateAdded: now,
		dateModified: now,
		borderColor: scry.border_color ?? "",
		frame: scry.frame ?? "",
		frameEffects: scry.frame_effects ?? [],
		oracleText: buildCardTextInfo(scry).oracleText,
	});
	void this.saveSettings();
	return true;
}


export async function moveDeckCardToWantlist(this: MTGCollectionPlugin, 
	deckId: string,
	scryfallId: string,
	category: DeckCardCategory,
	targetWantlistId: string
): Promise<void> {
	const copied = await this.copyDeckCardToWantlist(deckId, scryfallId, category, targetWantlistId);
	if (copied) this.removeDeckCard(deckId, scryfallId);
}

// Deck → deck, unlike the 2 pairs above: source AND destination are
// already DeckCards of identical shape, no Scryfall round trip needed —
// simple relocation, synchronous, never half done. `fromDeckId ===
// toDeckId` is an explicit no-op (defensive guard; CopyCardModal already
// excludes the source deck from its own gallery of destinations, see
// renderDecksTab): without it, `existing` would find the SOURCE card
// itself in the same array, double its counter then delete it — a loss of
// card, not a no-op.

export function copyDeckCardToDeck(this: MTGCollectionPlugin, fromDeckId: string, scryfallId: string, category: DeckCardCategory, toDeckId: string) {
	if (fromDeckId === toDeckId) return;
	const fromDeck = this.settings.decks.find((d) => d.id === fromDeckId);
	const toDeck = this.settings.decks.find((d) => d.id === toDeckId);
	if (!fromDeck || !toDeck) return;
	const card = fromDeck.cards.find((c) => c.scryfallId === scryfallId && getDeckCardCategory(c) === category);
	if (!card) return;
	// + Commander status (see isDeckCommander) on the destination merge — same
	// reasoning as mergeDeckDuplicates/changeDeckCardPrinting: category alone
	// is no longer enough to tell a Commander from an ordinary mainboard card
	// since both are "mainboard".
	const isCommanderCard = isDeckCommander(card);
	const existing = toDeck.cards.find(
		(c) => c.scryfallId === scryfallId && getDeckCardCategory(c) === category && isDeckCommander(c) === isCommanderCard
	);
	if (existing) {
		existing.count += card.count;
		existing.dateModified = Date.now();
	} else {
		const now = Date.now();
		toDeck.cards.push({ ...card, dateAdded: now, dateModified: now });
	}
	void this.saveSettings();
}


export function moveDeckCardToDeck(this: MTGCollectionPlugin, fromDeckId: string, scryfallId: string, category: DeckCardCategory, toDeckId: string) {
	if (fromDeckId === toDeckId) return;
	this.copyDeckCardToDeck(fromDeckId, scryfallId, category, toDeckId);
	this.removeDeckCard(fromDeckId, scryfallId);
}

// "Bulk" versions of the grouped actions: a single disk write for the
// whole batch, rather than a saveSettings() call per card.

export function bulkRemoveDeckCards(this: MTGCollectionPlugin, deckId: string, scryfallIds: string[]) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const idSet = new Set(scryfallIds);
	deck.cards = deck.cards.filter((c) => !idSet.has(c.scryfallId));
	void this.saveSettings();
}


export function bulkSetDeckCardCount(this: MTGCollectionPlugin, deckId: string, scryfallIds: string[], count: number) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const idSet = new Set(scryfallIds);
	const safeCount = Math.max(1, Math.floor(count) || 1);
	const now = Date.now();
	deck.cards.forEach((c) => {
		if (idSet.has(c.scryfallId)) {
			c.count = safeCount;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}

// "Bulk" equivalents of
// setDeckCardCondition/setDeckCardLanguage/setDeckCardFinish above — added
// when harmonizing My Decks' bulk-actions bar with My Collection's
// (2026-09-08, explicitly requested), once DeckCard actually had these 3
// fields (My Decks/My Collection harmonization, 2026-08-25). Same
// scryfallId-ONLY key per card (not scryfallId + category) as their
// card-by-card counterparts — same ambiguity already accepted for a card
// present twice under two different categories.

export function bulkSetDeckCardCondition(this: MTGCollectionPlugin, deckId: string, scryfallIds: string[], condition: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const idSet = new Set(scryfallIds);
	const now = Date.now();
	deck.cards.forEach((c) => {
		if (idSet.has(c.scryfallId)) {
			c.condition = condition;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}


export function bulkSetDeckCardLanguage(this: MTGCollectionPlugin, deckId: string, scryfallIds: string[], language: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const idSet = new Set(scryfallIds);
	const now = Date.now();
	deck.cards.forEach((c) => {
		if (idSet.has(c.scryfallId)) {
			c.language = language;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}


export function bulkSetDeckCardFinish(this: MTGCollectionPlugin, deckId: string, scryfallIds: string[], finish: Finish) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const idSet = new Set(scryfallIds);
	const now = Date.now();
	deck.cards.forEach((c) => {
		if (idSet.has(c.scryfallId)) {
			c.finish = finish;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}

// "Bulk" equivalents of setDeckCardCategory/setDeckCardFunction above —
// "Board"/"Function" added to My Decks' bulk-actions bar (2026-09-08,
// explicitly requested) once the 3 board tabs ("Category" renamed "Board"
// in DeckCardDetailModal) and a deck card's Function were already settable
// one by one. Same scryfallId-ONLY key per card as
// bulkSetDeckCardCondition/Language/Finish above — same ambiguity already
// accepted for a card present twice under two different categories.

export function bulkSetDeckCardCategory(this: MTGCollectionPlugin, deckId: string, scryfallIds: string[], category: DeckCardCategory) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const idSet = new Set(scryfallIds);
	const now = Date.now();
	deck.cards.forEach((c) => {
		if (idSet.has(c.scryfallId)) {
			c.category = category;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}

// functionOverride undefined = goes back to automatic detection for the
// whole selection (the picker always offers "Auto" at the top, same
// convention as setDeckCardFunction above for "empty field = no forced
// fallback").

export function bulkSetDeckCardFunction(this: MTGCollectionPlugin, deckId: string, scryfallIds: string[], functionOverride: string | undefined) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const idSet = new Set(scryfallIds);
	const now = Date.now();
	deck.cards.forEach((c) => {
		if (idSet.has(c.scryfallId)) {
			c.deckFunctionOverride = functionOverride;
			c.dateModified = now;
		}
	});
	void this.saveSettings();
}

// Import of an external decklist pasted in NewDeckModal
// (Moxfield/Archidekt/plain text) — parseDecklistText (decklist-import.ts,
// pure) already separates quantity/name/set/category for each line; this
// method resolves each name via Scryfall then adds to the deck.
// Line-by-line resolution via searchScryfall (same path as importCsv for
// its lines without Scryfall Id) rather than a batch by name on
// /cards/collection: a name alone isn't a reliable identifier for that
// endpoint (it arbitrarily picks a printing), whereas searchScryfall
// already accepts name+set+number and applies the same resolution logic as
// a normal search. Each call goes through requestScryfall, which already
// imposes a global spacing between Scryfall requests (see its own comment)
// — no need for an additional local pause here, unlike the old importCsv
// loop which predates this mechanism.
