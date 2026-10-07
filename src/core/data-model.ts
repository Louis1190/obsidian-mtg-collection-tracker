import { CollectionCard, WantlistCard, Finish, GradingCompany } from "./card-model";
import { GroupByOption, SortByOption, CardViewMode, primaryType } from "./card-sorting";
import { detectDeckCardFunction } from "./deck-function";
import type { PriceCurrency } from "./price";
import type { CardbaseMoverPeriod, CardbaseVendor } from "../api/cardbase";

// Pictogramme affiché à gauche du nom d'une liste (ListSettingsModal,
// "Choose icon") — soit un symbole de mana (value = une lettre W/U/B/R/G/C,
// voir MTGCollectionPlugin.getManaSymbolSvg), soit le symbole d'une édition
// précise (value = son code, voir MTGCollectionPlugin.getSetIconSvg). Un
// seul à la fois : pas de tableau de couleurs multiples pour cette première
// version, volontairement proportionné à ce qui a été demandé.
export interface ListIcon {
	kind: "mana" | "set";
	value: string;
}

export interface CollectionList {
	id: string;
	name: string;
	dateCreated?: number;
	// Liste système "Inbox" (voir MTGCollectionPlugin.ensureInboxList) —
	// exactement une, garantie présente après tout chargement de settings
	// (chargement normal ET restauration de sauvegarde, voir
	// runSettingsMigrations). Épinglée en tête de la grille "My Collection"
	// (renderListGrid), destination par défaut du flux "+ Add cards" depuis
	// "All Cards" (voir AddCardsModalOptions.listGallery.defaultListId), et
	// protégée en renommage/suppression (voir ListSettingsModal/
	// MTGCollectionPlugin.deleteList/renameList/bulkDeleteLists/mergeLists) —
	// aucune autre liste ne doit jamais porter ce flag.
	isInbox?: boolean;
	// Image de couverture choisie manuellement (ListSettingsModal, "Choose
	// cover image") — l'id d'une CollectionCard de CETTE liste. Absent par défaut
	// (choix automatique, voir pickCoverImage/groupByList dans price.ts,
	// core/) ; ignoré silencieusement si la carte visée a depuis été
	// supprimée/déplacée, plutôt que de garder une référence morte — voir
	// resolveCoverImage.
	coverCardId?: string;
	// Voir ListIcon ci-dessus. Absent par défaut (aucun pictogramme).
	listIcon?: ListIcon;
}

export interface Wantlist {
	id: string;
	name: string;
	dateCreated?: number;
	// Même champ/même raisonnement que CollectionList.coverCardId ci-dessus,
	// côté wantlist (WantlistSettingsModal, "Choose cover image") — l'id
	// d'une WantlistCard de CETTE wantlist. Voir resolveCoverImage/
	// groupByWantlist (price.ts).
	coverCardId?: string;
	// Voir ListIcon ci-dessus. Même champ/même raisonnement que
	// CollectionList.listIcon, côté wantlist (WantlistSettingsModal, "Choose
	// icon").
	listIcon?: ListIcon;
}

export type DeckCardCategory = "mainboard" | "sideboard" | "maybeboard";

