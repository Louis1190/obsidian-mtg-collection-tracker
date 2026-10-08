import { CollectionCard, WantlistCard, Finish, GradingCompany } from "./card-model";
import { GroupByOption, SortByOption, CardViewMode, primaryType } from "./card-sorting";
import { detectDeckCardFunction } from "./deck-function";
import type { PriceCurrency } from "./price";
import type { CardbaseMoverPeriod, CardbaseVendor } from "../api/cardbase";

// Pictogram displayed to the left of a list's name (ListSettingsModal,
// "Choose icon") — either a mana symbol (value = a letter W/U/B/R/G/C, see
// MTGCollectionPlugin.getManaSymbolSvg), or the symbol of a specific set
// (value = its code, see MTGCollectionPlugin.getSetIconSvg). Only one at a
// time: no array of multiple colors for this first version, deliberately
// proportioned to what was asked for.
export interface ListIcon {
	kind: "mana" | "set";
	value: string;
}

export interface CollectionList {
	id: string;
	name: string;
	dateCreated?: number;
	// System list "Inbox" (see MTGCollectionPlugin.ensureInboxList) — exactly
	// one, guaranteed present after any settings load (normal load AND backup
	// restore, see runSettingsMigrations). Pinned at the top of the "My
	// Collection" grid (renderListGrid), default destination of the "+ Add
	// cards" flow from "All Cards" (see
	// AddCardsModalOptions.listGallery.defaultListId), and protected against
	// renaming/deletion (see
	// ListSettingsModal/MTGCollectionPlugin.deleteList/renameList/bulkDeleteLists/mergeLists)
	// — no other list must ever carry this flag.
	isInbox?: boolean;
	// Cover image chosen manually (ListSettingsModal, "Choose cover image") — the
	// id of a CollectionCard of THIS list. Absent by default (automatic choice,
	// see pickCoverImage/groupByList in price.ts, core/); silently ignored if the
	// targeted card has since been deleted/moved, rather than keeping a dead
	// reference — see resolveCoverImage.
	coverCardId?: string;
	// See ListIcon above. Absent by default (no pictogram).
	listIcon?: ListIcon;
}

