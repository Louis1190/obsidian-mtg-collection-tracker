import { detectDeckCardFunction, deckFunctionSortKey } from "./deck-function";

/* -------------------------------------------------------------------------- */
/*  Group by / Sort by                                                        */
/* -------------------------------------------------------------------------- */

// "stacks" (2026-09-02) — vue "piles de cartes" façon Archidekt, My Decks
// uniquement (voir renderDeckStacksView, view.ts) : une colonne par groupe,
// cartes empilées avec chevauchement plutôt qu'une ligne/tuile par carte.
// Le type reste commun aux trois sections (comme les 4 valeurs existantes)
// même si ce mode n'est jamais proposé pour list/wantlist — même raison que
// pour CardViewMode lui-même : un 2e type juste pour une valeur en plus
// aurait été plus de mécanique que la garde par scope qu'il remplace.
export type CardViewMode = "list" | "grid" | "table" | "card" | "stacks";

// Sur téléphone, seuls List et Card sont proposés (le CSS masque les boutons
// Grid/Table/Stacks, voir `.is-phone .mtg-view-toggle` dans styles.css) — mais
// collectionViewMode/deckViewMode/wantlistViewMode sont UN réglage synchronisé
// entre appareils (data.json) : un "grid" posé sur le Mac, ou sur le téléphone
// avant cette restriction, s'appliquait quand même au rendu, sans aucun bouton
// actif dans la barre. On ne réécrit PAS le réglage (la préférence Mac/iPad
// survit à une visite sur téléphone) : seul l'affichage retombe sur "list".
export const PHONE_VIEW_MODES: readonly CardViewMode[] = ["list", "card"];

export function effectiveViewMode(mode: CardViewMode, isPhone: boolean): CardViewMode {
	return isPhone && !PHONE_VIEW_MODES.includes(mode) ? "list" : mode;
}

// Lu à chaque rendu (pas figé au chargement) : `.is-phone` est une classe de
// <body> qu'Obsidian bascule en direct au redimensionnement, comme le CSS qui
// masque les boutons — les deux restent ainsi d'accord.
export function phoneAwareViewMode(mode: CardViewMode): CardViewMode {
	return effectiveViewMode(mode, document.body.classList.contains("is-phone"));
}

export function viewModeClass(mode: CardViewMode, scope: "list" | "deck" | "wantlist"): string {
	if (mode === "grid") return " mtg-collection-list-grid";
	if (mode === "card") return " mtg-collection-list-cards";
	// Vue "stacks" : pas de grille de tuiles de taille égale ni de lignes
	// empilées verticalement (.mtg-card-row-outer) — renderDeckStacksView
	// construit sa propre structure de colonnes directement, cette classe ne
	// sert qu'à cadrer le style CSS du conteneur (.mtg-deck-stacks).
	if (mode === "stacks") return " mtg-collection-list-stacks";
	if (mode === "table") {
		if (scope === "deck") return " mtg-collection-list-table mtg-collection-list-table-deck";
		if (scope === "wantlist") return " mtg-collection-list-table mtg-collection-list-table-wantlist";
		return " mtg-collection-list-table mtg-collection-list-table-collection";
	}
	return "";
}

// Intitulés de colonnes affichés en mode Tableau, selon le contexte. "Mana
// Value" juste après "Name" (ordre de lecture le plus naturel — le coût
// d'une carte se lit traditionnellement juste après son nom) : cet ordre de
// colonnes DOIT rester synchronisé avec l'ordre dans lequel chaque
// buildCollectionCardRow/buildDeckCardRow/buildWantlistCardRow insère ses cellules dans le DOM
// (voir le commentaire sur .mtg-collection-list-table dans styles.css — sans
// grid-column explicite, l'ordre visuel des cellules suit l'ordre du DOM).
export const TABLE_COLUMNS_COLLECTION = [
	"Name",
	"Mana value",
	"Set",
	"Number",
	"Language",
	"Condition",
	"Qty",
	"Price",
];
// "Legality" (le point coloré, voir deckLegalityBadge dans card-search.ts et
// la colonne dédiée de buildDeckCardRow, view.ts) n'existe QUE pour Deck — un
// deck a un format déclaré (Deck.format), pas une liste ni une wantlist,
// donc pas de colonne équivalente pour TABLE_COLUMNS_COLLECTION/_WANTLIST.
// "Language"/"Condition" — harmonisation My Decks/My Collection (2026-08-25) :
// DeckCard porte maintenant les mêmes champs (voir data-model.ts), mêmes 2
// colonnes que TABLE_COLUMNS_COLLECTION, au même endroit dans l'ordre
// (juste après "Number").
export const TABLE_COLUMNS_DECK = [
	"Name",
	"Mana value",
	"Set",
	"Number",
	"Language",
	"Condition",
	"Qty",
	"Legality",
	"Price",
];
export const TABLE_COLUMNS_WANTLIST = ["Name", "Mana value", "Set", "Number", "Qty", "Price"];