export interface DeckCard {
	scryfallId: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	imageUrl: string;
	artCropUrl: string;
	manaCost: string;
	manaValue: number;
	typeLine: string;
	rarity: string;
	artist: string;
	colors: string[];
	keywords: string[];
	count: number;
	dateAdded: number;
	dateModified: number;
	// Absent sur les entrées créées avant cette fonctionnalité : traité comme
	// "possédée" partout où ce champ est lu (voir isDeckCardOwned), pour ne
	// rien changer visuellement aux decks existants.
	owned?: boolean;
	// Voir le commentaire sur CollectionCard (types.ts) pour le raisonnement complet
	// — même champs, même raison d'être optionnelle (donnée immuable ajoutée
	// après coup, rattrapée une fois par MTGCollectionPlugin.backfillBorderData).
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	// Même raisonnement, rattrapé par backfillOracleTextData() (voir
	// CollectionCard.oracleText, types.ts).
	oracleText?: string;
	// Absent = "mainboard" (voir getDeckCardCategory) — le cas de très loin
	// le plus courant (toute entrée créée avant cette fonctionnalité, et
	// toute entrée ajoutée par un chemin autre que l'import de decklist, voir
	// le commentaire sur DeckCardCategory), pas la peine de le persister pour
	// rien sur des milliers d'entrées existantes.
	category?: DeckCardCategory;
	// "Function" (2026-09-02, voir "Group by Function"/vue Stacks, view.ts) —
	// correction manuelle d'une détection automatique erronée/absente
	// (detectDeckCardFunction, core/deck-function.ts), pas un système de
	// tags libres/multi-tags (scoping confirmé explicitement) : une seule
	// valeur, qui gagne toujours sur la détection automatique quand elle est
	// présente. Absent = "laisse la détection automatique décider" (le cas
	// de très loin le plus courant), pas "aucune fonction". Depuis le
	// 2026-09-07, porte aussi "Commander" (voir isDeckCommander ci-dessus) —
	// une désignation manuelle pure, jamais un repli auto-détecté, à la
	// différence de toute autre valeur possible ici.
	deckFunctionOverride?: string;
	// Harmonisation du panneau de détail My Decks avec My Collection
	// (2026-08-25, demandé explicitement) — mêmes 4 champs "état physique"
	// que CollectionCard (voir son propre commentaire, types.ts), MAIS optionnels
	// ici pour la même raison que owned?/borderColor?/etc. ci-dessus : un
	// modèle de données déjà mature avec des milliers d'entrées existantes,
	// pas parce que la valeur peut légitimement manquer une fois choisie.
	// Absent = "Regular"/aucune (voir getDeckCardFinish/getDeckCardCondition/
	// getDeckCardLanguage) — même repli que My Collection (et, depuis,
	// My Wantlists) ont eux-mêmes une fois leur propre sélecteur Finish/
	// Language/Condition retiré du flux "Add cards" (add-cards-modal.ts) : une
	// carte de deck nouvelle (recherche, import CSV/decklist) prend ce repli
	// par défaut, à affiner
	// ensuite depuis DeckCardDetailModal comme n'importe quelle autre carte.
	// addCollectionCardToDeck/addWantlistCardToDeck (plugin.ts) reprennent en
	// revanche la valeur réelle de la carte source quand elle en a une —
	// copier un exemplaire déjà suivi vers un deck ne doit pas lui faire
	// perdre son propre finish/condition/langue.
	finish?: Finish;
	language?: string;
	condition?: string;
	gradingCompany?: GradingCompany;
	gradingGrade?: number;
	gradingLabel?: string;
	customPrice?: string;
	// Prix Scryfall en cache (2026-09-02) — mêmes 6 champs que CollectionCard/
	// WantlistCard (voir leur propre commentaire, types.ts), mêmes deux
	// raisons d'être optionnels ici : (1) modèle de données déjà mature,
	// rattrapé une fois pour les decks existants par
	// MTGCollectionPlugin.backfillDeckCardPrices() ; (2) CONTRAIREMENT à
	// borderColor/frame/oracleText plus haut (immuables, un seul rattrapage
	// suffit pour toujours), un prix périme — ces 6 champs sont donc aussi
	// tenus à jour en continu par MTGCollectionPlugin.refreshAllPrices(),
	// qui inclut maintenant les decks au même titre que la collection/la
	// wantlist. `undefined` = "jamais encore rattrapé" (voir toDeckPricedCard,
	// core/price.ts, pour le repli "" utilisé à l'affichage) ; une fois
	// rattrapé, une chaîne vide est un résultat définitif (Scryfall n'a
	// simplement aucun prix connu pour cette impression), pas un échec.
	// Peuplé directement à la création par les mêmes sites que borderColor/
	// frame/frameEffects/oracleText (addCardToDeck, importDecklistToDeck,
	// importDeckCsv, changeDeckCardPrinting) ; addCollectionCardToDeck/
	// addWantlistCardToDeck reprennent le prix déjà connu de la carte source
	// (voir DeckSourceCard ci-dessous) plutôt que de le réinventer.
	priceUsd?: string;
	priceUsdFoil?: string;
	priceEur?: string;
	priceEurFoil?: string;
	priceUsdEtched?: string;
	priceEurEtched?: string;
}