export interface Wantlist {
	id: string;
	name: string;
	dateCreated?: number;
	// Same field/same reasoning as CollectionList.coverCardId above, on the
	// wantlist side (WantlistSettingsModal, "Choose cover image") — the id of
	// a WantlistCard of THIS wantlist. See resolveCoverImage/groupByWantlist
	// (price.ts).
	coverCardId?: string;
	// See ListIcon above. Same field/same reasoning as
	// CollectionList.listIcon, on the wantlist side (WantlistSettingsModal,
	// "Choose icon").
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
	// Absent on entries created before this feature: treated as "owned"
	// everywhere this field is read (see isDeckCardOwned), so as to change
	// nothing visually for existing decks.
	owned?: boolean;
	// See the comment on CollectionCard (types.ts) for the full reasoning — same
	// fields, same reason for being optional (immutable data added after the fact,
	// caught up once by MTGCollectionPlugin.backfillBorderData).
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	// Same reasoning, caught up by backfillOracleTextData() (see
	// CollectionCard.oracleText, types.ts).
	oracleText?: string;
	// Absent = "mainboard" (see getDeckCardCategory) — by far the most common
	// case (any entry created before this feature, and any entry added by a
	// path other than decklist import, see the comment on DeckCardCategory),
	// no point persisting it for nothing on thousands of existing entries.
	category?: DeckCardCategory;
	// "Function" (2026-09-02, see "Group by Function"/Stacks view, view.ts) —
	// manual correction of an erroneous/missing automatic detection
	// (detectDeckCardFunction, core/deck-function.ts), not a
	// free-form/multi-tag system (scoping explicitly confirmed): a single
	// value, which always wins over automatic detection when present. Absent =
	// "let automatic detection decide" (by far the most common case), not "no
	// function". Since 2026-09-07, also carries "Commander" (see
	// isDeckCommander above) — a purely manual designation, never an
	// auto-detected fallback, unlike any other possible value here.
	deckFunctionOverride?: string;
	// Harmonization of the My Decks detail panel with My Collection (2026-08-25,
	// explicitly requested) — same 4 "physical state" fields as CollectionCard
	// (see its own comment, types.ts), BUT optional here for the same reason as
	// owned?/borderColor?/etc. above: an already mature data model with thousands
	// of existing entries, not because the value can legitimately be missing once
	// chosen. Absent = "Regular"/none (see
	// getDeckCardFinish/getDeckCardCondition/getDeckCardLanguage) — the same
	// fallback that My Collection (and, since, My Wantlists) themselves have once
	// their own Finish/Language/Condition selector was removed from the "Add
	// cards" flow (add-cards-modal.ts): a new deck card (search, CSV/decklist
	// import) takes this fallback by default, to be refined afterwards from
	// DeckCardDetailModal like any other card.
	// addCollectionCardToDeck/addWantlistCardToDeck (plugin.ts), on the other
	// hand, carry over the source card's actual value when it has one — copying
	// an already-tracked copy to a deck must not make it lose its own
	// finish/condition/language.
	finish?: Finish;
	language?: string;
	condition?: string;
	gradingCompany?: GradingCompany;
	gradingGrade?: number;
	gradingLabel?: string;
	customPrice?: string;
	// Cached Scryfall price (2026-09-02) — same 6 fields as
	// CollectionCard/WantlistCard (see their own comment, types.ts), same two
	// reasons for being optional here: (1) already mature data model, caught
	// up once for existing decks by
	// MTGCollectionPlugin.backfillDeckCardPrices(); (2) UNLIKE
	// borderColor/frame/oracleText above (immutable, a single catch-up is
	// enough forever), a price goes stale — these 6 fields are therefore also
	// kept up to date continuously by MTGCollectionPlugin.refreshAllPrices(),
	// which now includes decks just like the collection/wantlist. `undefined`
	// = "never caught up yet" (see toDeckPricedCard, core/price.ts, for the ""
	// fallback used at display time); once caught up, an empty string is a
	// definitive result (Scryfall simply has no known price for this
	// printing), not a failure. Populated directly at creation by the same
	// sites as borderColor/frame/frameEffects/oracleText (addCardToDeck,
	// importDecklistToDeck, importDeckCsv, changeDeckCardPrinting);
	// addCollectionCardToDeck/addWantlistCardToDeck carry over the price
	// already known for the source card (see DeckSourceCard below) rather than
	// reinventing it.
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

// "Board" tabs displayed above a deck's card list (renderDeckBoardTabs,
// view.ts) — replaces the old "Category" grouping (removed from
// DECK_GROUP_BY_OPTIONS, card-sorting.ts, on explicit request). Simple alias
// of DeckCardCategory (same 3 values) rather than a duplicated type of its
// own — the two coincide exactly since Commander became a Function rather
// than a 4th category (see DeckCardCategory above); kept as a distinct alias
// (not just "DeckCardCategory" everywhere) for semantic clarity at each use
// site: "which tab" (UI) vs "this card's actual board" (data).
export type DeckBoardTab = DeckCardCategory;

export const DECK_BOARD_TABS: { value: DeckBoardTab; label: string }[] = [
	{ value: "mainboard", label: "Mainboard" },
	{ value: "sideboard", label: "Sideboard" },
	{ value: "maybeboard", label: "Maybeboard" },
];

// A tab corresponds to exactly one category — no more merging to do here
// since Commander is no longer a DeckCardCategory value at all (see its own
// comment): a Commander card is already, by construction, categorized
// "mainboard" like any other card of the main deck.
export function deckBoardTabMatches(card: DeckCard, tab: DeckBoardTab): boolean {
	return getDeckCardCategory(card) === tab;
}

// Resolved "Function" of a deck card (Ramp/Removal/Draw/etc., see "Group
// by Function"/Stacks view) — the manual correction (deckFunctionOverride)
// always wins, otherwise automatic detection (detectDeckCardFunction,
// core/deck-function.ts), otherwise the card type itself (primaryType,
// card-sorting.ts) as the last fallback, so that a card always shows a
// value rather than nothing. card-sorting.ts's
// groupLabelFor/groupSortValue reimplement this same chain inline rather
// than calling this function (they operate on a generic SortableCard, not
// a specific DeckCard) — this small duplication stays in the spirit of the
// other small "fallback getters" already established in this file
// (getDeckCardFinish/etc.).
export function getDeckCardFunction(card: DeckCard): string {
	return card.deckFunctionOverride || detectDeckCardFunction(card) || primaryType(card.typeLine);
}

export function isDeckCommander(card: DeckCard): boolean {
	return getDeckCardFunction(card) === "Commander";
}

// See the comment on DeckCard.finish/language/condition above for the full
// reasoning — same "Regular"/none fallback that CollectionCard had by default
// before the Finish/Language/Condition trio was removed from the "Add cards"
// flow (add-cards-modal.ts).
export function getDeckCardFinish(card: DeckCard): Finish {
	return card.finish ?? "regular";
}

export function getDeckCardCondition(card: DeckCard): string {
	return card.condition ?? "";
}

export function getDeckCardLanguage(card: DeckCard): string {
	return card.language ?? "";
}

// Subset of fields needed to add a card to a deck: both CollectionCard (My
// Collection) and WantlistCard (My Wantlists) satisfy it, no need to
// duplicate addCollectionCardToDeck/addWantlistCardToDeck for each source
// card shape.
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
	// See DeckCard.finish/language/condition above — carried over as is onto
	// the new deck row by addCollectionCardToDeck/addWantlistCardToDeck when
	// the source card has them (CollectionCard has all three, WantlistCard
	// only has finish): unlike borderColor/frame/oracleText, which are
	// intrinsic facts of the printing, these are attributes of the physical
	// COPY being copied — losing them along the way would be a real
	// regression, not a simplification.
	finish?: Finish;
	condition?: string;
	language?: string;
	// See DeckCard.priceUsd/etc. above — carried over as is rather than caught
	// up later by backfillDeckCardPrices(): CollectionCard/WantlistCard
	// already have this price cached synchronously (unlike a freshly resolved
	// ScryfallCard), copying the copy should not leave the deck card with a
	// "not yet known" price when we already know it.
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
	// LEGALITY_SEARCH_FORMATS key (card-search.ts, e.g. "commander") rather
	// than a union type here — data-model.ts imports nothing from
	// card-search.ts, to avoid any risk of circular dependency between these
	// two core/ files; view.ts/plugin.ts resolve the displayed label by
	// looking this key up in LEGALITY_SEARCH_FORMATS. Absent = no format
	// chosen (decks created before this feature, or created without a selected
	// format) — enables neither the format display nor the per-card legality
	// badge (see deckLegalityBadge, card-search.ts).
	format?: string;
	// "Choose cover image"/"Choose icon" (DeckSettingsModal, harmonized with
	// ListSettingsModal — see CollectionList.coverCardId/listIcon above for
	// the full reasoning, transposed as is). coverCardId identifies a DeckCard
	// by scryfallId rather than by id: DeckCard has no id field of its own
	// (see above), unlike CollectionCard.
	coverCardId?: string;
	deckIcon?: ListIcon;
}

