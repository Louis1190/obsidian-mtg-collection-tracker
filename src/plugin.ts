import { addIcon, Plugin } from "obsidian";
import { ONE_COLUMN_ICON_SVG } from "./ui/brand-assets";
import {
	ScryfallSetSummary,
	sanitizeSvg,
	ScryfallImmutableSnapshot,
} from "./api/scryfall";
import type { EntityPrints, KeySnapshot } from "./core/settings-merge";
import { CardKingdomPriceEntry } from "./api/card-kingdom";
import { ManaPoolCardPrices } from "./api/manapool";
import {
	CardbasePriceHistory,
	CardmarketNativePrices,
	CardbaseMoversResult,
} from "./api/cardbase";
import { UsdEurRate } from "./api/frankfurter";
import {
	MTGCollectionSettings,
	DEFAULT_SETTINGS,
	VIEW_TYPE_MTG_COLLECTION,
} from "./core/data-model";
import { MTGCollectionSettingTab } from "./setting-tab";
import { MTGCollectionView } from "./view";
import { HIDE_BARS_CLASS } from "./view/mobile-bars";
import * as scryfallCache from "./plugin/scryfall-cache";
import * as storePrices from "./plugin/store-prices";
import * as cardbaseCache from "./plugin/cardbase-cache";
import * as exchangeRate from "./plugin/exchange-rate";
import * as priceRefresh from "./plugin/price-refresh";
import * as lifecycle from "./plugin/lifecycle";
import * as backup from "./plugin/backup";
import * as settingsSync from "./plugin/settings-sync";
import * as githubSync from "./plugin/github-sync";
import * as migrations from "./plugin/migrations";
import * as collectionMutations from "./plugin/collection-mutations";
import * as wantlistMutations from "./plugin/wantlist-mutations";
import * as deckMutations from "./plugin/deck-mutations";
import * as importExport from "./plugin/import-export";
import { setSvgMarkup } from "./ui/svg-markup";


/* -------------------------------------------------------------------------- */
/*  Persistence validators, passed as arguments to loadPersistedMapCache      */
/*  (src/plugin/scryfall-cache.ts, since Phase 5's split on 2026-09-10)       */
/* -------------------------------------------------------------------------- */

