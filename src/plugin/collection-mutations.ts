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

// Les cartes ajoutées avant l'introduction du groupement/tri (artiste,
// couleurs, valeur de mana, date de sortie) n'ont pas ces informations :
// on les récupère en une poignée de requêtes groupées auprès de Scryfall.

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
	// Le minimum est 1 : pour retirer complètement une carte de la collection,
	// on utilise le bouton de suppression plutôt que de descendre à 0.
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

// Annule `delta` exemplaires ajoutés depuis "Add cards" (voir le panneau
// "Add history" de AddCardsModal, onUndoAdd dans shared-search-ui.ts) —
// retrouve la ligne par la MÊME clé de dédoublonnage qu'addCardToCollection
// utilise déjà pour FUSIONNER un ajout (scryfallId + listId + finish/
// language/condition), plutôt qu'un id de ligne qui pourrait devenir
// invalide entre un "disable" (qui peut supprimer la ligne) et un
// "re-enable" ultérieur. changeCollectionCardCount() ne convient pas ici : il plafonne
// à 1, jamais 0, alors qu'annuler la toute première contribution doit
// pouvoir retirer la ligne entièrement (voir le calcul ci-dessous, qui
// décide lui-même décrément vs suppression selon le solde restant — un
// ajustement +/- fait entretemps sur la même ligne, via le stepper de la
// tuile carrousel ou depuis My Collection, reste donc intact : seul ce
// que CETTE session a contribué est repris, jamais le compte réel
// d'origine). Renvoie la ligne résultante (ou undefined si supprimée)
// pour que AddCardsModal puisse resynchroniser sa propre tuile carrousel
// sur l'état réel.

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

// Séparée de setCollectionCardGrading : la boîte "Custom Price" s'édite maintenant en
// ligne (pas via GradingModal, qui ne concerne plus que le grading),
// donc son propre appel plugin ne doit pas pouvoir écraser gradingCompany/
// gradingGrade en passant des valeurs par défaut.

export function setCollectionCardCustomPrice(this: MTGCollectionPlugin, rowId: string, customPrice: string) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.customPrice = customPrice.trim() ? customPrice.trim() : undefined;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// Définit directement la quantité (plutôt que par incrément), pour l'édition
// en ligne du chiffre. Minimum 1, comme changeCollectionCardCount.

export function setCollectionCardCount(this: MTGCollectionPlugin, rowId: string, newCount: number, onDone: () => void) {
	const card = this.settings.collection.find((c) => c.id === rowId);
	if (!card) return;
	card.count = Math.max(1, Math.floor(newCount) || 1);
	card.dateModified = Date.now();
	void this.saveSettings();
	onDone();
}

// Change l'impression (édition/numéro/prix/rareté...) d'une carte déjà en
// collection, en gardant la quantité/foil/langue/état/liste inchangés.

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


// Repère les entrées strictement identiques (même carte Scryfall, même
// liste, même statut foil, même langue, même état) sans rien modifier —
// voir mergeListDuplicateGroup pour la fusion elle-même. Peut arriver par ex.
// après un changement d'édition qui fait converger deux cartes vers la
// même impression exacte au sein d'une même liste. Chaque groupe retourné
// est trié par date d'ajout (la plus ancienne en premier, celle que
// mergeListDuplicateGroup conservera).

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

// Fusionne un groupe précis (déjà identifié par findListDuplicateGroups) :
// les quantités sont additionnées dans l'entrée la plus ancienne (le
// premier élément du groupe), les autres sont supprimées.

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

// Fusionne tous les groupes de doublons stricts (findListDuplicateGroups)
// d'UNE SEULE liste — même calcul que mergeLists plus haut (qui l'applique
// déjà, scopé à la liste fusionnée), juste exposé ici comme sa propre
// action pour une liste déjà existante depuis ListSettingsModal ("Merge
// duplicates") : agit immédiatement, sans écran de revue groupe par
// groupe, cohérent avec le reste de cette fenêtre, où chaque bouton agit
// tout de suite plutôt que d'ouvrir un second écran.

export function mergeListDuplicates(this: MTGCollectionPlugin, listId: string): { merged: number; removed: number } {
	const groups = this.findListDuplicateGroups().filter((g) => g[0].listId === listId);
	let removed = 0;
	groups.forEach((g) => {
		removed += this.mergeListDuplicateGroup(g).removed;
	});
	return { merged: groups.length, removed };
}

// Anti-spam léger contre les clics répétés/accidentels sur "Refresh now" :
// n'empêche pas une vérification ponctuelle légitime (contrairement au
// délai configuré dans les réglages, qui régit uniquement la vérification
// automatique en arrière-plan).

// Redemande à Scryfall le prix actuel de chaque impression distincte de la
// collection ET de la wantlist, en requêtes groupées (75 par lot, léger
// délai entre chaque — voir fetchScryfallCollection). Un identifiant présent
// dans les deux n'est demandé qu'une fois (uniqueIds dédoublonne sur les
// deux ensembles combinés). Une seule écriture sur disque à la fin, pas une
// par carte.

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

// isInbox : jamais supprimable, même par cet appel direct — l'interface
// (ListSettingsModal) n'affiche déjà plus de bouton "Delete" pour Inbox,
// mais ce garde-fou reste ici en défense en profondeur pour tout futur
// appelant qui l'invoquerait directement.

export function deleteList(this: MTGCollectionPlugin, listId: string) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (list?.isInbox) return;
	this.settings.lists = this.settings.lists.filter((l) => l.id !== listId);
	this.settings.collection = this.settings.collection.filter(
		(c) => c.listId !== listId
	);
	void this.saveSettings();
}

