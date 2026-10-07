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

// Même principe que changeCollectionCardPrinting (collection-mutations.ts)/
// changeWantlistCardPrinting (wantlist-mutations.ts), pour une carte de
// deck — DeckCard n'a simplement pas de champ id propre (voir "Data model
// notes" dans CLAUDE.md), la ligne se retrouve donc par scryfallId +
// catégorie plutôt que par id, la même clé d'unicité déjà utilisée
// ailleurs pour un deck (voir addCardToDeck/importDecklistToDeck). Aucun
// champ date de sortie ici (DeckCard n'en persiste toujours aucun,
// contrairement à CollectionCard/WantlistCard — le prix, lui, est mis à
// jour ci-dessous depuis le 2026-09-02) ;
// count/category/dateAdded/owned/finish/language/condition/grading/
// customPrice restent inchangés (un changement d'impression ne change pas
// l'exemplaire physique lui-même), seuls les champs dérivés de
// l'impression Scryfall elle-même bougent.

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
	// Une autre ligne de ce même deck (même catégorie ET même statut
	// Commander — voir isDeckCommander, data-model.ts, pour pourquoi
	// category seule ne suffit plus) pointe déjà vers l'impression
	// choisie — fusionne au lieu de dupliquer, même raisonnement que
	// partout ailleurs qu'un deck fusionne par cette clé plutôt que
	// d'accumuler deux lignes pour la même carte.
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

// Modifiable après coup depuis DeckSettingsModal — un format choisi à la
// création n'est pas figé pour toujours, même logique que renameDeck
// juste au-dessus.

export function setDeckFormat(this: MTGCollectionPlugin, deckId: string, format: string | undefined) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.format = format;
	void this.saveSettings();
}

// Vide un deck (retire toutes ses cartes) sans le supprimer — même
// raisonnement/couple avec deleteDeck que clearList/deleteList côté liste
// (voir clearList, collection-mutations.ts).

export function clearDeck(this: MTGCollectionPlugin, deckId: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.cards = [];
	void this.saveSettings();
}

// Fixe (ou efface, scryfallId undefined) l'image de couverture d'un deck —
// voir Deck.coverCardId/resolveDeckCoverImage (core/price.ts). Identifié
// par scryfallId plutôt que par id comme setListCoverCard : DeckCard n'a
// pas de champ id propre (voir "Data model notes" dans CLAUDE.md).

export function setDeckCoverCard(this: MTGCollectionPlugin, deckId: string, scryfallId: string | undefined) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	deck.coverCardId = scryfallId;
	void this.saveSettings();
}

// Fixe (ou efface, icon undefined) le pictogramme d'un deck — voir
// Deck.deckIcon (core/data-model.ts) pour la résolution côté affichage
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

// Version groupée de deleteDeck ci-dessus — voir bulkDeleteLists.

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
		// Une copie reprend le format du deck source — c'est bien le même
		// deck, cartes ET format, juste dupliqué (voir Deck.format).
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

// Fusionne les doublons stricts d'UN SEUL deck — DeckCard n'a pas de champ
// id propre (voir "Data model notes" dans CLAUDE.md), donc retrouvés par
// scryfallId + catégorie + statut Commander plutôt que par id comme
// findListDuplicateGroups/mergeListDuplicateGroup (collection-mutations.ts) ou
// findWantlistDuplicateGroups/mergeWantlistDuplicateGroup
// (wantlist-mutations.ts) — même clé d'identité déjà établie ailleurs pour les decks
// (addCardToDeck à l'ajout, changeDeckCardPrinting, l'import de
// decklist), PAS la clé plus étroite scryfallId seul qu'utilisent
// changeDeckCardCount/removeDeckCard/undoAddToDeck (voir leur propre
// commentaire) : deux entrées au même scryfallId+catégorie mais l'une
// Commander et l'autre non (une carte Background comptée à la fois comme
// Commander et comme mainboard ordinaire, par exemple — voir
// isDeckCommander) ne sont PAS des doublons.
// Écrit directement plutôt que factorisé en findDeckDuplicateGroups/
// mergeDeckDuplicateGroup séparés (comme côté collection/wantlist) :
// aucun écran de revue groupe par groupe n'est demandé ici, juste une
// action immédiate depuis DeckSettingsModal — pas de second appelant qui
// aurait besoin de la sélection sans l'application.

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