// A malformed entry (corrupted file, format from an earlier plugin version
// that didn't write this field yet...) must be silently ignored on read,
// never crash the whole cache loading — each of these validators just
// describes "is this the expected shape", not a TypeScript type predicate
// (loadPersistedMapCache casts afterwards, see its own comment): avoids
// fighting with the strict exactness of generic type predicates for a
// simple filter when reading a JSON file.
function isStringOrNull(v: unknown): boolean {
	return v === null || typeof v === "string";
}
function isNumberOrNull(v: unknown): boolean {
	return v === null || typeof v === "number";
}
function isObjectOrNull(v: unknown): boolean {
	return v === null || (typeof v === "object" && !Array.isArray(v));
}
function isStringArray(v: unknown): boolean {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/* -------------------------------------------------------------------------- */
/*  Plugin main class                                                         */
/* -------------------------------------------------------------------------- */

export default class MTGCollectionPlugin extends Plugin {
	settings: MTGCollectionSettings = DEFAULT_SETTINGS;
	collectionRibbonIconEl: HTMLElement | null = null;
	setIconCache: Map<string, string | null> = new Map();
	// Persisted to disk (see allSetsCacheFilePath/loadPersistedAllSetsCache/persistAllSetsCache in
	// src/plugin/scryfall-cache.ts), UNLIKE the "immutable" caches to the right of this comment —
	// Scryfall regularly adds new sets (several times a month), so this list needs a real TTL
	// (ALL_SETS_CACHE_TTL_MS) rather than being persisted forever like
	// setIconCache/scryfallImmutableCache/etc. — separate mechanism, not the same as
	// loadPersistedMapCache (generic, with no notion of expiry).
	allSetsCache: ScryfallSetSummary[] | null = null;
	symbologyCache: Map<string, string> | null = null;
	symbologyFetchPromise: Promise<Map<string, string>> | null = null;
	// Persisted to disk (see loadPersistedMapCache/scheduleMapCachePersist in
	// src/plugin/scryfall-cache.ts) — same reasoning as setIconCache above, the languages actually
	// printed for a given printing don't change once that printing is out.
	printLanguagesCache: Map<string, string[]> = new Map();
	// Symbol requests (set/mana) already in flight, indexed by cache key:
	// prevents several rows displaying the same set/symbol at the same time
	// (initial render of a long list, for example) from each triggering their
	// own parallel network request for exactly the same data.
	setIconInFlight: Map<string, Promise<string | null>> = new Map();
	setIconFetchQueue: Promise<void> = Promise.resolve();
	manaSymbolInFlight: Map<string, Promise<string | null>> = new Map();
	// Legalities per card ("Legal Formats" block of the detail + the "legal:" filter of My
	// Collection, see card-search.ts): in-memory cache, fed at startup from a separate file persisted
	// on disk (see legalitiesCacheFilePath/loadPersistedLegalitiesCache/scheduleLegalitiesPersist in
	// src/plugin/scryfall-cache.ts) — NOT in settings.json/data.json like the rest of the plugin. Two
	// reasons: (1) it is a bulky object (23 keys per card now, potentially several MB for 10k cards)
	// that saveSettings() would rewrite in full on EVERY unrelated mutation (incrementing a quantity,
	// changing an accent color…), a real performance cost for data that itself changes very rarely;
	// (2) unlike the rest of the settings, this data goes stale with real time passing (rotations,
	// bans), not with a user action — a TTL (legalitiesFetchedAt + LEGALITIES_CACHE_TTL_MS,
	// src/plugin/scryfall-cache.ts) makes more sense carried by its own mechanism than mixed into the
	// settings blob, which has no notion of expiry. Only a successfully obtained result is cached
	// (and persisted) (never a transient failure), same logic as setIconCache/setIconInFlight.
	legalitiesCache: Map<string, Record<string, string>> = new Map();
	legalitiesInFlight: Map<string, Promise<Record<string, string> | null>> = new Map();
	// Timestamp (Date.now()) of the last SUCCESSFUL fetch per id — distinct
	// from legalitiesCache itself: the displayed value remains the cached one
	// even once expired (a week-old legality is very probably still correct,
	// better to display it right away than a "loading" state to re-verify data
	// almost certainly still good) — only the decision to RE-fetch
	// (isLegalitiesFresh, bulkFetchLegalities) consults this Map, never the
	// display.
	legalitiesFetchedAt: Map<string, number> = new Map();
	// Same grouping idiom as pendingSaveTimer further down (field) / SAVE_DEBOUNCE_MS (src/plugin/lifecycle.ts) for
	// saveSettings(), but over a longer delay: a complete pre-fetch of the collection (see
	// maybeAutoRefreshLegalities) resolves many ids one by one over several seconds — writing to disk on every
	// individual resolution would be far more writes than necessary for data that doesn't need to be persisted to
	// the millisecond.
	legalitiesPersistTimer: number | null = null;
	// Same idiom as legalitiesPersistTimer above / LEGALITIES_PERSIST_DEBOUNCE_MS
	// (src/plugin/scryfall-cache.ts), for setIconCache (see its own comment higher up) — a
	// separate file rather than a write grouped with the legalities: each cache of this plugin
	// has its own end-to-end persistence round trip (same reasoning already established for
	// scryfallImmutableCache below).
	// TCGplayer product link, rules text + stats ("Card Text"), front/back images ("flip" button)
	// and split info ("rotate" button) — 4 features which, until this merge (review of
	// 2026-08-18), each had their OWN cache + fetch end to end (a deliberate choice, documented
	// at the time for tcgplayerUrlCache: "each cache has its own round trip, no shared promise
	// between independent concepts"). This decoupling held for 1-2 caches, but at 4 it had a
	// real, measured cost: opening a card never seen this session pulled 4 nearly simultaneous
	// /cards/collection requests for the SAME scryfallId, each actually re-requesting the same
	// ScryfallCard object already fetched by the other 3. The 4 caches are therefore merged into
	// one, `scryfallImmutableCache` (see also getScryfallImmutableSnapshot in
	// src/plugin/scryfall-cache.ts) — a single fetch per card, from which the 4 public methods
	// (getTcgplayerUrl/getCardTextInfo/getCardFaceImages/getSplitCardInfo, signatures AND
	// behavior unchanged for their callers) derive their result synchronously. legalitiesCache
	// deliberately stays apart (see above): the only cache of this group with a real TTL, merging
	// it would have added complexity ("immutable" + "perishable" in a single mechanism) for a
	// marginal benefit — its own background warm-up already keeps it almost always warm by the
	// time a sheet opens. `null` is a valid, cached answer (card found but confirmed to have no
	// back/no TCGplayer link/etc. — a real result, not a failure); only a failure confirmed after
	// retry isn't cached. ScryfallImmutableSnapshot (scryfall.ts) deliberately excludes
	// prices/legalities — see its own comment for why.
	scryfallImmutableCache: Map<string, ScryfallImmutableSnapshot | null> = new Map();
	scryfallImmutableInFlight: Map<string, Promise<ScryfallImmutableSnapshot | null>> = new Map();
	// Card Kingdom pricelist ("Store Prices" block of the detail): same
	// reasoning as symbologyCache — a single file for the whole catalog, never
	// persisted (even more true here: ~67 MB, far too big for settings.json).
	cardKingdomPricesCache: Map<string, CardKingdomPriceEntry> | null = null;
	cardKingdomPricesFetchPromise: Promise<Map<string, CardKingdomPriceEntry>> | null = null;
	// Mana Pool pricelist (3rd "Store Prices" row): same reasoning as
	// cardKingdomPricesCache above — a single file for the whole catalog (~50
	// MB), never persisted.
	manaPoolPricesCache: Map<string, ManaPoolCardPrices> | null = null;
	manaPoolPricesFetchPromise: Promise<Map<string, ManaPoolCardPrices>> | null = null;
	// cardbase.dev price history ("Price History" box, under Store Prices):
	// per-printing endpoint, not a full catalog file — so the same per-ID shape
	// as legalitiesCache/scryfallImmutableCache above, not the "whole dataset"
	// shape of Card Kingdom/Mana Pool. Composite key scryfallId:finish (the same
	// card can be viewed under several finishes depending on the section —
	// Collection/Wantlist/Deck). A "confirmed success" result (even an empty
	// series — a card that truly has no history at these two stores) is cached;
	// only a network/HTTP failure isn't, see fetchCardbasePriceHistory.
	cardbasePriceHistoryCache: Map<string, CardbasePriceHistory | undefined> = new Map();
	cardbasePriceHistoryInFlight: Map<string, Promise<CardbasePriceHistory | undefined>> = new Map();
	// cardmarket_id (GET /printings/{scryfall_id}) and Cardmarket native price
	// (GET /cardmarket/{cardmarket_id}/prices, price_type="trend") — see
	// cardbase.ts for why these two endpoints exist in addition to
	// fetchCardbasePriceHistory above. `null` = confirmed response with no
	// result (no cardmarket_id for this printing, or "trend" price absent);
	// absent key = not yet requested — same distinction as
	// scryfallImmutableCache above. cardmarketIdCache is scryfallId → id,
	// cardmarketNativePricesCache is cardmarketId → result (a single
	// Cardmarket printing can be targeted by several scryfallIds — art
	// variants — so the two caches are deliberately separate rather than
	// composed into a single key). Only cardmarketIdCache is persisted to disk
	// (a product identifier doesn't change) — NOT cardmarketNativePricesCache
	// just below, which contains a real PRICE (changes daily, same exclusion
	// as cardKingdomPricesCache/manaPoolPricesCache/cardbasePriceHistoryCache
	// elsewhere in this file).
	cardmarketIdCache: Map<string, number | null> = new Map();
	cardmarketIdInFlight: Map<string, Promise<number | null>> = new Map();
	cardmarketNativePricesCache: Map<number, CardmarketNativePrices | undefined> = new Map();
	cardmarketNativePricesInFlight: Map<number, Promise<CardmarketNativePrices | undefined>> = new Map();
	// "Market Trends" results (GET /movers, Home dashboard block since
	// 2026-09-22 — see home-render.ts, formerly its own modal) — key
	// `${period}:${vendor ?? "all"}`, no deduplicated in-flight request
	// (unlike the caches above): a single block at a time triggers this fetch,
	// on user interaction (period/vendor change) rather than potentially in
	// competition from several rows of a same list like the other caches of
	// this file — the risk of an in-flight duplicate is therefore negligible
	// here.
	cardbaseMoversCache: Map<string, CardbaseMoversResult | undefined> = new Map();
	// USD/EUR exchange rate (frankfurter.dev), to unify the Y axis of the
	// "Price History" chart in a single currency (see card-detail-fx.ts) —
	// same "a single fetch per session" shape as symbologyCache/allSetsCache
	// above, not the per-ID shape of legalitiesCache: this plugin only tracks
	// a single currency pair (see PriceCurrency, price.ts), a single rate
	// covers the whole session.
	usdEurRateCache: UsdEurRate | null = null;
	usdEurRateFetchPromise: Promise<UsdEurRate | undefined> | null = null;

	// Fields moved from the methods area during the Phase 5 split (2026-09-10) -- they remain real
	// instance fields, just relocated here to stay grouped with the others.
	immutableCachePersistTimers: Map<string, number> = new Map();
	cachedArtists: string[] | null = null;
	cachedSets: { code: string; name: string }[] | null = null;
	pendingSaveTimer: number | null = null;
	dataVersion = 0;
	// Multi-device synchronization of data.json (src/plugin/settings-sync.ts).
	// diskText: content of data.json as THIS plugin knows it (its last write or what
	// it read); syncBaseText: last version coming from elsewhere (or read at
	// startup), starting point of the three-way merges — never advanced by our own
	// writes; diskSig: matching mtime+size, to avoid re-reading 6 MB on every check;
	// knownKeys: entities known at the last write, to spot deletions; persistChain:
	// queue that serializes every disk operation.
	diskText: string | null = null;
	syncBaseText: string | null = null;
	diskSig: settingsSync.DiskSignature | null = null;
	knownKeys: KeySnapshot | null = null;
	knownScalars: Record<string, string> | null = null;
	knownPrints: EntityPrints | null = null;
	persistChain: Promise<void> = Promise.resolve();
	externalCheckQueued = false;
	mergeWrites: number[] = [];
	settingsLoaded = false;
	saveFailed = false;
	saveRetryTimer: number | null = null;
	lastDeviceLocal: string | null = null;
	// Vault folder that contains the data file ("" = the plugin's folder), see settings-sync.ts.
	dataFolderInUse = "";
	// Synchronisation GitHub optionnelle (src/plugin/github-sync.ts).
	github: githubSync.GithubSyncState = githubSync.createGithubState();
	recentlyAddedCollectionCardIds = new Set<string>();
	recentlyAddedWantlistCardIds = new Set<string>();
	async onload() {
		await this.loadSettings();
		// Reloads the legalities cache persisted by a previous session (see
		// loadPersistedLegalitiesCache) before maybeAutoRefreshLegalities further
		// down, without which the latter would see no fresh entry and would
		// re-download the whole collection at every startup.
		await this.loadPersistedLegalitiesCache();
		// Same reasoning for the 4 "immutable" caches persisted separately (see
		// loadPersistedMapCache/loadPersistedAllSetsCache, and the comment of each
		// cache field concerned above) — before registerView further down, so that
		// a view restored by Obsidian at startup (leaf already open) displays its
		// content from its very first render rather than waiting for a Scryfall
		// round trip for each icon/text/link.
		await Promise.all([
			this.loadPersistedMapCache(scryfallCache.ICON_CACHE_FILENAME, this.setIconCache, isStringOrNull),
			this.loadPersistedMapCache(
				scryfallCache.SCRYFALL_IMMUTABLE_CACHE_FILENAME,
				this.scryfallImmutableCache,
				isObjectOrNull
			),
			this.loadPersistedMapCache(
				cardbaseCache.CARDMARKET_ID_CACHE_FILENAME,
				this.cardmarketIdCache,
				isNumberOrNull
			),
			this.loadPersistedMapCache(
				scryfallCache.PRINT_LANGUAGES_CACHE_FILENAME,
				this.printLanguagesCache,
				isStringArray
			),
			this.loadPersistedAllSetsCache(),
		]);

		// Custom icon for the "1 column" button (view.ts) -- registered once here
		// rather than at every render() of the view, since addIcon() adds the icon
		// to Obsidian's global library for the duration of the session.
		addIcon("mtg-one-column", ONE_COLUMN_ICON_SVG);

		this.registerView(
			VIEW_TYPE_MTG_COLLECTION,
			(leaf) => new MTGCollectionView(leaf, this)
		);

		this.refreshCollectionRibbonIcon();

		this.addCommand({
			id: "open-mtg-collection-view",
			name: "Open MTG collection view",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new MTGCollectionSettingTab(this.app, this));

		// Watches data.json outside of writes (another device via Syncthing) — see
		// src/plugin/settings-sync.ts. After loadSettings(), which primes the starting
		// state.
		this.setupSettingsSync();
		this.setupGithubSync();

		// Checks in the background whether the configured delay has elapsed
		// (doesn't block the plugin's loading). Then re-checks every hour in case
		// Obsidian stays open longer than the chosen interval.
		this.registerInterval(
			window.setInterval(() => void this.maybeAutoRefreshPrices(), 60 * 60 * 1000)
		);

		this.registerInterval(
			window.setInterval(() => void this.maybeAutoRefreshLegalities(), 60 * 60 * 1000)
		);

		// Automatic backups (see maybeAutoBackup just below / runAutoBackup in src/plugin/backup.ts) — same
		// hourly-check mechanism as the two above, but deliberately NOT chained into the sequential IIFE
		// further down: this pass never calls Scryfall (a purely local file write), so there is nothing to
		// serialize with the 4 network passes that follow.
		this.registerInterval(window.setInterval(() => void this.maybeAutoBackup(), 60 * 60 * 1000));
		void this.maybeAutoBackup();

		void (async () => {
			await this.maybeAutoRefreshPrices();
			await this.maybeAutoRefreshLegalities();
			// One-off catch-up of border/frame (see backfillBorderData) — no hourly
			// interval unlike the legalities above: once the whole collection is
			// covered, no need to ever pass again, this data never goes stale.
			await this.backfillBorderData();
			// Same reasoning, for the rules text (see backfillOracleTextData) — a
			// separate call rather than merged with backfillBorderData, see its own
			// comment.
			await this.backfillOracleTextData();
			// One-off catch-up of the price for existing decks (see
			// backfillDeckCardPrices) — unlike maybeAutoRefreshPrices at the very top
			// of this chain (gated by the configured interval, never guaranteed to run
			// right after this update if the last refresh is still recent), this
			// catch-up depends on no interval: it only looks at "does this deck
			// already have this field", once and for all, like the two just above.
			await this.backfillDeckCardPrices();
		})();
	}

	onunload() {
		// Immediately writes any save still pending (see saveSettings): without
		// it, disabling the plugin within the debounce window would lose the last
		// change.
		void this.flushPendingSave();
		// Best-effort sending of what is still waiting for GitHub (see flushGithubSync).
		void this.flushGithubSync();
		// Same reasoning for the legalities cache (see scheduleLegalitiesPersist)
		// — not awaited (Obsidian isn't guaranteed to await a Promise in
		// onunload()), but better than silently losing the last entries resolved
		// just before closing.
		if (this.legalitiesPersistTimer !== null) {
			window.clearTimeout(this.legalitiesPersistTimer);
			this.legalitiesPersistTimer = null;
			void this.flushLegalitiesPersist();
		}
		// Same reasoning for the 4 "immutable" caches persisted separately (see
		// scheduleMapCachePersist/flushPendingImmutableCaches).
		this.flushPendingImmutableCaches();
		// Belt and braces with the view's register() (src/view/mobile-bars.ts): a class left on
		// <body> would hide Obsidian's bars across the WHOLE app.
		document.body.removeClass(HIDE_BARS_CLASS);
	}

	refreshCollectionRibbonIcon() {
		if (this.collectionRibbonIconEl) {
			this.collectionRibbonIconEl.remove();
			this.collectionRibbonIconEl = null;
		}

		const el = this.addRibbonIcon("layers", "Open MTG collection", () => {
			void this.activateView();
		});
		el.addClass("mtg-ribbon-icon");

		const svg = this.settings.customIconSvg?.trim();
		if (svg) {
			el.empty();
			setSvgMarkup(el, sanitizeSvg(svg));
			const svgEl = el.querySelector("svg");
			if (svgEl) {
				svgEl.setAttribute("width", "18");
				svgEl.setAttribute("height", "18");
			}
		}

		if (this.settings.customIconColor) {
			el.style.color = this.settings.customIconColor;
		} else {
			el.style.removeProperty("color");
		}

		this.collectionRibbonIconEl = el;
	}

	// Applies the accent color chosen in the settings to all the currently
	// open collection views.
	refreshAccentColor() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof MTGCollectionView) {
				view.applyAccentColor();
			}
		});
	}

	// Applies settings.hideObsidianMobileBars to all the currently open
	// collection views (mobile-bars.ts, syncMobileBars only applies on phone
	// anyway). A change in Settings doesn't alter the active leaf — the only
	// thing that otherwise re-synchronizes (see mobile-bars.ts) — so it has to
	// be triggered explicitly here.
	refreshMobileBars() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof MTGCollectionView) {
				view.syncMobileBars();
			}
		});
	}

	// Forces a new render of all open collection views (e.g. after a change of
	// display currency in the settings).
	refreshOpenViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof MTGCollectionView) {
				view.render();
			}
		});
	}

	// Retrieves (and caches for the session) the SVG of the official set icon
	// supplied by Scryfall for a given set code.
	//
	// Two pitfalls avoided here, which made an icon load "sometimes yes,
	// sometimes no" depending on the session:
	// 1. A transient failure (rate limit, network cut...) was cached as "no
	//    icon" just like a real 404 — that set then never retried for the
	//    whole session, even once the cause of the problem had gone. "No icon"
	//    is now only cached on a confirmed 404 (the set really doesn't exist).
	// 2. Several rows displaying the same set at the same time (initial render
	//    of a long list) each triggered their own request for the same icon;
	//    setIconInFlight now makes them share a single request.
	// 3. Several DIFFERENT not-yet-cached SETS displayed at the same time
	//    (same scenario, but neither of the two pitfalls above applies since
	//    they are distinct codes) each triggered their own request IN
	//    PARALLEL, with no spacing at all — see setIconFetchQueue for the full
	//    reasoning and the Scryfall rate-limit bug this caused. A new fetch
	//    now chains on this queue rather than going out immediately.

	// -------------------------------------------------------------------
	// Method implementations below live in src/plugin/*.ts (split out on
	// 2026-09-10, see CLAUDE.md's "Architecture notes") -- each field is
	// still called exactly as this.plugin.methodName(...) everywhere else
	// in the codebase, unchanged; only WHERE the implementation lives
	// moved. This block is a manifest/index of the whole class's surface.
	// -------------------------------------------------------------------

	// -- Scryfall data: set icons, legalities, immutable per-card snapshot, set list, symbology, mana symbols, print languages (src/plugin/scryfall-cache.ts) --
	getSetIconSvg = scryfallCache.getSetIconSvg;
	fetchSetIconSvg = scryfallCache.fetchSetIconSvg;
	getCardLegalities = scryfallCache.getCardLegalities;
	getCachedLegalities = scryfallCache.getCachedLegalities;
	getLegalitiesCache = scryfallCache.getLegalitiesCache;
	isLegalitiesFresh = scryfallCache.isLegalitiesFresh;
	legalitiesCacheFilePath = scryfallCache.legalitiesCacheFilePath;
	loadPersistedLegalitiesCache = scryfallCache.loadPersistedLegalitiesCache;
	scheduleLegalitiesPersist = scryfallCache.scheduleLegalitiesPersist;
	flushLegalitiesPersist = scryfallCache.flushLegalitiesPersist;
	immutableCacheFilePath = scryfallCache.immutableCacheFilePath;
	scheduleMapCachePersist = scryfallCache.scheduleMapCachePersist;
	flushMapCachePersist = scryfallCache.flushMapCachePersist;
	flushPendingImmutableCaches = scryfallCache.flushPendingImmutableCaches;
	allSetsCacheFilePath = scryfallCache.allSetsCacheFilePath;
	loadPersistedAllSetsCache = scryfallCache.loadPersistedAllSetsCache;
	persistAllSetsCache = scryfallCache.persistAllSetsCache;
	maybeAutoRefreshLegalities = scryfallCache.maybeAutoRefreshLegalities;
	bulkFetchLegalities = scryfallCache.bulkFetchLegalities;
	fetchCardLegalities = scryfallCache.fetchCardLegalities;
	getScryfallImmutableSnapshot = scryfallCache.getScryfallImmutableSnapshot;
	getScryfallImmutableSnapshots = scryfallCache.getScryfallImmutableSnapshots;
	fetchScryfallImmutableSnapshot = scryfallCache.fetchScryfallImmutableSnapshot;
	getTcgplayerUrl = scryfallCache.getTcgplayerUrl;
	getCardTextInfo = scryfallCache.getCardTextInfo;
	getCardFaceImages = scryfallCache.getCardFaceImages;
	getSplitCardInfo = scryfallCache.getSplitCardInfo;
	getAllScryfallSets = scryfallCache.getAllScryfallSets;
	getCachedSetSummary = scryfallCache.getCachedSetSummary;
	loadSymbology = scryfallCache.loadSymbology;
	getManaSymbolSvg = scryfallCache.getManaSymbolSvg;
	fetchManaSymbolSvg = scryfallCache.fetchManaSymbolSvg;
	getAvailableLanguages = scryfallCache.getAvailableLanguages;
	loadPersistedMapCache = scryfallCache.loadPersistedMapCache;

	// -- Card Kingdom / Mana Pool price lists (src/plugin/store-prices.ts) --
	loadCardKingdomPrices = storePrices.loadCardKingdomPrices;
	getCardKingdomPrice = storePrices.getCardKingdomPrice;
	loadManaPoolPrices = storePrices.loadManaPoolPrices;
	getManaPoolPrice = storePrices.getManaPoolPrice;

	// -- cardbase.dev: price history, native Cardmarket prices, market movers (src/plugin/cardbase-cache.ts) --
	getCardbasePriceHistory = cardbaseCache.getCardbasePriceHistory;
	cardbasePrefetchWindow = cardbaseCache.cardbasePrefetchWindow;
	prefetchCardbaseNeighbors = cardbaseCache.prefetchCardbaseNeighbors;
	fetchCardbasePriceHistoryWithRetry = cardbaseCache.fetchCardbasePriceHistoryWithRetry;
	cardbaseDaysForTier = cardbaseCache.cardbaseDaysForTier;
	getCardbaseCardmarketId = cardbaseCache.getCardbaseCardmarketId;
	fetchCardmarketIdWithRetry = cardbaseCache.fetchCardmarketIdWithRetry;
	getCardmarketNativePrices = cardbaseCache.getCardmarketNativePrices;
	fetchCardmarketNativePricesWithRetry = cardbaseCache.fetchCardmarketNativePricesWithRetry;
	getCardbasePriceHistoryWithNativeCardmarket = cardbaseCache.getCardbasePriceHistoryWithNativeCardmarket;
	getCardbaseMovers = cardbaseCache.getCardbaseMovers;

	// -- USD/EUR exchange rate (src/plugin/exchange-rate.ts) --
	getUsdEurRate = exchangeRate.getUsdEurRate;

	// -- Refreshing the stored prices of cards (src/plugin/price-refresh.ts) --
	refreshAllPrices = priceRefresh.refreshAllPrices;
	maybeAutoRefreshPrices = priceRefresh.maybeAutoRefreshPrices;

	// -- Plugin lifecycle and settings load/save (src/plugin/lifecycle.ts) --
	activateView = lifecycle.activateView;
	loadSettings = lifecycle.loadSettings;
	runSettingsMigrations = lifecycle.runSettingsMigrations;
	saveSettings = lifecycle.saveSettings;
	flushPendingSave = lifecycle.flushPendingSave;
	getDistinctArtists = lifecycle.getDistinctArtists;
	getDistinctSets = lifecycle.getDistinctSets;

	// -- Backup / restore (src/plugin/backup.ts) --
	exportBackup = backup.exportBackup;
	parseBackupFile = backup.parseBackupFile;
	restoreBackup = backup.restoreBackup;
	maybeAutoBackup = backup.maybeAutoBackup;
	runAutoBackup = backup.runAutoBackup;
	pruneAutoBackups = backup.pruneAutoBackups;
	listBackupFiles = backup.listBackupFiles;
	readBackupFile = backup.readBackupFile;

	// -- Multi-device sync of data.json (src/plugin/settings-sync.ts) --
	readSettingsFromDisk = settingsSync.readSettingsFromDisk;
	markSettingsLoaded = settingsSync.markSettingsLoaded;
	loadDeviceLocalSettings = settingsSync.loadDeviceLocalSettings;
	saveDeviceLocalSettings = settingsSync.saveDeviceLocalSettings;
	persistSettings = settingsSync.persistSettings;
	checkForExternalChange = settingsSync.checkForExternalChange;
	onExternalSettingsChange = settingsSync.onExternalSettingsChange;
	setupSettingsSync = settingsSync.setupSettingsSync;
	changeDataFolder = settingsSync.changeDataFolder;

	// -- Optional GitHub sync of data.json (src/plugin/github-sync.ts) --
	getGithubToken = githubSync.getGithubToken;
	setGithubToken = githubSync.setGithubToken;
	githubSync = githubSync.githubSync;
	markGithubDirty = githubSync.markGithubDirty;
	flushGithubSync = githubSync.flushGithubSync;
	resetGithubSync = githubSync.resetGithubSync;
	githubTestNow = githubSync.githubTestNow;
	subscribeGithubStatus = githubSync.subscribeGithubStatus;
	githubHomeStatus = githubSync.githubHomeStatus;
	setupGithubSync = githubSync.setupGithubSync;


	// -- One-shot data migrations/backfills (src/plugin/migrations.ts) --
	migrateListDateCreated = migrations.migrateListDateCreated;
	migrateDeckDateCreated = migrations.migrateDeckDateCreated;
	migrateFoilSplit = migrations.migrateFoilSplit;
	ensureInboxList = migrations.ensureInboxList;
	migrateFoilToFinish = migrations.migrateFoilToFinish;
	migrateDamagedCondition = migrations.migrateDamagedCondition;
	migrateDeckCommanderCategory = migrations.migrateDeckCommanderCategory;
	backfillBorderData = migrations.backfillBorderData;
	backfillOracleTextData = migrations.backfillOracleTextData;
	backfillDeckCardPrices = migrations.backfillDeckCardPrices;
	migrateCollectionToLists = migrations.migrateCollectionToLists;
	migrateEnrichMetadata = migrations.migrateEnrichMetadata;
	migrateArtCropUrls = migrations.migrateArtCropUrls;
	migrateDeckCardDefaults = migrations.migrateDeckCardDefaults;
	migrateEnrichDeckMetadata = migrations.migrateEnrichDeckMetadata;

	// -- My Collection: cards + lists (src/plugin/collection-mutations.ts) --
	createListSilent = collectionMutations.createListSilent;
	getOrCreateListByName = collectionMutations.getOrCreateListByName;
	addCardToCollection = collectionMutations.addCardToCollection;
	changeCollectionCardCount = collectionMutations.changeCollectionCardCount;
	removeCollectionCard = collectionMutations.removeCollectionCard;
	undoAddToCollection = collectionMutations.undoAddToCollection;
	setCollectionCardLanguage = collectionMutations.setCollectionCardLanguage;
	setCollectionCardCondition = collectionMutations.setCollectionCardCondition;
	setCollectionCardFinish = collectionMutations.setCollectionCardFinish;
	setCollectionCardGrading = collectionMutations.setCollectionCardGrading;
	setCollectionCardCustomPrice = collectionMutations.setCollectionCardCustomPrice;
	setCollectionCardCount = collectionMutations.setCollectionCardCount;
	changeCollectionCardPrinting = collectionMutations.changeCollectionCardPrinting;
	findListDuplicateGroups = collectionMutations.findListDuplicateGroups;
	mergeListDuplicateGroup = collectionMutations.mergeListDuplicateGroup;
	mergeListDuplicates = collectionMutations.mergeListDuplicates;
	bulkRemoveCollectionCards = collectionMutations.bulkRemoveCollectionCards;
	bulkSetCollectionCardCondition = collectionMutations.bulkSetCollectionCardCondition;
	bulkSetCollectionCardLanguage = collectionMutations.bulkSetCollectionCardLanguage;
	bulkSetCollectionCardFinish = collectionMutations.bulkSetCollectionCardFinish;
	bulkSetCollectionCardCount = collectionMutations.bulkSetCollectionCardCount;
	createList = collectionMutations.createList;
	deleteList = collectionMutations.deleteList;
	clearList = collectionMutations.clearList;
	setListCoverCard = collectionMutations.setListCoverCard;
	setListIcon = collectionMutations.setListIcon;
	bulkDeleteLists = collectionMutations.bulkDeleteLists;
	mergeLists = collectionMutations.mergeLists;
	renameList = collectionMutations.renameList;
	copyCollectionCardToList = collectionMutations.copyCollectionCardToList;
	copyCollectionCardToWantlist = collectionMutations.copyCollectionCardToWantlist;
	moveCollectionCardToList = collectionMutations.moveCollectionCardToList;
	moveCollectionCardToWantlist = collectionMutations.moveCollectionCardToWantlist;

	// -- My Wantlists (src/plugin/wantlist-mutations.ts) --
	getOrCreateWantlistByName = wantlistMutations.getOrCreateWantlistByName;
	changeWantlistCardPrinting = wantlistMutations.changeWantlistCardPrinting;
	addCardToWantlist = wantlistMutations.addCardToWantlist;
	changeWantlistCardCount = wantlistMutations.changeWantlistCardCount;
	setWantlistCardCount = wantlistMutations.setWantlistCardCount;
	removeWantlistCard = wantlistMutations.removeWantlistCard;
	undoAddToWantlist = wantlistMutations.undoAddToWantlist;
	setWantlistCardFinish = wantlistMutations.setWantlistCardFinish;
	createWantlist = wantlistMutations.createWantlist;
	createWantlistSilent = wantlistMutations.createWantlistSilent;
	deleteWantlist = wantlistMutations.deleteWantlist;
	clearWantlist = wantlistMutations.clearWantlist;
	setWantlistCoverCard = wantlistMutations.setWantlistCoverCard;
	setWantlistIcon = wantlistMutations.setWantlistIcon;
	bulkDeleteWantlists = wantlistMutations.bulkDeleteWantlists;
	findWantlistDuplicateGroups = wantlistMutations.findWantlistDuplicateGroups;
	mergeWantlistDuplicateGroup = wantlistMutations.mergeWantlistDuplicateGroup;
	mergeWantlistDuplicates = wantlistMutations.mergeWantlistDuplicates;
	mergeWantlists = wantlistMutations.mergeWantlists;
	renameWantlist = wantlistMutations.renameWantlist;
	copyWantlistCardToWantlist = wantlistMutations.copyWantlistCardToWantlist;
	moveWantlistCardToWantlist = wantlistMutations.moveWantlistCardToWantlist;
	copyWantlistCardToList = wantlistMutations.copyWantlistCardToList;
	bulkRemoveWantlistCards = wantlistMutations.bulkRemoveWantlistCards;
	bulkSetWantlistCardFinish = wantlistMutations.bulkSetWantlistCardFinish;
	bulkSetWantlistCardCount = wantlistMutations.bulkSetWantlistCardCount;
	bulkMoveWantlistCardsToWantlist = wantlistMutations.bulkMoveWantlistCardsToWantlist;
	moveWantlistCardToCollection = wantlistMutations.moveWantlistCardToCollection;
	moveWantlistCardsToCollection = wantlistMutations.moveWantlistCardsToCollection;
	moveWantlistCardToCollectionNoSave = wantlistMutations.moveWantlistCardToCollectionNoSave;

	// -- My Decks (src/plugin/deck-mutations.ts) --
	changeDeckCardPrinting = deckMutations.changeDeckCardPrinting;
	createDeck = deckMutations.createDeck;
	setDeckFormat = deckMutations.setDeckFormat;
	clearDeck = deckMutations.clearDeck;
	setDeckCoverCard = deckMutations.setDeckCoverCard;
	setDeckIcon = deckMutations.setDeckIcon;
	deleteDeck = deckMutations.deleteDeck;
	bulkDeleteDecks = deckMutations.bulkDeleteDecks;
	renameDeck = deckMutations.renameDeck;
	copyDeck = deckMutations.copyDeck;
	createDeckSilent = deckMutations.createDeckSilent;
	mergeDeckDuplicates = deckMutations.mergeDeckDuplicates;
	mergeDecks = deckMutations.mergeDecks;
	addCardToDeck = deckMutations.addCardToDeck;
	addCollectionCardToDeck = deckMutations.addCollectionCardToDeck;
	addWantlistCardToDeck = deckMutations.addWantlistCardToDeck;
	changeDeckCardCount = deckMutations.changeDeckCardCount;
	removeDeckCard = deckMutations.removeDeckCard;
	setDeckCardFinish = deckMutations.setDeckCardFinish;
	setDeckCardCondition = deckMutations.setDeckCardCondition;
	setDeckCardLanguage = deckMutations.setDeckCardLanguage;
	setDeckCardCategory = deckMutations.setDeckCardCategory;
	setDeckCardFunction = deckMutations.setDeckCardFunction;
	setDeckCardGrading = deckMutations.setDeckCardGrading;
	setDeckCardCustomPrice = deckMutations.setDeckCardCustomPrice;
	undoAddToDeck = deckMutations.undoAddToDeck;
	copyDeckCardToList = deckMutations.copyDeckCardToList;
	moveDeckCardToList = deckMutations.moveDeckCardToList;
	copyDeckCardToWantlist = deckMutations.copyDeckCardToWantlist;
	moveDeckCardToWantlist = deckMutations.moveDeckCardToWantlist;
	copyDeckCardToDeck = deckMutations.copyDeckCardToDeck;
	moveDeckCardToDeck = deckMutations.moveDeckCardToDeck;
	bulkRemoveDeckCards = deckMutations.bulkRemoveDeckCards;
	bulkSetDeckCardCount = deckMutations.bulkSetDeckCardCount;
	bulkSetDeckCardCondition = deckMutations.bulkSetDeckCardCondition;
	bulkSetDeckCardLanguage = deckMutations.bulkSetDeckCardLanguage;
	bulkSetDeckCardFinish = deckMutations.bulkSetDeckCardFinish;
	bulkSetDeckCardCategory = deckMutations.bulkSetDeckCardCategory;
	bulkSetDeckCardFunction = deckMutations.bulkSetDeckCardFunction;

	// -- CSV/decklist import, saved search filters (src/plugin/import-export.ts) --
	importDecklistToDeck = importExport.importDecklistToDeck;
	importDeckCsv = importExport.importDeckCsv;
	importDecklistToList = importExport.importDecklistToList;
	importDecklistToWantlist = importExport.importDecklistToWantlist;
	importCsv = importExport.importCsv;
	importWantlistCsv = importExport.importWantlistCsv;
	saveSearchFilter = importExport.saveSearchFilter;
	deleteSearchFilter = importExport.deleteSearchFilter;

}