export type GroupByOption =
	| "none"
	| "artist"
	| "color"
	| "dateAdded"
	// My Decks uniquement (voir DECK_GROUP_BY_OPTIONS ci-dessous) : "fonction"
	// de la carte dans le deck (Ramp/Removal/Draw/Tokens/etc.), détectée
	// automatiquement depuis oracleText/keywords (detectDeckCardFunction,
	// ./deck-function) — voir SortableCard plus bas pour les champs requis.
	| "function"
	| "manaValue"
	| "name"
	| "quantity"
	| "rarity"
	| "set"
	| "type";

export type SortByOption =
	| "artist"
	| "collectorNumber"
	| "color"
	| "dateAdded"
	| "dateModified"
	| "listName"
	| "manaValue"
	| "name"
	| "price"
	| "quantity"
	| "rarity"
	| "releasedAt"
	| "set"
	| "type";

export const GROUP_BY_OPTIONS: { value: GroupByOption; label: string }[] = [
	{ value: "none", label: "Don't group" },
	{ value: "artist", label: "Artist" },
	{ value: "color", label: "Color" },
	{ value: "dateAdded", label: "Creation date" },
	{ value: "manaValue", label: "Mana value" },
	{ value: "name", label: "Name" },
	{ value: "quantity", label: "Quantity" },
	{ value: "rarity", label: "Rarity" },
	{ value: "set", label: "Set" },
	{ value: "type", label: "Type" },
];

// My Decks uniquement — GROUP_BY_OPTIONS + "Function", juste après "Don't
// Group". Portait aussi "Category" (Commander/Mainboard/Sideboard/
// Maybeboard) jusqu'au 2026-09-07 : retiré sur demande explicite ("Commander
// n'est pas une catégorie") au profit des onglets de board (DeckBoardTab,
// data-model.ts, voir renderDeckBoardTabs dans view.ts) — le seul
// regroupement encore propre aux decks est donc "Function" désormais. List/
// Wantlist gardent GROUP_BY_OPTIONS tel quel (renderGroupSortBar choisit
// entre les deux selon `scope`).
export const DECK_GROUP_BY_OPTIONS: { value: GroupByOption; label: string }[] = [
	GROUP_BY_OPTIONS[0],
	{ value: "function", label: "Function" },
	...GROUP_BY_OPTIONS.slice(1),
];

export const SORT_BY_OPTIONS: { value: SortByOption; label: string }[] = [
	{ value: "artist", label: "Artist" },
	{ value: "collectorNumber", label: "Collector's number" },
	{ value: "color", label: "Color" },
	{ value: "dateAdded", label: "Creation date" },
	{ value: "dateModified", label: "Date modified" },
	{ value: "listName", label: "List name" },
	{ value: "manaValue", label: "Mana value" },
	{ value: "name", label: "Name" },
	{ value: "price", label: "Price" },
	{ value: "quantity", label: "Quantity" },
	{ value: "rarity", label: "Rarity" },
	{ value: "releasedAt", label: "Release date" },
	{ value: "set", label: "Set" },
	{ value: "type", label: "Type" },
];

export const LIST_GRID_SORT_OPTIONS: { value: "name" | "dateCreated" | "cardCount" | "price"; label: string }[] = [
	{ value: "name", label: "Alphabetical" },
	{ value: "dateCreated", label: "Date created" },
	{ value: "cardCount", label: "Number of cards" },
	{ value: "price", label: "Price" },
];