// "Merge decks" (DeckSettingsModal, sur le modèle de mergeLists
// (collection-mutations.ts)/mergeWantlists (wantlist-mutations.ts)) — crée un nouveau deck, y copie toutes les
// cartes des decks sélectionnés (copie, pas une réaffectation comme
// mergeLists : contrairement à CollectionCard, une DeckCard n'a pas de champ
// listId à réaffecter, elle vit directement dans Deck.cards), supprime
// les decks d'origine, puis fusionne les doublons désormais dans le même
// deck en réutilisant mergeDeckDuplicates ci-dessus.

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

// Renvoie la ligne résultante (nouvelle ou fusionnée) — même convention
// que addCardToCollection/addCardToWantlist, jusque-là seule cette
// méthode-ci renvoyait void. Nécessaire pour que le flux "Add cards" du
// Deck puisse s'harmoniser avec Collection/Wantlist (voir le call site
// dans view.ts, onAdd) : AddCardsModalOptions.onAdd attend { id,
// count, listId } pour transformer le bouton "Add" en stepper — DeckCard
// n'a pas de champ id propre (voir data-model.ts), donc le call site
// utilise scryfallId à sa place, la même clé que changeDeckCardCount/
// removeDeckCard/undoAddToDeck utilisent déjà pour retrouver une ligne
// dans deck.cards.

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

// Copie une carte déjà présente dans la collection (une "List") vers un deck.
// Une carte ainsi ajoutée est possédée par définition : si elle fusionne
// avec une entrée existante venue d'une wantlist (owned: false), celle-ci
// passe à "possédée" — on a maintenant au moins un exemplaire réel.

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
			// Voir DeckSourceCard.finish/condition/language — reprend
			// l'exemplaire physique réel qu'on copie (une CollectionCard a les
			// trois), plutôt que le repli "Regular"/aucune par défaut
			// d'une carte de deck vraiment nouvelle (voir addCardToDeck).
			finish: card.finish,
			condition: card.condition,
			language: card.language,
			// Voir DeckSourceCard.priceUsd/etc. — même raisonnement, prix
			// déjà connu de la carte source plutôt qu'un "pas encore su"
			// en attendant backfillDeckCardPrices().
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

// Ajoute une carte pas encore possédée (depuis une wantlist) à un deck.
// Contrairement à addCollectionCardToDeck, une fusion avec une entrée déjà
// possédée ne la rétrograde pas : owned ne descend jamais, seulement monte.

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
			// Voir addCollectionCardToDeck — même raisonnement, mais
			// condition/language restent absents : une WantlistCard
			// n'a ni l'un ni l'autre (pas encore possédée), même
			// asymétrie déjà établie ailleurs pour ce type de carte.
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

// Harmonisation My Decks/My Collection (2026-08-25) — équivalents de
// setCollectionCardFinish/setCollectionCardCondition/setCollectionCardLanguage/setCollectionCardGrading/
// setCollectionCardCustomPrice (collection-mutations.ts), pour une carte de deck. Retrouvent leur
// ligne par scryfallId SEUL, comme changeDeckCardCount/removeDeckCard/
// undoAddToDeck ci-dessus/ci-dessous — pas par scryfallId + catégorie
// comme changeDeckCardPrinting : ce sont les mêmes deux conventions déjà
// établies pour un deck (voir leurs propres commentaires), pas une
// nouvelle divergence introduite ici. Une même carte présente deux fois
// dans un deck sous deux catégories différentes (ex. mainboard ET
// sideboard), ou une fois en Commander et une fois hors Commander (ex.
// import decklist avec un Background compté séparément — voir
// isDeckCommander), reste donc ambiguë pour ces 5 méthodes — une
// limitation déjà acceptée pour changeDeckCardCount/removeDeckCard/
// undoAddToDeck, pas propre à finish/condition/langue/grading/prix perso.

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