export function isDeckCardOwned(card: DeckCard): boolean {
	return card.owned !== false;
}

export function getDeckCardCategory(card: DeckCard): DeckCardCategory {
	return card.category ?? "mainboard";
}

// Onglets "board" affichés au-dessus de la liste des cartes d'un deck
// (renderDeckBoardTabs, view.ts) — remplace l'ancien regroupement "Category"
// (retiré de DECK_GROUP_BY_OPTIONS, card-sorting.ts, sur demande explicite).
// Simple alias de DeckCardCategory (même 3 valeurs) plutôt qu'un type propre
// dupliqué — les deux coïncident exactement depuis que Commander est devenu
// une Function plutôt qu'une 4e catégorie (voir DeckCardCategory ci-dessus)
// ; gardé comme alias distinct (pas juste "DeckCardCategory" partout) pour
// la clarté sémantique à chaque site d'utilisation : "quel onglet" (UI) vs
// "le board réel de cette carte" (donnée).
export type DeckBoardTab = DeckCardCategory;

export const DECK_BOARD_TABS: { value: DeckBoardTab; label: string }[] = [
	{ value: "mainboard", label: "Mainboard" },
	{ value: "sideboard", label: "Sideboard" },
	{ value: "maybeboard", label: "Maybeboard" },
];

// Un onglet correspond exactement à une catégorie — plus de fusion à faire
// ici depuis que Commander n'est plus une valeur de DeckCardCategory du tout
// (voir son propre commentaire) : une carte Commander est déjà, par
// construction, catégorisée "mainboard" comme n'importe quelle autre carte
// du deck principal.
export function deckBoardTabMatches(card: DeckCard, tab: DeckBoardTab): boolean {
	return getDeckCardCategory(card) === tab;
}

// "Function" résolue d'une carte de deck (Ramp/Removal/Draw/etc., voir
// "Group by Function"/vue Stacks) — la correction manuelle
// (deckFunctionOverride) l'emporte toujours, sinon la détection
// automatique (detectDeckCardFunction, core/deck-function.ts), sinon le
// type de carte lui-même (primaryType, card-sorting.ts) comme dernier
// repli, pour qu'une carte affiche toujours une valeur plutôt que rien.
// card-sorting.ts's groupLabelFor/groupSortValue réimplémentent cette même
// chaîne inline plutôt que d'appeler cette fonction (elles opèrent sur un
// SortableCard générique, pas un DeckCard précis) — ce petit doublon reste
// dans l'esprit des autres petits "getters de repli" déjà établis dans ce
// fichier (getDeckCardFinish/etc.).
export function getDeckCardFunction(card: DeckCard): string {
	return card.deckFunctionOverride || detectDeckCardFunction(card) || primaryType(card.typeLine);
}

export function isDeckCommander(card: DeckCard): boolean {
	return getDeckCardFunction(card) === "Commander";
}

// Voir le commentaire sur DeckCard.finish/language/condition ci-dessus pour
// le raisonnement complet — même repli "Regular"/aucune que CollectionCard avait
// par défaut avant le retrait du trio Finish/Language/Condition du flux
// "Add cards" (add-cards-modal.ts).
export function getDeckCardFinish(card: DeckCard): Finish {
	return card.finish ?? "regular";
}

export function getDeckCardCondition(card: DeckCard): string {
	return card.condition ?? "";
}

export function getDeckCardLanguage(card: DeckCard): string {
	return card.language ?? "";
}