// Pas de "price" ici : les cartes de deck n'ont pas de prix (voir plus bas).
export const DECK_GRID_SORT_OPTIONS: { value: "name" | "dateCreated" | "cardCount"; label: string }[] = [
	{ value: "name", label: "Alphabetical" },
	{ value: "dateCreated", label: "Date created" },
	{ value: "cardCount", label: "Number of cards" },
];

// Les cartes de deck n'ont ni prix, ni liste d'appartenance, ni date de
// sortie enregistrée : ces critères n'ont pas de sens pour un deck.
export const DECK_SORT_BY_OPTIONS = SORT_BY_OPTIONS.filter(
	(o) => o.value !== "price" && o.value !== "listName" && o.value !== "releasedAt"
);

// Les cartes de wantlist gardent prix et date de sortie, mais "listName"
// résout contre settings.lists (les listes de My Collection) : pas
// de sens pour une carte qui vit dans une wantlist.
export const WANTLIST_SORT_BY_OPTIONS = SORT_BY_OPTIONS.filter((o) => o.value !== "listName");

export const RARITY_ORDER: Record<string, number> = {
	common: 0,
	uncommon: 1,
	rare: 2,
	special: 2,
	mythic: 3,
	bonus: 3,
};

export const COLOR_LETTER_ORDER: Record<string, number> = { W: 0, U: 1, B: 2, R: 3, G: 4 };
export const COLOR_NAMES: Record<string, string> = {
	W: "White",
	U: "Blue",
	B: "Black",
	R: "Red",
	G: "Green",
};

// Teinte indicative par couleur de mana, utilisée pour accentuer visuellement
// les en-têtes de groupe quand on groupe/trie par Couleur.
export const COLOR_HEX: Record<string, string> = {
	W: "#d8c988",
	U: "#4a90d9",
	B: "#8a7ba8",
	R: "#e0643a",
	G: "#4f9e5c",
};

// Même principe, mais par libellé de groupe : couvre aussi les catégories qui
// n'ont pas de lettre de couleur unique (Land, Multicolor, Colorless).
export const GROUP_LABEL_HEX: Record<string, string> = {
	White: COLOR_HEX.W,
	Blue: COLOR_HEX.U,
	Black: COLOR_HEX.B,
	Red: COLOR_HEX.R,
	Green: COLOR_HEX.G,
	Multicolor: "#c9a227",
	Land: "#8a6d4a",
	Colorless: "#9a9a9a",
};

export const MAIN_TYPES = [
	"Land",
	"Creature",
	"Artifact",
	"Enchantment",
	"Instant",
	"Sorcery",
	"Planeswalker",
	"Battle",
	"Kindred",
	"Tribal",
];

export function primaryType(typeLine: string): string {
	const prefix = (typeLine || "").split("—")[0];
	const found = MAIN_TYPES.find((t) => prefix.includes(t));
	return found || prefix.trim() || "Other";
}

export function isLand(typeLine: string): boolean {
	return /\bLand\b/.test(typeLine || "");
}

// Champs communs nécessaires au tri/groupement, partagés par les cartes de
// collection (CollectionCard) et les cartes de deck (DeckCard). priceUsd/listId
// sont optionnels car absents des cartes de deck.
export interface SortableCard {
	name: string;
	setName: string;
	setCode: string;
	collectorNumber: string;
	rarity: string;
	manaValue: number;
	typeLine: string;
	artist: string;
	colors: string[];
	count: number;
	dateAdded: number;
	dateModified: number;
	priceUsd?: string;
	listId?: string;
	// Absent d'un DeckCard (le tri "Release Date" n'est pas proposé dans un deck, voir DECK_SORT_BY_OPTIONS).
	releasedAt?: string;
	// "Group by Function" (My Decks uniquement, voir deck-function.ts) —
	// oracleText/keywords existent déjà sur CollectionCard/WantlistCard/
	// DeckCard (voir types.ts/data-model.ts), donc rien à ajouter côté
	// appelant pour que les 3 satisfassent structurellement ce champ ; seul
	// deckFunctionOverride est propre à DeckCard (absent ailleurs, donc
	// toujours undefined en dehors d'un deck).
	oracleText?: string;
	keywords?: string[];
	deckFunctionOverride?: string;
}