// Vide une liste (retire toutes ses cartes) sans supprimer la liste
// elle-même, contrairement à deleteList juste au-dessus qui supprime les
// deux à la fois — action de "nettoyage" distincte, demandée
// explicitement depuis ListSettingsModal ("Vider la liste").

export function clearList(this: MTGCollectionPlugin, listId: string) {
	this.settings.collection = this.settings.collection.filter(
		(c) => c.listId !== listId
	);
	void this.saveSettings();
}

// Fixe (ou efface, cardId undefined) l'image de couverture d'une liste —
// voir CollectionList.coverCardId/resolveCoverImage (core/price.ts) pour
// la résolution côté affichage. Ne valide pas que cardId appartient
// bien à cette liste : ListSettingsModal ne propose que des cartes de la
// liste elle-même, et resolveCoverImage retombe silencieusement sur le
// choix automatique si l'id ne correspond plus à rien de toute façon.

export function setListCoverCard(this: MTGCollectionPlugin, listId: string, cardId: string | undefined) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (!list) return;
	list.coverCardId = cardId;
	void this.saveSettings();
}

// Fixe (ou efface, icon undefined) le pictogramme d'une liste — voir
// CollectionList.listIcon (core/data-model.ts) pour la résolution côté
// affichage (renderListTile/CopyCardModal.renderTile).

export function setListIcon(this: MTGCollectionPlugin, listId: string, icon: ListIcon | undefined) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (!list) return;
	list.listIcon = icon;
	void this.saveSettings();
}

// Version groupée de deleteList ci-dessus — mode sélection de la grille
// "My Collection" (MTGCollectionView.listGallerySelectMode), une seule
// écriture de settings pour tous les ids plutôt qu'un appel par liste.
// Inbox n'est déjà jamais sélectionnable dans cette grille (voir
// renderListTile), mais retirée ici aussi pour la même raison que
// deleteList ci-dessus.

export function bulkDeleteLists(this: MTGCollectionPlugin, listIds: string[]) {
	const inboxId = this.settings.lists.find((l) => l.isInbox)?.id;
	const idSet = new Set(listIds.filter((id) => id !== inboxId));
	this.settings.lists = this.settings.lists.filter((l) => !idSet.has(l.id));
	this.settings.collection = this.settings.collection.filter((c) => !idSet.has(c.listId));
	void this.saveSettings();
}

// "Merge" — mode sélection de la grille "My Collection" (voir
// MTGCollectionView.listGallerySelectMode/MergeListsModal). Crée une
// nouvelle liste, y réaffecte toutes les cartes des listes sélectionnées
// (simple changement de listId, pas une copie — les CollectionCard existants
// sont conservés tels quels, avec leur id/finish/langue/condition/
// grading/prix personnalisé), supprime les listes d'origine, puis fusionne
// automatiquement les doublons désormais dans la même liste (même carte
// présente dans plusieurs des listes fusionnées, même finish/langue/
// condition) en réutilisant telle quelle la logique déjà établie de
// findListDuplicateGroups/mergeListDuplicateGroup ("Merge duplicate cards") —
// plutôt qu'une réimplémentation, puisque c'est exactement le même calcul
// une fois que les cartes partagent le même listId.

export function mergeLists(this: MTGCollectionPlugin, listIds: string[], name: string): CollectionList {
	const newList = this.createListSilent(name);
	// Inbox n'est déjà jamais sélectionnable dans la grille (voir
	// renderListTile), donc jamais réellement présente dans listIds en
	// pratique — retirée quand même par défense en profondeur, puisque
	// mergeLists SUPPRIME chaque liste d'origine une fois ses cartes
	// réaffectées (voir plus bas), ce qui violerait la protection contre
	// la suppression d'Inbox si jamais atteint par un autre chemin.
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

// isInbox : jamais renommable — même garde-fou/raisonnement que
// deleteList ci-dessus (l'UI ne montre déjà plus le champ de
// renommage pour Inbox, ceci reste une défense en profondeur).

export function renameList(this: MTGCollectionPlugin, listId: string, name: string) {
	const list = this.settings.lists.find((l) => l.id === listId);
	if (!list || list.isInbox) return;
	list.name = name;
	void this.saveSettings();
}

// Copie une carte de la collection vers une autre liste (ou la même) sans
// retirer l'original — contrairement à moveCollectionCardToList qui déplace.
// c.id !== card.id exclut l'entrée elle-même d'une fusion sur elle-même :
// copier dans sa propre liste crée un doublon volontaire
// plutôt que de simplement doubler sa quantité en place.

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

// Copie une carte de la collection vers une wantlist : la condition/langue
// n'ont pas de sens pour une carte désirée (voir WantlistCard), donc
// simplement omises plutôt que reportées.

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

// Déplace (plutôt que copie) une carte de la collection vers une autre
// liste : réutilise copyCollectionCardToList pour la logique de fusion/création côté
// destination, puis retire l'original.

export function moveCollectionCardToList(this: MTGCollectionPlugin, cardId: string, targetListId: string) {
	this.copyCollectionCardToList(cardId, targetListId);
	this.removeCollectionCard(cardId);
}


export function moveCollectionCardToWantlist(this: MTGCollectionPlugin, cardId: string, targetWantlistId: string) {
	this.copyCollectionCardToWantlist(cardId, targetWantlistId);
	this.removeCollectionCard(cardId);
}

/* ----------------------------- Wantlists ------------------------------ */

// Renvoie l'entrée résultante (existante ou nouvellement créée) — même
// raison que le retour ajouté à addCardToCollection ci-dessus.