// Sous-ensemble de champs nécessaire pour ajouter une carte à un deck :
// aussi bien CollectionCard (My Collection) que WantlistCard (My Wantlists)
// le satisfont, pas besoin de dupliquer addCollectionCardToDeck/
// addWantlistCardToDeck pour chaque forme de carte source.
export interface DeckSourceCard {
	scryfallId: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	imageUrl: string;
	artCropUrl: string;
	manaCost: string;
	manaValue: number;
	typeLine: string;
	rarity: string;
	artist: string;
	colors: string[];
	keywords: string[];
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	oracleText?: string;
	// Voir DeckCard.finish/language/condition ci-dessus — reportés tels
	// quels sur la nouvelle ligne de deck par addCollectionCardToDeck/
	// addWantlistCardToDeck quand la carte source en a (CollectionCard a les
	// trois, WantlistCard n'a que finish) : contrairement à
	// borderColor/frame/oracleText, qui sont des faits intrinsèques de
	// l'impression, ce sont des attributs de l'EXEMPLAIRE physique qu'on est
	// justement en train de copier — les perdre au passage serait une vraie
	// régression, pas une simplification.
	finish?: Finish;
	condition?: string;
	language?: string;
	// Voir DeckCard.priceUsd/etc. ci-dessus — reporté tel quel plutôt que
	// rattrapé plus tard par backfillDeckCardPrices() : CollectionCard/
	// WantlistCard ont déjà ce prix en cache de manière synchrone
	// (contrairement à un ScryfallCard fraîchement résolu), copier
	// l'exemplaire ne devrait pas laisser la carte de deck avec un prix
	// "pas encore su" alors qu'on le connaît déjà.
	priceUsd?: string;
	priceUsdFoil?: string;
	priceEur?: string;
	priceEurFoil?: string;
	priceUsdEtched?: string;
	priceEurEtched?: string;
}

export interface Deck {
	id: string;
	name: string;
	cards: DeckCard[];
	dateCreated?: number;
	// Clé LEGALITY_SEARCH_FORMATS (card-search.ts, ex. "commander") plutôt
	// qu'un type union ici — data-model.ts n'importe rien de card-search.ts,
	// pour éviter tout risque de dépendance circulaire entre ces deux
	// fichiers core/ ; view.ts/plugin.ts résolvent le libellé affiché en
	// cherchant cette clé dans LEGALITY_SEARCH_FORMATS. Absent = pas de
	// format choisi (decks créés avant cette fonctionnalité, ou création
	// sans format sélectionné) — n'active ni l'affichage du format ni le
	// badge de légalité par carte (voir deckLegalityBadge, card-search.ts).
	format?: string;
	// "Choose cover image"/"Choose icon" (DeckSettingsModal, harmonisé sur
	// ListSettingsModal — voir CollectionList.coverCardId/listIcon ci-dessus
	// pour le raisonnement complet, transposé tel quel). coverCardId
	// identifie une DeckCard par scryfallId plutôt que par id : DeckCard n'a
	// pas de champ id propre (voir plus haut), contrairement à CollectionCard.
	coverCardId?: string;
	deckIcon?: ListIcon;
}

// Filtre de recherche enregistré depuis "Add cards" (bouton "Save filter",
// voir add-cards-modal.ts) — un instantané de la barre de puces au moment de
// l'enregistrement : `tokens` sont les jetons bruts de chipTokens (déjà
// compatibles tels quels avec buildScryfallQueryFromChips/
// cardMatchesTokens, aucune transformation nécessaire pour les réappliquer),
// `sortOverride` le tri Scryfall actif le cas échéant (voir
// AddCardsModal.sortOverride). Persisté comme un réglage ordinaire (voir
// saveSettings) — contrairement aux caches Scryfall de plugin.ts, une
// combinaison de filtres ne devient jamais "périmée", donc pas de TTL ici.
export interface SavedSearchFilter {
	id: string;
	label: string;
	tokens: string[];
	sortOverride: { order: string; dir: "asc" | "desc" } | null;
}