// 0-4 pour une couleur unique (ordre WUBRG), 5.xx pour chaque combinaison
// multicolore précise (sous-classée par bitmask WUBRG pour un ordre stable
// et cohérent entre les groupes), 6 terrain, 7 incolore.
export function colorSortKey(card: SortableCard): number {
	if (isLand(card.typeLine)) return 6;
	const colors = card.colors ?? [];
	if (colors.length === 0) return 7;
	if (colors.length === 1) return COLOR_LETTER_ORDER[colors[0]] ?? 7;
	const mask = colors.reduce((m, c) => m | (1 << (COLOR_LETTER_ORDER[c] ?? 0)), 0);
	return 5 + mask / 100; // reste dans (5,6), entre "couleur unique" et "Land"
}

// Les terrains ont leur propre catégorie "Land" plutôt que d'être noyés dans
// "Colorless", qui ne concerne alors que les artefacts/incolores non-terrain.
// Les cartes multicolores sont sous-classées par combinaison exacte de
// couleurs (ex. "Green/Red") plutôt que noyées dans un seul bac "Multicolor".
export function colorGroupLabel(card: SortableCard): string {
	if (isLand(card.typeLine)) return "Land";
	const colors = card.colors ?? [];
	if (colors.length === 0) return "Colorless";
	if (colors.length === 1) return COLOR_NAMES[colors[0]] ?? "Colorless";
	const sorted = [...colors].sort(
		(a, b) => (COLOR_LETTER_ORDER[a] ?? 9) - (COLOR_LETTER_ORDER[b] ?? 9)
	);
	return sorted.map((c) => COLOR_NAMES[c] ?? c).join("/");
}

// Union des couleurs de toutes les cartes d'un deck (chaque carte porte déjà
// son propre `colors` — voir DeckCard/DeckSourceCard, data-model.ts), triée
// WUBRG — la "color identity" affichée sur la vignette du deck dans My Decks
// (mtg-deck-tile-colors, renderDeckGrid), sur le modèle des pastilles
// affichées par Moxfield. Volontairement l'union des couleurs des cartes
// elles-mêmes, pas la "commander color identity" (qui inclurait aussi les
// symboles de coût de mana sur le texte de règles) — ce plugin n'a pas cette
// donnée à disposition par carte, seul `colors` (issu du champ Scryfall du
// même nom) est stocké.
export function deckColorIdentity(cards: { colors: string[] }[]): string[] {
	const seen = new Set<string>();
	cards.forEach((c) => (c.colors ?? []).forEach((letter) => seen.add(letter)));
	return [...seen].sort((a, b) => (COLOR_LETTER_ORDER[a] ?? 9) - (COLOR_LETTER_ORDER[b] ?? 9));
}

// Comparaison numérique quand possible (les numéros de collector peuvent
// contenir des lettres, ex. "23a"), sinon alphabétique.
export function collectorNumberCompare(a: string, b: string): number {
	const na = parseInt(a, 10);
	const nb = parseInt(b, 10);
	if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
	return (a || "").localeCompare(b || "");
}

// Seul `id`/`name` des listes de My Collection compte ici (pas le plugin entier) : ce module reste ainsi
// pur, sans dépendance à Obsidian ni à la couche plugin.
export type ListNameSource = readonly { id: string; name: string }[];

export function getListNameFor(lists: ListNameSource, card: { listId?: string }): string {
	if (!card.listId) return "";
	return lists.find((l) => l.id === card.listId)?.name ?? "";
}

export function compareCardsBy<T extends SortableCard>(
	sortBy: SortByOption,
	lists: ListNameSource
): (a: T, b: T) => number {
	return (a, b) => {
		switch (sortBy) {
			case "artist":
				return (a.artist || "").localeCompare(b.artist || "");
			case "collectorNumber":
				return collectorNumberCompare(a.collectorNumber, b.collectorNumber);
			case "color":
				return colorSortKey(a) - colorSortKey(b) || a.name.localeCompare(b.name);
			case "dateAdded":
				return (a.dateAdded || 0) - (b.dateAdded || 0);
			case "dateModified":
				return (a.dateModified || 0) - (b.dateModified || 0);
			case "listName":
				return getListNameFor(lists, a).localeCompare(getListNameFor(lists, b));
			case "manaValue":
				return (a.manaValue ?? 0) - (b.manaValue ?? 0);
			case "price":
				return (parseFloat(a.priceUsd || "0") || 0) - (parseFloat(b.priceUsd || "0") || 0);
			case "quantity":
				return a.count - b.count;
			case "rarity":
				return (RARITY_ORDER[a.rarity] ?? 0) - (RARITY_ORDER[b.rarity] ?? 0);
			case "releasedAt":
				return (a.releasedAt || "").localeCompare(b.releasedAt || "");
			case "set":
				return a.setName.localeCompare(b.setName);
			case "type":
				return (a.typeLine || "").localeCompare(b.typeLine || "");
			case "name":
			default:
				return a.name.localeCompare(b.name);
		}
	};
}