// Boîte "Board" de DeckCardDetailModal (2026-09-06 sous le nom
// "Category", renommée "Board" le 2026-09-08 — voir DeckCardCategory
// pour pourquoi Commander n'en fait plus partie) — correction manuelle
// de DeckCard.category (Mainboard/Sideboard/Maybeboard), même ambiguïté
// acceptée pour une carte présente deux fois sous deux catégories
// différentes que les 5 méthodes ci-dessus (voir leur commentaire) : la
// première ligne correspondante l'emporte.

export function setDeckCardCategory(this: MTGCollectionPlugin, deckId: string, scryfallId: string, category: DeckCardCategory) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.category = category;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// "Group by Function" (2026-09-02) — correction manuelle d'une détection
// automatique erronée/absente (voir DeckCard.deckFunctionOverride, "Group
// by Function"/vue Stacks, view.ts). `undefined` = revient à la
// détection automatique (le picker propose "Auto (…)" pour ça, voir
// DeckCardDetailModal), même convention que setDeckCardCustomPrice pour
// "champ vide = pas de repli forcé".

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

// Voir setCollectionCardCustomPrice (collection-mutations.ts) — même raison d'être séparée de
// setDeckCardGrading.

export function setDeckCardCustomPrice(this: MTGCollectionPlugin, deckId: string, scryfallId: string, customPrice: string) {
	const deck = this.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	card.customPrice = customPrice.trim() ? customPrice.trim() : undefined;
	card.dateModified = Date.now();
	void this.saveSettings();
}

// Voir undoAddToCollection (collection-mutations.ts)/undoAddToWantlist
// (wantlist-mutations.ts) — même
// raisonnement, côté deck, pour le panneau "Add history" de la fenêtre
// "Add cards" (uniformisation demandée explicitement avec Collection/
// Wantlist). Clé de dédoublonnage plus courte que ses 2 homologues :
// addCardToDeck ne fusionne que par scryfallId, jamais par finish/
// language/condition (contrairement à undoAddToCollection/
// undoAddToWantlist) — DeckCard porte bien ces 3 champs depuis
// l'harmonisation My Decks/My Collection (2026-08-25), mais un deck ne
// distingue toujours qu'UNE ligne par carte (voir addCardToDeck), pas une
// par combinaison finish/langue/condition comme Collection/Wantlist —
// pas besoin d'un 2ᵉ paramètre "options" ici.

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

// "Move card" depuis la boîte "Deck" du panneau de détail (harmonisation
// avec la boîte "List"/"Wantlist" de CardDetailModal/
// WantlistCardDetailModal, 2026-08-25, demandée explicitement) — 3
// destinations possibles (List/Deck/Wantlist), voir CopyCardModal
// (sourceKind === "deck"). DeckCard n'a toujours aucun champ releasedAt
// (voir "Data model notes" dans CLAUDE.md — le prix, lui, EST en cache
// depuis le 2026-09-02, mais pas ce champ-là), contrairement à
// copyCollectionCardToList/copyWantlistCardToList qui peuvent réutiliser tels
// quels les champs déjà présents sur leur carte source — copyDeckCard-
// ToList/copyDeckCardToWantlist ci-dessous ont donc toujours besoin d'un
// aller-retour Scryfall frais, même fonction (fetchScryfallCollection)
// qu'addCardToDeck utilise déjà pour construire une DeckCard depuis un
// ScryfallCard tout neuf. finish/condition/langue de l'exemplaire
// physique sont en revanche repris tels quels depuis la carte de deck
// (getDeckCardFinish/etc.) — ce sont des attributs de CET exemplaire,
// pas des données Scryfall à rafraîchir. Renvoient `true` seulement si
// une carte a réellement été créée/fusionnée côté destination — un
// aller-retour Scryfall raté (limite de requêtes, coupure réseau) laisse
// tout inchangé plutôt que de construire une carte à moitié remplie ;
// move*ToList/move*ToWantlist ci-dessous ne retirent la carte du deck
// QUE si ce retour vaut `true`, pour ne jamais faire disparaître une
// carte du deck sans qu'elle atterrisse nulle part.

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

// Voir copyDeckCardToList ci-dessus — même raisonnement (aller-retour
// Scryfall, condition/langue omises comme pour copyCollectionCardToWantlist/
// copyWantlistCardToWantlist : une wantlist item n'a ni l'une ni
// l'autre).

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