// Résumé chiffré du contenu d'un fichier de sauvegarde (voir
// MTGCollectionPlugin.exportBackup/parseBackupFile/restoreBackup) —
// délibérément un sous-ensemble léger (des compteurs + la date d'export),
// pas les données elles-mêmes, affiché par RestoreBackupConfirmModal avant
// de confirmer une restauration (destructive : remplace toute la
// collection/decks/wantlists actuels).
export interface BackupSummary {
	cards: number;
	lists: number;
	decks: number;
	wantlistItems: number;
	wantlists: number;
	exportedAt: number | null;
}

export interface MTGCollectionSettings {
	collection: CollectionCard[];
	lists: CollectionList[];
	decks: Deck[];
	wantlist: WantlistCard[];
	wantlists: Wantlist[];
	customIconSvg: string;
	customIconColor: string;
	navCollapsed: boolean;
	hideObsidianMobileBars: boolean;
	accentColor: string;
	suggestionCountThreshold: number;
	priceRefreshIntervalHours: number;
	lastPriceRefresh: number;
	priceCurrency: PriceCurrency;
	cardbaseApiKey: string;
	// Sauvegardes automatiques (2026-09-02, voir MTGCollectionPlugin.
	// maybeAutoBackup/runAutoBackup) — même schéma intervalle/horodatage que
	// priceRefreshIntervalHours/lastPriceRefresh juste au-dessus (0 =
	// désactivé, sinon un nombre d'heures). autoBackupFolder est un chemin de
	// dossier DANS la vault elle-même (pas le dossier privé du plugin — voir
	// runAutoBackup) : ces fichiers doivent rester visibles/déplaçables/
	// synchronisables comme n'importe quel autre fichier de la vault.
	// autoBackupKeepCount borne combien de sauvegardes automatiques sont
	// conservées avant que les plus anciennes soient déplacées à la
	// corbeille (jamais les fichiers qui ne portent pas le préfixe
	// "auto-", voir AUTO_BACKUP_FILE_PREFIX — une sauvegarde manuelle
	// déposée dans le même dossier n'est jamais concernée).
	autoBackupIntervalHours: number;
	lastAutoBackup: number;
	autoBackupFolder: string;
	autoBackupKeepCount: number;
	listGridSortBy: "name" | "dateCreated" | "cardCount" | "price";
	listGridSortReverse: boolean;
	deckGridSortBy: "name" | "dateCreated" | "cardCount";
	deckGridSortReverse: boolean;
	wantlistGridSortBy: "name" | "dateCreated" | "cardCount" | "price";
	wantlistGridSortReverse: boolean;
	collectionGroupBy: GroupByOption;
	collectionSortBy: SortByOption;
	collectionSortReverse: boolean;
	collectionGroupReverse: boolean;
	collectionViewMode: CardViewMode;
	deckGroupBy: GroupByOption;
	deckSortBy: SortByOption;
	deckSortReverse: boolean;
	deckGroupReverse: boolean;
	deckViewMode: CardViewMode;
	// Onglet "board" actif (voir DeckBoardTab ci-dessus) — global comme
	// deckGroupBy/deckViewMode, pas propre à un deck précis : même
	// convention que le reste de l'état d'affichage de My Decks.
	deckActiveBoard: DeckBoardTab;
	wantlistGroupBy: GroupByOption;
	wantlistSortBy: SortByOption;
	wantlistSortReverse: boolean;
	wantlistGroupReverse: boolean;
	wantlistViewMode: CardViewMode;
	savedSearchFilters: SavedSearchFilter[];
	// Bloc "Market Trends" de Home (2026-09-23) : période et vendeur choisis,
	// mémorisés d'une session à l'autre — avant, tout repartait à "24h / tous
	// vendeurs" à chaque re-rendu de Home (voir renderHomeMarketTrends).
	// homeMoversVendor vaut "" pour "tous vendeurs" : un `undefined` ne
	// survivrait pas à la sérialisation JSON de data.json. Un data.json plus
	// ancien n'a pas ces champs : loadSettings/restoreBackup les complètent
	// via DEFAULT_SETTINGS, et le rendu ignore de toute façon une valeur qui
	// n'est plus une période/un vendeur connu (fichier édité à la main, ou
	// vendeur retiré d'une version future).
	homeMoversPeriod: CardbaseMoverPeriod;
	homeMoversVendor: CardbaseVendor | "";
	// Suppressions à propager entre appareils (voir core/settings-merge.ts) :
	// collection → clé de l'entité → date de suppression. Absent tant que rien
	// n'a été supprimé ; volontairement PAS dans DEFAULT_SETTINGS (un objet
	// partagé par référence entre toutes les instances serait muté par erreur).
	syncTombstones?: Record<string, Record<string, number>>;
	// Synchronisation optionnelle via un dépôt GitHub privé (src/plugin/github-sync.ts), en
	// plus de Syncthing. Propres à chaque appareil (core/device-settings.ts) : le jeton
	// d'accès, lui, n'est JAMAIS dans ces réglages (stockage secret d'Obsidian).
	githubSyncEnabled: boolean;
	githubRepo: string; // "propriétaire/nom"
	githubBranch: string;
	githubPath: string; // dossier du dépôt qui contient data.json
	// Adresse de l'API, vide = api.github.com. Pas dans l'interface : sert à GitHub Enterprise et aux
	// tests contre un faux serveur (tools/android/mock-github.mjs).
	githubApiBase: string;
	// Dossier de la vault qui contient le fichier de données ("" = le dossier du plugin, comportement
	// d'origine). Propre à l'appareil : il faut le connaître AVANT de pouvoir lire les données (voir
	// settings-sync.ts, readSettingsFromDisk), et il doit être le même sur tous les appareils que
	// l'utilisateur synchronise entre eux.
	dataFolder: string;
}