export function groupSortValue<T extends SortableCard>(groupBy: GroupByOption, card: T): number | string {
	switch (groupBy) {
		// Toujours une CHAÎNE (jamais un nombre nu) — voir deckFunctionSortKey
		// (deck-function.ts) : groupOrderCmp (plus bas dans ce fichier) ne
		// compare deux valeurs comme des nombres que si les DEUX côtés sont
		// typeof "number" ; mélanger nombre et chaîne dans le même groupBy
		// retomberait sur une comparaison alphabétique du nombre converti en
		// texte, pas l'ordre voulu.
		case "function":
			return deckFunctionSortKey(
				card.deckFunctionOverride || detectDeckCardFunction(card) || primaryType(card.typeLine)
			);
		case "color":
			return colorSortKey(card);
		case "rarity":
			return RARITY_ORDER[card.rarity] ?? 0;
		case "manaValue":
			return card.manaValue ?? 0;
		case "dateAdded":
			return card.dateAdded ?? 0;
		case "quantity":
			return card.count;
		case "artist":
			return card.artist || "";
		case "set":
			return card.setName;
		case "type":
			return primaryType(card.typeLine);
		case "name":
			return card.name;
		default:
			return "";
	}
}

export function groupLabelFor<T extends SortableCard>(groupBy: GroupByOption, card: T): string {
	switch (groupBy) {
		case "artist":
			return card.artist || "Unknown artist";
		// Repli en 3 temps (override manuel > détection auto > type de carte)
		// — voir getDeckCardFunction (data-model.ts) pour la même chaîne
		// réimplémentée pour un DeckCard précis plutôt qu'un SortableCard
		// générique (utilisée par le panneau de détail, pas ce fichier).
		case "function":
			return card.deckFunctionOverride || detectDeckCardFunction(card) || primaryType(card.typeLine);
		case "color":
			return colorGroupLabel(card);
		case "dateAdded":
			return card.dateAdded ? new Date(card.dateAdded).toLocaleDateString() : "Unknown";
		case "manaValue":
			return `Mana value ${card.manaValue ?? 0}`;
		case "name":
			return (card.name[0] || "#").toUpperCase();
		case "quantity":
			return `${card.count}x`;
		case "rarity":
			return card.rarity ? card.rarity.charAt(0).toUpperCase() + card.rarity.slice(1) : "Unknown";
		case "set":
			return card.setName;
		case "type":
			return primaryType(card.typeLine);
		default:
			return "";
	}
}

export interface CardGroup<T> {
	label: string;
	colorKeys?: string[];
	manaValueKey?: number;
	setCodeKey?: string;
	// Marque le groupe "Recently Added" épinglé en tête de renderListDetail
	// (voir plus bas) — jamais posé par groupAndSortCards lui-même. Un
	// booléen dédié plutôt qu'un test sur `label === "Recently Added"` :
	// matcher sur le texte du label serait fragile (un vrai groupe par
	// type/rareté/etc. pourrait en théorie porter ce même libellé).
	isRecentlyAdded?: boolean;
	cards: T[];
}