// Search filter saved from "Add cards" ("Save filter" button, see
// add-cards-modal.ts) — a snapshot of the chip bar at the moment of saving:
// `tokens` are the raw tokens of chipTokens (already compatible as is with
// buildScryfallQueryFromChips/cardMatchesTokens, no transformation needed to
// re-apply them), `sortOverride` the active Scryfall sort if any (see
// AddCardsModal.sortOverride). Persisted as an ordinary setting (see
// saveSettings) — unlike plugin.ts's Scryfall caches, a combination of
// filters never becomes "stale", so no TTL here.
export interface SavedSearchFilter {
	id: string;
	label: string;
	tokens: string[];
	sortOverride: { order: string; dir: "asc" | "desc" } | null;
}

// Numeric summary of the content of a backup file (see
// MTGCollectionPlugin.exportBackup/parseBackupFile/restoreBackup) —
// deliberately a light subset (counters + the export date), not the data
// itself, displayed by RestoreBackupConfirmModal before confirming a
// restore (destructive: replaces the whole current
// collection/decks/wantlists).
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
	// Automatic backups (2026-09-02, see
	// MTGCollectionPlugin.maybeAutoBackup/runAutoBackup) — same
	// interval/timestamp scheme as priceRefreshIntervalHours/lastPriceRefresh
	// just above (0 = disabled, otherwise a number of hours). autoBackupFolder
	// is a folder path INSIDE the vault itself (not the plugin's private
	// folder — see runAutoBackup): these files must stay
	// visible/movable/syncable like any other vault file. autoBackupKeepCount
	// bounds how many automatic backups are kept before the oldest ones are
	// moved to the trash (never files that don't carry the "auto-" prefix, see
	// AUTO_BACKUP_FILE_PREFIX — a manual backup dropped in the same folder is
	// never affected).
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
	// Active "board" tab (see DeckBoardTab above) — global like
	// deckGroupBy/deckViewMode, not specific to a given deck: same convention
	// as the rest of My Decks' display state.
	deckActiveBoard: DeckBoardTab;
	wantlistGroupBy: GroupByOption;
	wantlistSortBy: SortByOption;
	wantlistSortReverse: boolean;
	wantlistGroupReverse: boolean;
	wantlistViewMode: CardViewMode;
	savedSearchFilters: SavedSearchFilter[];
	// Home's "Market Trends" block (2026-09-23): chosen period and vendor,
	// remembered from one session to the next — before, everything restarted
	// at "24h / all vendors" on every Home re-render (see
	// renderHomeMarketTrends). homeMoversVendor is "" for "all vendors": an
	// `undefined` would not survive the JSON serialization of data.json. An
	// older data.json doesn't have these fields: loadSettings/restoreBackup
	// fill them in via DEFAULT_SETTINGS, and the rendering ignores in any case
	// a value that is no longer a known period/vendor (hand-edited file, or a
	// vendor removed in a future version).
	homeMoversPeriod: CardbaseMoverPeriod;
	homeMoversVendor: CardbaseVendor | "";
	// Deletions to propagate between devices (see core/settings-merge.ts):
	// collection → entity key → deletion date. Absent as long as nothing has
	// been deleted; deliberately NOT in DEFAULT_SETTINGS (an object shared by
	// reference among all instances would be mutated by mistake).
	syncTombstones?: Record<string, Record<string, number>>;
	// Optional synchronization through a private GitHub repository
	// (src/plugin/github-sync.ts), in addition to Syncthing. Specific to each device
	// (core/device-settings.ts): the access token, for its part, is NEVER in these settings
	// (Obsidian's secret storage).
	githubSyncEnabled: boolean;
	githubRepo: string; // "owner/name"
	githubBranch: string;
	githubPath: string; // folder of the repository that contains data.json
	// API address, empty = api.github.com. Not in the interface: serves GitHub Enterprise and tests
	// against a fake server (tools/android/mock-github.mjs).
	githubApiBase: string;
	// Vault folder that contains the data file ("" = the plugin's folder, original behavior).
	// Specific to the device: it has to be known BEFORE the data can be read (see settings-sync.ts,
	// readSettingsFromDisk), and it must be the same on all the devices the user syncs with each
	// other.
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