// Deck → deck, contrairement aux 2 paires ci-dessus : source ET
// destination sont déjà des DeckCard de forme identique, aucun aller-
// retour Scryfall nécessaire — simple relocalisation, synchrone, jamais
// à moitié faite. `fromDeckId === toDeckId` est un no-op explicite
// (garde défensive ; CopyCardModal exclut déjà le deck source de sa
// propre galerie de destinations, voir renderDecksTab) : sans elle,
// `existing` retrouverait la carte SOURCE elle-même dans le même
// tableau, doublerait son compteur puis la supprimerait — une perte de
// carte, pas un no-op.

export function copyDeckCardToDeck(this: MTGCollectionPlugin, fromDeckId: string, scryfallId: string, category: DeckCardCategory, toDeckId: string) {
	if (fromDeckId === toDeckId) return;
	const fromDeck = this.settings.decks.find((d) => d.id === fromDeckId);
	const toDeck = this.settings.decks.find((d) => d.id === toDeckId);
	if (!fromDeck || !toDeck) return;
	const card = fromDeck.cards.find((c) => c.scryfallId === scryfallId && getDeckCardCategory(c) === category);
	if (!card) return;
	// + statut Commander (voir isDeckCommander) sur la fusion destination
	// — même raisonnement que mergeDeckDuplicates/changeDeckCardPrinting :
	// category seule ne suffit plus à distinguer un Commander d'une carte
	// mainboard ordinaire depuis que les deux valent "mainboard".
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

// Versions "en masse" des actions groupées : une seule écriture sur disque
// pour tout le lot, plutôt qu'un appel à saveSettings() par carte.

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

// Équivalents "en masse" de setDeckCardCondition/setDeckCardLanguage/
// setDeckCardFinish ci-dessus — ajoutés lors de l'harmonisation de la
// barre d'actions groupées de My Decks avec celle de My Collection
// (2026-09-08, demandée explicitement), une fois DeckCard réellement doté
// de ces 3 champs (harmonisation My Decks/My Collection, 2026-08-25).
// Même clé scryfallId SEUL par carte (pas scryfallId + catégorie) que
// leurs homologues carte-par-carte — même ambiguïté déjà acceptée pour une
// carte présente deux fois sous deux catégories différentes.

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

// Équivalents "en masse" de setDeckCardCategory/setDeckCardFunction
// ci-dessus — "Board"/"Function" ajoutés à la barre d'actions groupées de
// My Decks (2026-09-08, demandé explicitement) une fois les 3 onglets de
// board ("Category" renommé "Board" dans DeckCardDetailModal) et la
// Function d'une carte de deck déjà réglables une par une. Même clé
// scryfallId SEUL par carte que bulkSetDeckCardCondition/Language/Finish
// ci-dessus — même ambiguïté déjà acceptée pour une carte présente deux
// fois sous deux catégories différentes.

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

// functionOverride undefined = revient à la détection automatique pour
// toute la sélection (le picker propose toujours "Auto" en tête, même
// convention que setDeckCardFunction ci-dessus pour "champ vide = pas de
// repli forcé").

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

// Import de decklist externe collée dans NewDeckModal (Moxfield/Archidekt/
// texte brut) — parseDecklistText (decklist-import.ts, pur) sépare déjà
// quantité/nom/édition/catégorie pour chaque ligne ; cette méthode résout
// chaque nom via Scryfall puis ajoute au deck. Résolution ligne par
// ligne via searchScryfall (même chemin qu'importCsv pour ses lignes sans
// Scryfall Id) plutôt qu'un lot par nom sur /cards/collection : un nom
// seul n'est pas un identifiant fiable pour ce point d'accès (il choisit
// arbitrairement une impression), alors que searchScryfall accepte déjà
// nom+édition+numéro et applique la même logique de résolution qu'une
// recherche normale. Chaque appel passe par requestScryfall, qui impose
// déjà un espacement global entre requêtes Scryfall (voir son propre
// commentaire) — pas besoin d'une pause locale supplémentaire ici, à la
// différence de l'ancienne boucle d'importCsv qui prédate ce mécanisme.