// Répartition en pistes de la vue Stacks (updateDeckStacksLayout,
// src/view/deck-render.ts, 2026-09-13) — voir docs/history/deck-stats-
// and-stacks-views.md pour l'historique complet de pourquoi CSS
// `columns`/`column-fill: balance` (utilisé de 2026-09-11 à 2026-09-13,
// "rounds 6-8") a été abandonné : sa hauteur de colonne cible ne peut
// jamais descendre sous la hauteur de la pile la PLUS HAUTE (chaque pile
// est un bloc non-fragmentable, break-inside: avoid) — donc dès qu'un seul
// groupe est nettement plus long que les autres (ex. "Creature" en 45
// exemplaires côté "Group by Type", quand "Group by Function" répartit ce
// même contenu en bien plus de piles courtes), cette hauteur cible devient
// largement suffisante pour loger tout le reste en une poignée de
// colonnes — laissant les pistes potentielles restantes (déterminées par
// la largeur seule) entièrement vides, quel que soit column-count/-width
// (confirmé empiriquement : forcer column-count à 8 ou 24 ne change RIEN
// au nombre de colonnes réellement peuplées pour un contenu donné — balance
// ne recalcule jamais son propre minimum de colonnes à partir de
// column-count/-width, seulement l'inverse). updateDeckStacksLayout fait
// donc lui-même la répartition (glouton "piste la plus courte d'abord"),
// en s'appuyant sur cette estimation de hauteur PURE (aucune mesure DOM —
// un simple calcul à partir du nombre de cartes, comme le -120%/le ratio
// 488/680 déjà utilisés en CSS pour la même pile, voir le commentaire sur
// .mtg-deck-stack-card dans styles.css) pour décider, AVANT tout rendu,
// quelle piste est actuellement la plus courte.
//
// STACK_TRACK_MIN_WIDTH_PX sert D'ABORD à estimer la hauteur relative d'une
// pile avant répartition (une vraie largeur mesurée ici créerait une
// dépendance circulaire avec le choix de trackCount, voir plus bas). La
// hauteur d'une pile étant affine en cette largeur pour TOUTES les piles de
// la même vue (même formule, même constante), la valeur précise choisie ici
// ne change jamais l'ORDRE relatif des piles par hauteur — seule cette
// comparaison relative compte pour la répartition gloutonne ; elle sert
// aussi de largeur MINIMALE de piste dans le calcul de trackCount
// (updateDeckStacksLayout, src/view/deck-render.ts), reprenant le rôle que
// `column-width: 220px` jouait dans l'ancien mécanisme CSS. Elle n'a
// longtemps jamais influencé la largeur RENDUE d'une piste (qui vaut
// availableWidth/trackCount une fois trackCount choisi) — ce n'est plus tout
// à fait vrai depuis le 2026-09-16 (voir le commentaire de
// .mtg-deck-stack-track dans styles.css et celui de updateDeckStacksLayout) :
// cette même constante sert désormais AUSSI de plancher au plafond de
// largeur d'une piste, pour qu'un panneau étroit ne voie jamais ce plafond
// descendre sous cette largeur de confort minimale déjà établie.
// STACK_TRACK_GAP_PX, lui, DOIT rester strictement égal au `gap` littéral
// de .mtg-collection-list-stacks (styles.css) — exprimé en px des deux
// côtés (pas em) précisément pour que JS et CSS ne puissent pas diverger
// silencieusement l'un de l'autre.
export const STACK_TRACK_MIN_WIDTH_PX = 220;
export const STACK_TRACK_GAP_PX = 20;

// Hauteur mesurée (Browser pane, CSS réelle de ce fichier) de
// .mtg-deck-stack-header + sa propre margin-bottom — TOUJOURS la même quel
// que soit le libellé du groupe : .mtg-deck-stack-header-title est en
// white-space: nowrap + text-overflow: ellipsis (styles.css), ne passe
// donc jamais sur 2 lignes. Une constante calibrée une fois via une vraie
// mesure est donc exacte, pas juste approximative.
const STACK_HEADER_BLOCK_HEIGHT_PX = 47;
// 680/488 (ratio de l'image "tile", voir "Card view" dans CLAUDE.md) moins
// le recouvrement de 120% (.mtg-deck-stack-card + .mtg-deck-stack-card,
// styles.css) — même dérivation que le commentaire de cette règle CSS,
// reprise ici en JS pour estimer une hauteur de pile sans la mesurer dans
// le DOM.
const STACK_CARD_HEIGHT_RATIO = 680 / 488;
const STACK_SLIVER_HEIGHT_RATIO = STACK_CARD_HEIGHT_RATIO - 1.2;

