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

// Renvoie l'entrée résultante (existante ou nouvellement créée) — utilisé
// par AddCardsModal pour transformer son bouton "Add" en stepper +/-
// juste après l'ajout, sans avoir à retrouver l'entrée à part.

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

// Voir undoAddToCollection (collection-mutations.ts) — même raisonnement, côté wantlist.
// addCardToWantlist ne dédoublonne que par scryfallId + listId + finish
// (pas language/condition, une wantlist item n'a jamais les deux), donc
// cette clé-ci est plus courte que sa contrepartie collection.

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

// Vide une wantlist (retire toutes ses cartes) sans la supprimer elle-même
// — même distinction/même raisonnement que clearList côté collection
// (WantlistSettingsModal, "Clear wantlist").

export function clearWantlist(this: MTGCollectionPlugin, wantlistId: string) {
	this.settings.wantlist = this.settings.wantlist.filter((c) => c.listId !== wantlistId);
	void this.saveSettings();
}

// Même principe que setListCoverCard (collection-mutations.ts), côté wantlist — voir
// Wantlist.coverCardId/resolveCoverImage (core/price.ts).

export function setWantlistCoverCard(this: MTGCollectionPlugin, wantlistId: string, cardId: string | undefined) {
	const wantlist = this.settings.wantlists.find((w) => w.id === wantlistId);
	if (!wantlist) return;
	wantlist.coverCardId = cardId;
	void this.saveSettings();
}

// Même principe que setListIcon (collection-mutations.ts), côté wantlist — voir
// Wantlist.listIcon (core/data-model.ts).

export function setWantlistIcon(this: MTGCollectionPlugin, wantlistId: string, icon: ListIcon | undefined) {
	const wantlist = this.settings.wantlists.find((w) => w.id === wantlistId);
	if (!wantlist) return;
	wantlist.listIcon = icon;
	void this.saveSettings();
}

// Version groupée de deleteWantlist ci-dessus — voir bulkDeleteLists.

export function bulkDeleteWantlists(this: MTGCollectionPlugin, wantlistIds: string[]) {
	const idSet = new Set(wantlistIds);
	this.settings.wantlists = this.settings.wantlists.filter((w) => !idSet.has(w.id));
	this.settings.wantlist = this.settings.wantlist.filter((c) => !idSet.has(c.listId));
	void this.saveSettings();
}

// Équivalent findListDuplicateGroups/mergeListDuplicateGroup (voir
// collection-mutations.ts) pour les wantlists — pas de fonctionnalité "Merge duplicate
// cards" dédiée existante ici, donc écrit directement plutôt que réutilisé.
// Clé de déduplication sans
// langue/condition : WantlistCard n'a ni l'un ni l'autre (une carte
// pas encore possédée n'a pas d'exemplaire physique à noter/classer),
// même asymétrie déjà établie ailleurs dans ce fichier.

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

// Fusionne tous les groupes de doublons stricts (findWantlistDuplicateGroups)
// d'UNE SEULE wantlist — même principe que mergeListDuplicates
// (collection-mutations.ts), côté wantlist (WantlistSettingsModal, "Merge duplicates").

export function mergeWantlistDuplicates(this: MTGCollectionPlugin, wantlistId: string): { merged: number; removed: number } {
	const groups = this.findWantlistDuplicateGroups().filter((g) => g[0].listId === wantlistId);
	let removed = 0;
	groups.forEach((g) => {
		removed += this.mergeWantlistDuplicateGroup(g).removed;
	});
	return { merged: groups.length, removed };
}

// "Merge" — mode sélection de la grille "My Wantlists" (voir
// MTGCollectionView.wantlistGallerySelectMode/MergeWantlistsModal). Même
// principe que mergeLists (collection-mutations.ts), côté wantlist.

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

// Copie une carte de wantlist vers une autre wantlist (ou la même) sans
// retirer l'original — même exclusion de soi-même que copyCollectionCardToList, pour
// qu'une copie dans sa propre wantlist crée un doublon volontaire.

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

// Déplace une carte de wantlist vers une autre wantlist : réutilise
// copyWantlistCardToWantlist puis retire l'original par son propre id (la
// nouvelle/fusionnée entrée a toujours un id différent, voir ci-dessus).

export function moveWantlistCardToWantlist(this: MTGCollectionPlugin, cardId: string, targetWantlistId: string) {
	this.copyWantlistCardToWantlist(cardId, targetWantlistId);
	this.settings.wantlist = this.settings.wantlist.filter((c) => c.id !== cardId);
	void this.saveSettings();
}

// Copie une carte de wantlist vers My Collection, sans la retirer de la
// wantlist (contrairement à "Mark as acquired") : condition/langue ne sont
// pas connues pour une carte pas encore possédée, donc réglées à "" pour
// les deux (aucune valeur choisie — voir getCondition/getLanguage,
// types.ts, qui décrivent ce repli comme "None" sans qu'il apparaisse
// comme choix dans un picker) plutôt que de rouvrir un second dialogue —
// l'utilisateur peut les ajuster ensuite sur la carte.

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

// Même logique de fusion que copyCollectionCardToList, pour la wantlist.

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

// "Marquer comme acquise" : retire la carte de la wantlist et l'ajoute (ou
// fusionne, si une entrée identique existe déjà) à My Collection, avec la
// condition/langue choisies au moment du transfert (la wantlist ne les
// suit pas) et le foil déjà connu depuis la wantlist.

export function moveWantlistCardToCollection(this: MTGCollectionPlugin, 
	wantlistCardId: string,
	targetListId: string,
	condition: string,
	language: string
) {
	this.moveWantlistCardToCollectionNoSave(wantlistCardId, targetListId, condition, language);
	void this.saveSettings();
}

// Version "bulk" : déplace plusieurs cartes de wantlist en une seule
// sauvegarde, plutôt que d'appeler moveWantlistCardToCollection en boucle
// (ce qui déclencherait autant d'écritures sur disque que de cartes).

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

// `format` : une clé LEGALITY_SEARCH_FORMATS (card-search.ts, ex.
// "commander") choisie dans NewDeckModal, ou undefined ("None") — voir
// Deck.format (data-model.ts) pour le raisonnement complet.