export const DEFAULT_SETTINGS: MTGCollectionSettings = {
	collection: [],
	lists: [],
	decks: [],
	wantlist: [],
	wantlists: [],
	customIconSvg: "",
	customIconColor: "",
	navCollapsed: false,
	hideObsidianMobileBars: true,
	accentColor: "",
	suggestionCountThreshold: 5000,
	priceRefreshIntervalHours: 24,
	lastPriceRefresh: 0,
	priceCurrency: "usd",
	cardbaseApiKey: "",
	autoBackupIntervalHours: 168,
	lastAutoBackup: 0,
	autoBackupFolder: "MTG Backups",
	autoBackupKeepCount: 7,
	listGridSortBy: "name",
	listGridSortReverse: false,
	deckGridSortBy: "name",
	deckGridSortReverse: false,
	wantlistGridSortBy: "name",
	wantlistGridSortReverse: false,
	collectionGroupBy: "none",
	collectionSortBy: "name",
	collectionSortReverse: false,
	collectionGroupReverse: false,
	collectionViewMode: "list",
	deckGroupBy: "none",
	deckSortBy: "name",
	deckSortReverse: false,
	deckGroupReverse: false,
	deckViewMode: "list",
	deckActiveBoard: "mainboard",
	wantlistGroupBy: "none",
	wantlistSortBy: "name",
	wantlistSortReverse: false,
	wantlistGroupReverse: false,
	wantlistViewMode: "list",
	savedSearchFilters: [],
	homeMoversPeriod: "1d",
	homeMoversVendor: "",
	githubSyncEnabled: false,
	githubRepo: "",
	githubBranch: "main",
	githubPath: "mtg-collection",
	githubApiBase: "",
	dataFolder: "",
};

export function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const VIEW_TYPE_MTG_COLLECTION = "mtg-collection-view";
export const ALL_CARDS_ID = "__all_cards__";
export const ALL_WANTED_ID = "__all_wanted__";