// cardCount = nombre de LIGNES distinctes du groupe (cardGroup.cards.length
// — une carte par élément fanné dans le DOM), PAS la quantité totale
// (somme de count) : un deck Commander singleton confond les deux pour
// toute carte hors terrain de base (count vaut toujours 1), mais un deck
// "4-of" classique ne les confond pas — "4x Lightning Bolt" reste UNE
// seule ligne/carte fannée (avec un badge "×4"), jamais 4 cartes distinctes
// empilées. Utiliser la quantité totale surestimerait fortement la hauteur
// réelle de tout groupe contenant des cartes multi-exemplaires.
export function estimateStackColumnHeight(cardCount: number): number {
	const cardHeight = STACK_TRACK_MIN_WIDTH_PX * STACK_CARD_HEIGHT_RATIO;
	const sliverHeight = STACK_TRACK_MIN_WIDTH_PX * STACK_SLIVER_HEIGHT_RATIO;
	return STACK_HEADER_BLOCK_HEIGHT_PX + cardHeight + Math.max(0, cardCount - 1) * sliverHeight;
}

// Nombre de lignes rendues dans le DOM à la fois : sur une grosse collection
// (dizaines de milliers de cartes), construire un vrai nœud DOM (image,
// stepper, boutons, écouteurs...) pour chaque carte d'un coup fige
// l'interface pendant plusieurs secondes et charge autant d'images en
// parallèle. Une liste s'ouvre donc avec seulement les RENDER_BATCH_SIZE
// premières cartes ; le reste apparaît par lots au fur et à mesure du
// défilement (voir renderLoadMoreSentinel).
export const RENDER_BATCH_SIZE = 150;

// Tronque une liste de groupes déjà triés à un nombre total de cartes donné,
// en coupant le dernier groupe visible en plein milieu si besoin (plutôt que
// d'exclure des groupes entiers), pour que le nombre de lignes réellement
// affichées corresponde exactement à la limite demandée.
export function sliceGroupsForRender<T>(groups: CardGroup<T>[], limit: number): CardGroup<T>[] {
	const result: CardGroup<T>[] = [];
	let remaining = limit;
	for (const group of groups) {
		if (remaining <= 0) break;
		if (group.cards.length <= remaining) {
			result.push(group);
			remaining -= group.cards.length;
		} else {
			result.push({ ...group, cards: group.cards.slice(0, remaining) });
			remaining = 0;
		}
	}
	return result;
}

export function groupAndSortCards<T extends SortableCard>(
	cards: T[],
	groupBy: GroupByOption,
	sortBy: SortByOption,
	sortReverse: boolean,
	groupReverse: boolean,
	lists: ListNameSource
): CardGroup<T>[] {
	const cmp = compareCardsBy<T>(sortBy, lists);

	if (groupBy === "none") {
		const sorted = [...cards].sort(cmp);
		if (sortReverse) sorted.reverse();
		return [{ label: "", cards: sorted }];
	}

	const groupOrderCmp = (a: T, b: T) => {
		const va = groupSortValue(groupBy, a);
		const vb = groupSortValue(groupBy, b);
		if (typeof va === "number" && typeof vb === "number") return va - vb;
		return String(va).localeCompare(String(vb));
	};

	const order: string[] = [];
	const map = new Map<string, T[]>();
	[...cards]
		.sort(groupOrderCmp)
		.forEach((card) => {
			const label = groupLabelFor(groupBy, card);
			if (!map.has(label)) {
				map.set(label, []);
				order.push(label);
			}
			map.get(label)!.push(card);
		});

	const groups = order.map((label) => {
		const groupCards = map.get(label)!;
		const sorted = [...groupCards].sort(cmp);
		if (sortReverse) sorted.reverse();
		const groupColors = groupCards[0]?.colors ?? [];
		return {
			label,
			colorKeys:
				groupBy === "color" && groupColors.length >= 1
					? [...groupColors].sort(
							(a, b) => (COLOR_LETTER_ORDER[a] ?? 9) - (COLOR_LETTER_ORDER[b] ?? 9)
					  )
					// "Colorless" a son propre symbole officiel ({C}, via Scryfall) ;
					// "Land" n'en a pas (ce n'est pas une couleur de mana), reste en
					// texte seul.
					: groupBy === "color" && label === "Colorless"
					  ? ["C"]
					  : undefined,
			manaValueKey: groupBy === "manaValue" ? groupCards[0]?.manaValue ?? 0 : undefined,
			setCodeKey: groupBy === "set" ? groupCards[0]?.setCode : undefined,
			cards: sorted,
		};
	});

	if (groupReverse) groups.reverse();
	return groups;
}
