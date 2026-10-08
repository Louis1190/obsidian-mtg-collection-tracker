import {
	ScryfallSetSummary,
	SCRYFALL_HEADERS,
	sanitizeSvg,
	sleep,
	fetchScryfallCollection,
	CardTextInfo,
	buildCardTextInfo,
	DoubleFacedImages,
	getDoubleFacedImages,
	SplitCardInfo,
	getSplitCardInfo as getSplitCardInfoFromScry,
	requestScryfall,
	ScryfallCard,
	ScryfallImmutableSnapshot,
} from "../api/scryfall";
import {
	VIEW_TYPE_MTG_COLLECTION,
} from "../core/data-model";
import { MTGCollectionView } from "../view";
import type MTGCollectionPlugin from "../plugin";
import { CARDMARKET_ID_CACHE_FILENAME } from "./cardbase-cache";

// fetchScryfallCollection catches HTTP statuses (an empty map, see its comment) but NOT a transport error:
// offline, TLS inspection on a corporate network, captive portal. The four getters of this file that use it feed
// the interface (detail sheet boxes, Home thumbnails) and already have a "confirmed failure" case (null, or card
// absent): a transport error now leads there too, instead of leaving the promise rejected — a frame left on its
// loading dots, an "in-flight" request (legalitiesInFlight) never resolved that blocked any later opening of
// that card. The cards already received before the error are kept. Imports, migrations and price refreshes call
// fetchScryfallCollection directly and keep the exception: the user must read the error there. No failure is
// cached.
async function fetchCollectionOrPartial(
	ids: string[],
	onChunkResolved?: (chunkResults: Map<string, ScryfallCard>) => void
): Promise<Map<string, ScryfallCard>> {
	const received = new Map<string, ScryfallCard>();
	try {
		await fetchScryfallCollection(ids, undefined, (chunkResults) => {
			chunkResults.forEach((card, id) => received.set(id, card));
			onChunkResolved?.(chunkResults);
		});
	} catch {
		/* see the comment above: what was received is returned, the rest is absent */
	}
	return received;
}

/* -------------------------------------------------------------------------- */
/*  External-data caching layer: Scryfall icons/legalities/symbology/
    immutable snapshot, Card Kingdom/Mana Pool/cardbase/frankfurter.ts
    wrappers, mana symbols, print languages. Split out of plugin.ts on
    2026-09-10 -- see CLAUDE.md's "Scryfall API usage" section.  */
/* -------------------------------------------------------------------------- */

export const ALL_SETS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ALL_SETS_CACHE_FILENAME = "all-sets-cache.json";
export const PRINT_LANGUAGES_CACHE_FILENAME = "print-languages-cache.json";
export const LEGALITIES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGALITIES_CACHE_FILENAME = "legalities-cache.json";
export const LEGALITIES_PERSIST_DEBOUNCE_MS = 3000;
export const ICON_CACHE_FILENAME = "icon-cache.json";
export const SCRYFALL_IMMUTABLE_CACHE_FILENAME = "scryfall-immutable-cache.json";
export const IMMUTABLE_CACHE_PERSIST_DEBOUNCE_MS = 3000;
export async function getSetIconSvg(this: MTGCollectionPlugin, setCode: string): Promise<string | null> {
	const cached = this.setIconCache.get(setCode);
	if (cached !== undefined) return cached;

	const inFlight = this.setIconInFlight.get(setCode);
	if (inFlight) return inFlight;

	const promise = this.setIconFetchQueue.then(() => this.fetchSetIconSvg(setCode));
	this.setIconInFlight.set(setCode, promise);
	void promise.finally(() => this.setIconInFlight.delete(setCode));
	// Advances the queue one notch once THIS fetch is launched (not only once
	// resolved, so as not to block a caller already waiting behind it): the
	// next new code waiting can only start once this one has finished, PLUS a
	// 120ms pause — the same pause as fetchScryfallCollection between its own
	// batches (Scryfall best practice). Both branches of the .then
	// (success/failure) do the same thing: fetchSetIconSvg never rejects
	// itself (its own try/catch always returns null), but handling both
	// remains a cheap guarantee against a future caller that would break this
	// invariant without knowing.
	this.setIconFetchQueue = promise.then(
		() => sleep(120),
		() => sleep(120)
	);
	return promise;
}


export async function fetchSetIconSvg(this: MTGCollectionPlugin, setCode: string): Promise<string | null> {
	try {
		const setRes = await requestScryfall({
			url: `https://api.scryfall.com/sets/${encodeURIComponent(setCode.toLowerCase())}`,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (setRes.status === 404) {
			this.setIconCache.set(setCode, null);
			this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
			return null;
		}
		if (setRes.status !== 200 || !(setRes.json as { icon_svg_uri?: string } | undefined)?.icon_svg_uri) {
			return null;
		}
		const svgRes = await requestScryfall({
			url: (setRes.json as { icon_svg_uri: string }).icon_svg_uri,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (svgRes.status !== 200) {
			return null;
		}
		const svg = sanitizeSvg(svgRes.text);
		this.setIconCache.set(setCode, svg);
		this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
		return svg;
	} catch {
		return null;
	}
}

// Does NOT consult isLegalitiesFresh (unlike bulkFetchLegalities further
// down) — deliberate: the periodic background warm-up
// (maybeAutoRefreshLegalities, every hour) already keeps the whole
// collection under LEGALITIES_CACHE_TTL_MS in the vast majority of cases,
// so an entry found here is almost always fresh anyway; adding the check
// here would force a network round trip on OPENING each detail sheet in
// the rare window where the entry has just expired, for a marginal gain.

export async function getCardLegalities(this: MTGCollectionPlugin, scryfallId: string): Promise<Record<string, string> | null> {
	const cached = this.legalitiesCache.get(scryfallId);
	if (cached !== undefined) return cached;

	const inFlight = this.legalitiesInFlight.get(scryfallId);
	if (inFlight) return inFlight;

	const promise = this.fetchCardLegalities(scryfallId);
	this.legalitiesInFlight.set(scryfallId, promise);
	void promise.finally(() => this.legalitiesInFlight.delete(scryfallId));
	return promise;
}

// Synchronous reading of the cache, without going through a Promise — used
// by renderLegalFormatsBox to set the tiles directly to their final state
// (no intermediate neutral state, hence no visible CSS transition) when
// the card has already been revealed in the open window: even a cache hit
// in getCardLegalities stays asynchronous (an async function always
// returns a Promise), which was enough to let the browser paint the
// neutral state one frame before the fix.

export function getCachedLegalities(this: MTGCollectionPlugin, scryfallId: string): Record<string, string> | undefined {
	return this.legalitiesCache.get(scryfallId);
}

// Bulk exposure of legalitiesCache for the "legal:" filter of My Collection
// (card-search.ts, cardMatchesTokens/legalityTokenMatches): cardMatchesTokens
// runs on potentially thousands of cards at once, a round trip per card via
// getCachedLegalities would be needlessly indirect when all that's needed is a
// simple Map.get(scryfallId) read. Returns the Map itself (not a copy) — read,
// never mutated, by the callers, same precedent as recentlyAddedCollectionCardIds
// (public field exposed as is) higher up in this file.

export function getLegalitiesCache(this: MTGCollectionPlugin): Map<string, Record<string, string>> {
	return this.legalitiesCache;
}

// True if legalitiesCache has an entry for this id AND it hasn't exceeded
// LEGALITIES_CACHE_TTL_MS — the only question that the FETCH methods below
// ask themselves ("do we need to ask again?"). Deliberately consulted by NO
// display path (getCachedLegalities, getLegalitiesCache, the Legal Formats
// block, the "legal:" filter): an expired entry remains a probably still
// correct result and is worth far more displayed right away than a
// "loading" state for data that, most of the time, has in fact not changed.

export function isLegalitiesFresh(this: MTGCollectionPlugin, scryfallId: string): boolean {
	const fetchedAt = this.legalitiesFetchedAt.get(scryfallId);
	return fetchedAt !== undefined && Date.now() - fetchedAt < LEGALITIES_CACHE_TTL_MS;
}


export function legalitiesCacheFilePath(this: MTGCollectionPlugin): string | null {
	// this.manifest.dir is in principle never absent for a plugin actually
	// loaded, but its Obsidian type declares it optional — silent degradation
	// to a session-only cache (behavior from before this feature) rather than
	// an error if ever.
	return this.manifest.dir ? `${this.manifest.dir}/${LEGALITIES_CACHE_FILENAME}` : null;
}

// Reloads, at startup, the cache written by a previous session (see
// scheduleLegalitiesPersist/flushLegalitiesPersist further down) — before
// maybeAutoRefreshLegalities decides what to (re)request from Scryfall. A
// missing file (first use), a corrupted one, or a malformed entry is never
// treated as a blocking error: in all these cases we simply start with an
// empty cache, exactly the behavior from before this feature.

export async function loadPersistedLegalitiesCache(this: MTGCollectionPlugin): Promise<void> {
	const path = this.legalitiesCacheFilePath();
	if (!path) return;
	try {
		if (!(await this.app.vault.adapter.exists(path))) return;
		const raw = await this.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as Record<
			string,
			{ legalities?: Record<string, string>; fetchedAt?: number }
		>;
		for (const [scryfallId, entry] of Object.entries(parsed)) {
			if (!entry?.legalities || typeof entry.fetchedAt !== "number") continue;
			this.legalitiesCache.set(scryfallId, entry.legalities);
			this.legalitiesFetchedAt.set(scryfallId, entry.fetchedAt);
		}
	} catch {
		// Silent by design — see the method's comment.
	}
}

// Deferred write (see LEGALITIES_PERSIST_DEBOUNCE_MS) triggered by any
// successful fetch (fetchCardLegalities/bulkFetchLegalities below), same
// idiom as pendingSaveTimer/saveSettings (src/plugin/lifecycle.ts) —
// grouping the close resolutions of a pre-fetch into a single write, not
// one per card.

export function scheduleLegalitiesPersist(this: MTGCollectionPlugin) {
	if (this.legalitiesPersistTimer !== null) window.clearTimeout(this.legalitiesPersistTimer);
	this.legalitiesPersistTimer = window.setTimeout(() => {
		this.legalitiesPersistTimer = null;
		void this.flushLegalitiesPersist();
	}, LEGALITIES_PERSIST_DEBOUNCE_MS);
}


export async function flushLegalitiesPersist(this: MTGCollectionPlugin): Promise<void> {
	const path = this.legalitiesCacheFilePath();
	if (!path) return;
	const out: Record<string, { legalities: Record<string, string>; fetchedAt: number }> = {};
	this.legalitiesCache.forEach((legalities, scryfallId) => {
		const fetchedAt = this.legalitiesFetchedAt.get(scryfallId);
		// An entry with no timestamp can only come from a future caller that would
		// write into legalitiesCache without going through
		// fetchCardLegalities/bulkFetchLegalities — doesn't exist today, but
		// better to silently omit it from the persisted file than crash on a
		// malformed entry.
		if (fetchedAt !== undefined) out[scryfallId] = { legalities, fetchedAt };
	});
	try {
		await this.app.vault.adapter.write(path, JSON.stringify(out));
	} catch {
		// Failed write (disk full, sync in progress…): the in-memory Map stays
		// correct for the rest of the session, and the next mutation of the cache
		// will retry the write.
	}
}

/* ------------------------------------------------------------------ */
/*  Generic persistence for small, effectively-immutable Scryfall      */
/*  caches (set icons/mana symbols, card text, TCGplayer/Cardmarket    */
/*  links, double-faced/split-card info, print languages) — factored   */
/*  into one shared mechanism once the same load/schedule/flush trio   */
/*  would otherwise have been hand-copied 7 times over (icon cache     */
/*  first, then 6 more requested the same session) — same "extract     */
/*  once duplication would reach one copy too many" reasoning already  */
/*  applied once in this plugin for addModalCloseButton/               */
/*  modal-animation.ts. legalitiesCache keeps its OWN separate          */
/*  mechanism (above): it genuinely needs a per-entry TTL/fetchedAt    */
/*  wrapper none of these 4 caches do, forcing it into this simpler    */
/*  shape would have complicated both for no benefit. allSetsCache     */
/*  (below) also stays separate — it needs a TTL too (new sets get     */
/*  added regularly), just a single one for the whole list rather      */
/*  than per-entry.                                                    */
/* ------------------------------------------------------------------ */

// A single Map of debounce timers, shared by the 4 caches above — key =
// file name, avoids a dedicated timer field per cache (7 today,
// potentially more tomorrow).


export function immutableCacheFilePath(this: MTGCollectionPlugin, filename: string): string | null {
	// Same silent degradation as legalitiesCacheFilePath above (manifest.dir
	// absent -> session-only cache, behavior from before this feature) if
	// ever.
	return this.manifest.dir ? `${this.manifest.dir}/${filename}` : null;
}

// Reloads, at startup, a cache written by a previous session — before the
// view's first render, so that as many rows/boxes as possible display their
// content from the first frame rather than waiting for a Scryfall round
// trip. A missing file (first use), corrupted, or a malformed entry
// (isValid) is never treated as a blocking error: in all these cases we
// simply start with an empty cache for that key — same posture as
// loadPersistedLegalitiesCache. isValid is a simple boolean predicate (not a
// TypeScript type guard) — see the comment of the validators
// isStringOrNull/isNumberOrNull/isObjectOrNull/isStringArray at the top of
// the file for why.

export function scheduleMapCachePersist(this: MTGCollectionPlugin, filename: string, map: ReadonlyMap<string, unknown>): void {
	const existing = this.immutableCachePersistTimers.get(filename);
	if (existing !== undefined) window.clearTimeout(existing);
	const timer = window.setTimeout(() => {
		this.immutableCachePersistTimers.delete(filename);
		void this.flushMapCachePersist(filename, map);
	}, IMMUTABLE_CACHE_PERSIST_DEBOUNCE_MS);
	this.immutableCachePersistTimers.set(filename, timer);
}


export async function flushMapCachePersist(this: MTGCollectionPlugin, filename: string, map: ReadonlyMap<string, unknown>): Promise<void> {
	const path = this.immutableCacheFilePath(filename);
	if (!path) return;
	try {
		await this.app.vault.adapter.write(path, JSON.stringify(Object.fromEntries(map)));
	} catch {
		// Failed write: the in-memory Map stays correct for the rest of the
		// session, the next mutation will retry the write — same reasoning as
		// flushLegalitiesPersist above.
	}
}

// Forces the immediate write of any debounce still pending for one of the
// 4 caches above (see onunload) — not awaited (Obsidian isn't guaranteed
// to await a Promise in onunload()), but better than silently losing the
// last entries resolved just before closing. Explicit list rather than a
// dynamic filename->Map registry: only 4 entries, more readable/greppable
// than an indirection for such a small number.

export function flushPendingImmutableCaches(this: MTGCollectionPlugin): void {
	const caches: [string, ReadonlyMap<string, unknown>][] = [
		[ICON_CACHE_FILENAME, this.setIconCache],
		[SCRYFALL_IMMUTABLE_CACHE_FILENAME, this.scryfallImmutableCache],
		[CARDMARKET_ID_CACHE_FILENAME, this.cardmarketIdCache],
		[PRINT_LANGUAGES_CACHE_FILENAME, this.printLanguagesCache],
	];
	caches.forEach(([filename, map]) => {
		const timer = this.immutableCachePersistTimers.get(filename);
		if (timer === undefined) return;
		window.clearTimeout(timer);
		this.immutableCachePersistTimers.delete(filename);
		void this.flushMapCachePersist(filename, map);
	});
}


export function allSetsCacheFilePath(this: MTGCollectionPlugin): string | null {
	return this.manifest.dir ? `${this.manifest.dir}/${ALL_SETS_CACHE_FILENAME}` : null;
}

// Reloads, at startup, the persisted list of sets if it is still fresh
// (ALL_SETS_CACHE_TTL_MS) — unlike the 4 caches above, an expired list is
// NOT loaded at all: allSetsCache stays `null`, and getAllScryfallSets()
// (further down) then falls back to its already existing behavior (network
// fetch on the first call of the session). A missing file, a corrupted
// one, or a malformed entry is never treated as a blocking error — same
// posture as the other persisted caches of this file.

export async function loadPersistedAllSetsCache(this: MTGCollectionPlugin): Promise<void> {
	const path = this.allSetsCacheFilePath();
	if (!path) return;
	try {
		if (!(await this.app.vault.adapter.exists(path))) return;
		const raw = await this.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as { fetchedAt?: number; sets?: ScryfallSetSummary[] };
		if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.sets)) return;
		if (Date.now() - parsed.fetchedAt >= ALL_SETS_CACHE_TTL_MS) return;
		this.allSetsCache = parsed.sets;
	} catch {
		// Silent by design — see the method's comment.
	}
}

// Writes immediately (no debounce here, unlike the 4 caches above): at
// most one call per session triggers this (getAllScryfallSets only
// re-fetches once allSetsCache is emptied/expired), not a burst of close
// resolutions to group. Fire-and-forget from its only caller
// (getAllScryfallSets) — must not delay the response already obtained for
// the real caller.

export async function persistAllSetsCache(this: MTGCollectionPlugin): Promise<void> {
	const path = this.allSetsCacheFilePath();
	if (!path || !this.allSetsCache) return;
	try {
		await this.app.vault.adapter.write(
			path,
			JSON.stringify({ fetchedAt: Date.now(), sets: this.allSetsCache })
		);
	} catch {
		// Failed write: allSetsCache stays correct in memory for the rest of the
		// session, only the persistence to disk failed.
	}
}


export async function maybeAutoRefreshLegalities(this: MTGCollectionPlugin): Promise<void> {
	const uniqueIds = Array.from(
		new Set(
			[...this.settings.collection, ...this.settings.wantlist]
				.filter((c) => c.scryfallId)
				.map((c) => c.scryfallId)
		)
	);
	if (uniqueIds.length === 0) return;
	const fetchedSomething = await this.bulkFetchLegalities(uniqueIds);
	// Same gesture as maybeAutoRefreshPrices (price-refresh.ts): a view
	// already open (restored by Obsidian at startup) must reflect the freshly
	// arrived data — a simple render(), nothing more intrusive than a price
	// refresh already is.
	if (fetchedSomething) {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			if (leaf.view instanceof MTGCollectionView) leaf.view.render();
		});
	}
}

// Background pre-fill of legalitiesCache for a whole list, triggered by
// MTGCollectionView as soon as a "legal:" token is active in My
// Collection's filter (see tokensNeedLegalityData, card-search.ts) —
// unlike getCardLegalities/fetchCardLegalities above (one round trip per
// card, for the "Legal Formats" block of a single detail sheet), this
// filter potentially needs the legalities of a whole list (even "All
// Cards") at once. Also the entry point of the silent warm-up at startup
// (see maybeAutoRefreshLegalities just above) — a single grouped fetch
// path for both uses rather than two implementations to keep in sync.
// fetchScryfallCollection already splits into batches of 75 with a pause
// between each batch (Scryfall best practice) — no need to reproduce that
// logic here, a single call is enough whatever the size of the list.
// "Missing" now means "absent OR expired" (see isLegalitiesFresh), not
// just "absent" as before the persisted cache/TTL was added — a fresh
// entry (loaded from disk or already refetched this session) is an
// immediate no-op.
// Returns `true` only if at least one missing/expired id was requested
// (hence if the cache could actually have changed): the two callers
// (renderListDetail, maybeAutoRefreshLegalities) use it to trigger a new
// render only when it is really useful, rather than on every pass (an
// unconditional render from renderListDetail would loop, since that render
// itself calls this method again).
// Bug reported twice — a newly added card displayed no legality, and more
// generally nothing displayed before the WHOLE fetch (potentially the
// entire collection, ~134 batches of 75) was finished — root-caused down
// to `fetchScryfallCollection`: the previous version of this method
// derived the Promise of EACH id from a single Promise shared over all of
// `missing`, itself resolved only after the VERY LAST batch — even the
// card whose data arrived in the first batch therefore had to wait for the
// ~133 following batches (several tens of seconds on a big collection). A
// newly added card was not different in itself — it simply happened, by
// bad luck, to be part of the same big shared batch (the silent warm-up at
// startup, or the fetch of a whole list filtered by "legal:") rather than
// getting its own isolated request. Fixed by resolving each id as soon as
// ITS OWN batch of 75 comes back (see onChunkResolved,
// fetchScryfallCollection) rather than at the very end of the whole set.

export async function bulkFetchLegalities(this: MTGCollectionPlugin, scryfallIds: string[]): Promise<boolean> {
	const missing = Array.from(new Set(scryfallIds)).filter(
		(id) => id && !this.isLegalitiesFresh(id) && !this.legalitiesInFlight.has(id)
	);
	if (missing.length === 0) return false;

	// One resolver per id (external-executor Promise pattern) rather than a
	// Promise derived from a single final result — this is what allows
	// onChunkResolved below to resolve each id individually, as soon as its
	// own batch comes back, instead of everyone waiting for the last batch
	// together.
	const resolvers = new Map<string, (legalities: Record<string, string> | null) => void>();
	missing.forEach((id) => {
		const perId = new Promise<Record<string, string> | null>((resolve) => resolvers.set(id, resolve));
		this.legalitiesInFlight.set(id, perId);
		void perId.finally(() => this.legalitiesInFlight.delete(id));
	});

	await fetchCollectionOrPartial(missing, (chunkResults) => {
		const now = Date.now();
		chunkResults.forEach((card, id) => {
			if (!card.legalities) return;
			this.legalitiesCache.set(id, card.legalities);
			this.legalitiesFetchedAt.set(id, now);
			resolvers.get(id)?.(card.legalities);
			resolvers.delete(id);
		});
	});

	// An id still unresolved here (failed batch — see the comment of
	// fetchCardLegalities further down — or a card not found on Scryfall's
	// side) must still see its Promise end, otherwise legalitiesInFlight would
	// keep it "in flight" indefinitely, silently blocking any future call for
	// that same id.
	resolvers.forEach((resolve) => resolve(null));

	this.scheduleLegalitiesPersist();
	return true;
}

// A failed round trip (rate limit, network cut) on this grouped endpoint
// returns an empty map without throwing (see fetchScryfallCollection) —
// without a new attempt, the card would then silently miss its legality
// for the whole duration of that window (no cache written on failure, so a
// future reopening would eventually retry, but not the current opening). A
// single retry after a short pause is enough to absorb the vast majority
// of purely transient failures.

export async function fetchCardLegalities(this: MTGCollectionPlugin, scryfallId: string): Promise<Record<string, string> | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const map = await fetchCollectionOrPartial([scryfallId]);
		const card = map.get(scryfallId);
		if (card?.legalities) {
			this.legalitiesCache.set(scryfallId, card.legalities);
			this.legalitiesFetchedAt.set(scryfallId, Date.now());
			this.scheduleLegalitiesPersist();
			return card.legalities;
		}
		if (attempt === 0) await sleep(300);
	}
	return null;
}

// Entry point shared by the 4 derivations below
// (getTcgplayerUrl/getCardTextInfo/getCardFaceImages/getSplitCardInfo) —
// cache + shared in-flight request + retry, same idiom as getCardLegalities
// higher up. The in-flight dedup does all the work to avoid a burst: the 4
// public methods each call this one independently (they don't know about
// each other) when a card sheet opens, but since none awaits a network
// result before the 3 others have themselves called this method in the same
// synchronous tick, only the FIRST actually triggers
// fetchScryfallCollection — the following 3 find the promise already set in
// scryfallImmutableInFlight and wait on it instead of a new network call.
// See ScryfallImmutableSnapshot (scryfall.ts) for the detail of the fields
// kept/excluded.

export async function getScryfallImmutableSnapshot(this: MTGCollectionPlugin, 
	scryfallId: string
): Promise<ScryfallImmutableSnapshot | null> {
	const cached = this.scryfallImmutableCache.get(scryfallId);
	if (cached !== undefined) return cached;

	const inFlight = this.scryfallImmutableInFlight.get(scryfallId);
	if (inFlight) return inFlight;

	const promise = this.fetchScryfallImmutableSnapshot(scryfallId);
	this.scryfallImmutableInFlight.set(scryfallId, promise);
	void promise.finally(() => this.scryfallImmutableInFlight.delete(scryfallId));
	return promise;
}

// Same retry logic as fetchCardLegalities above.

export async function fetchScryfallImmutableSnapshot(this: MTGCollectionPlugin, 
	scryfallId: string
): Promise<ScryfallImmutableSnapshot | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const map = await fetchCollectionOrPartial([scryfallId]);
		const card = map.get(scryfallId);
		if (card) {
			const snapshot: ScryfallImmutableSnapshot = {
				oracle_text: card.oracle_text,
				power: card.power,
				toughness: card.toughness,
				loyalty: card.loyalty,
				card_faces: card.card_faces,
				purchase_uris: card.purchase_uris,
				image_uris: card.image_uris,
				layout: card.layout,
				keywords: card.keywords,
				set: card.set,
				set_name: card.set_name,
				collector_number: card.collector_number,
				rarity: card.rarity,
				mana_cost: card.mana_cost,
				type_line: card.type_line,
			};
			this.scryfallImmutableCache.set(scryfallId, snapshot);
			this.scheduleMapCachePersist(
				SCRYFALL_IMMUTABLE_CACHE_FILENAME,
				this.scryfallImmutableCache
			);
			return snapshot;
		}
		if (attempt === 0) await sleep(300);
	}
	return null;
}

// Batch variant of the function above, for Home's Market Trends
// (renderHomeMarketTrends, view/home-render.ts): up to 10 movers
// (gainers+losers) displayed at once, each with its own image/set/rarity to
// display — resolving them one by one via getScryfallImmutableSnapshot would
// make 10 sequential HTTP round trips (same bottleneck as
// fetchScryfallImmutableSnapshot above, which already calls /cards/collection
// but with a single id each time) whereas a single call to
// fetchScryfallCollection with all the ids already covers this volume in a
// single batch of 75. Shares the SAME cache as the singular version (an id
// resolved by one benefits the other) rather than a separate cache — see
// "Scryfall API usage" in CLAUDE.md ("a single shared cache rather than N
// separate ones"). cached.set !== undefined (not just cached !== undefined): a
// snapshot cached by a session BEFORE the widening of
// ScryfallImmutableSnapshot (set/set_name/collector_number/rarity, see its own
// comment in scryfall.ts) doesn't have these fields in practice — treating it
// as a cache miss re-fetches and completes that entry for good, rather than
// returning an incomplete snapshot or invalidating the whole existing disk
// cache.
export async function getScryfallImmutableSnapshots(this: MTGCollectionPlugin,
	scryfallIds: string[]
): Promise<Map<string, ScryfallImmutableSnapshot>> {
	const result = new Map<string, ScryfallImmutableSnapshot>();
	const missing: string[] = [];
	for (const id of new Set(scryfallIds)) {
		const cached = this.scryfallImmutableCache.get(id);
		if (cached && cached.set !== undefined) result.set(id, cached);
		else missing.push(id);
	}
	if (missing.length === 0) return result;

	const fetched = await fetchCollectionOrPartial(missing);
	for (const id of missing) {
		const card = fetched.get(id);
		if (!card) continue;
		const snapshot: ScryfallImmutableSnapshot = {
			oracle_text: card.oracle_text,
			power: card.power,
			toughness: card.toughness,
			loyalty: card.loyalty,
			card_faces: card.card_faces,
			purchase_uris: card.purchase_uris,
			image_uris: card.image_uris,
			layout: card.layout,
			keywords: card.keywords,
			set: card.set,
			set_name: card.set_name,
			collector_number: card.collector_number,
			rarity: card.rarity,
			mana_cost: card.mana_cost,
			type_line: card.type_line,
		};
		this.scryfallImmutableCache.set(id, snapshot);
		result.set(id, snapshot);
	}
	this.scheduleMapCachePersist(SCRYFALL_IMMUTABLE_CACHE_FILENAME, this.scryfallImmutableCache);
	return result;
}

// TCGplayer product link ("TCGplayer" row of the Store Prices box). `null`
// is a valid answer (card with no TCGplayer link, e.g. token/art card); a
// snapshot not found after retry also returns `null` but without being
// cached by getScryfallImmutableSnapshot itself, to allow a new attempt
// later in the session.

export async function getTcgplayerUrl(this: MTGCollectionPlugin, scryfallId: string): Promise<string | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot?.purchase_uris?.tcgplayer ?? null;
}

// Rules text + stats ("Card Text" block of the detail) — see
// buildCardTextInfo (scryfall.ts) for the card_faces fallback on
// double-faced cards. `null` only if the snapshot itself is not found; an
// empty oracle_text (vanilla creature) is a very real CardTextInfo.

export async function getCardTextInfo(this: MTGCollectionPlugin, scryfallId: string): Promise<CardTextInfo | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot ? buildCardTextInfo(snapshot) : null;
}

// 3D "flip" button under the card (transform/modal_dfc only — see
// getDoubleFacedImages, scryfall.ts, for how this function tells a real
// physical front/back card from a split/adventure/flip/meld layout, which
// also has a card_faces[] but only one printed visual).

export async function getCardFaceImages(this: MTGCollectionPlugin, scryfallId: string): Promise<DoubleFacedImages | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot ? getDoubleFacedImages(snapshot) : null;
}

// "Rotation" button of split cards (see getSplitCardInfo, scryfall.ts, and
// setupSplitCardRotation, card-detail-fx.ts).

export async function getSplitCardInfo(this: MTGCollectionPlugin, scryfallId: string): Promise<SplitCardInfo | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot ? getSplitCardInfoFromScry(snapshot) : null;
}

// Complete list of existing sets (name + code + symbol), fetched once per
// session via Scryfall's single grouped endpoint — avoids a round trip per
// set. Serves for the autocompletion of the "Set" field in the add search,
// in place of a code to know by heart.

export async function getAllScryfallSets(this: MTGCollectionPlugin): Promise<ScryfallSetSummary[]> {
	if (this.allSetsCache) return this.allSetsCache;
	try {
		const res = await requestScryfall({
			url: "https://api.scryfall.com/sets",
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (res.status !== 200) return [];
		const sets = (res.json as { data?: ScryfallSetSummary[] }).data ?? [];
		// Digital sets (Arena) make no sense for a physical-card plugin.
		this.allSetsCache = sets.filter((s) => !s.digital);
		// Fire-and-forget: doesn't delay the response already obtained for the
		// real caller, see the comment of persistAllSetsCache.
		void this.persistAllSetsCache();
		return this.allSetsCache;
	} catch {
		return [];
	}
}

// Synchronous reading of the already loaded cache (for the immediate
// display of a "set:xyz" chip without waiting for a network round trip).
// Returns undefined if the cache is not warm yet — the caller then falls
// back on the raw uppercase code.

export function getCachedSetSummary(this: MTGCollectionPlugin, code: string): ScryfallSetSummary | undefined {
	return this.allSetsCache?.find((s) => s.code.toLowerCase() === code.toLowerCase());
}

// Loads (once per session) the complete table of Scryfall symbols. Only
// writes symbologyCache on a confirmed success: a transient failure must
// not freeze an empty table for the rest of the session (it then deprived
// ALL mana symbols of an icon, not only the one requested at the time of
// the failure).

export async function loadSymbology(this: MTGCollectionPlugin): Promise<Map<string, string>> {
	if (this.symbologyCache) return this.symbologyCache;
	if (!this.symbologyFetchPromise) {
		this.symbologyFetchPromise = (async () => {
			const res = await requestScryfall({
				url: "https://api.scryfall.com/symbology",
				headers: SCRYFALL_HEADERS,
				throw: false,
			});
			if (res.status !== 200) {
				this.symbologyFetchPromise = null;
				throw new Error(`Scryfall symbology request failed (${res.status})`);
			}
			const map = new Map<string, string>();
			(res.json as { data: { symbol: string; svg_uri: string }[] }).data.forEach((sym) => {
				map.set(sym.symbol, sym.svg_uri);
			});
			this.symbologyCache = map;
			return map;
		})();
	}
	return this.symbologyFetchPromise;
}

// Retrieves the official icon of a mana symbol (W/U/B/R/G/C...) supplied by
// Scryfall via its "symbology" endpoint, designed for this third-party use.

export async function getManaSymbolSvg(this: MTGCollectionPlugin, colorLetter: string): Promise<string | null> {
	const cacheKey = `mana:${colorLetter}`;
	const cached = this.setIconCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const inFlight = this.manaSymbolInFlight.get(cacheKey);
	if (inFlight) return inFlight;

	const promise = this.fetchManaSymbolSvg(colorLetter, cacheKey);
	this.manaSymbolInFlight.set(cacheKey, promise);
	void promise.finally(() => this.manaSymbolInFlight.delete(cacheKey));
	return promise;
}


export async function fetchManaSymbolSvg(this: MTGCollectionPlugin, colorLetter: string, cacheKey: string): Promise<string | null> {
	try {
		const symbology = await this.loadSymbology();
		const uri = symbology.get(`{${colorLetter}}`);
		if (!uri) {
			// A letter that matches no known Scryfall symbol: not a network matter, no
			// point retrying.
			this.setIconCache.set(cacheKey, null);
			this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
			return null;
		}
		const svgRes = await requestScryfall({ url: uri, headers: SCRYFALL_HEADERS, throw: false });
		if (svgRes.status !== 200) {
			return null;
		}
		const svg = sanitizeSvg(svgRes.text);
		this.setIconCache.set(cacheKey, svg);
		this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
		return svg;
	} catch {
		return null;
	}
}

// Some sets (Alpha, Beta...) only existed in English. We query Scryfall to
// offer, in the language picker, only the languages actually printed for
// this given set + number.

export async function getAvailableLanguages(this: MTGCollectionPlugin, setCode: string, collectorNumber: string): Promise<string[]> {
	const cacheKey = `${setCode.toLowerCase()}:${collectorNumber}`;
	const cached = this.printLanguagesCache.get(cacheKey);
	if (cached) return cached;

	try {
		const query = encodeURIComponent(
			`set:${setCode.toLowerCase()} cn:${collectorNumber} lang:any`
		);
		const res = await requestScryfall({
			url: `https://api.scryfall.com/cards/search?q=${query}&unique=prints`,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (res.status !== 200) {
			// HTTP failure — not necessarily transient (e.g. 404 for an invalid
			// set/number combination) but not a confirmed Scryfall response either.
			// Bug found while adding disk persistence to this cache: this branch used
			// to cache ["en"] until now, which — in memory, for the length of a
			// session — was already debatable (a one-off network outage could freeze
			// ["en"] for the rest of the session), but would have become far worse
			// once persisted (a one-off outage would have frozen ["en"] for this
			// printing in ALL future sessions). Fixed: nothing is cached here any
			// more, only a confirmed 200 (even with an empty result, see further down)
			// is remembered.
			return ["en"];
		}
		const langs = Array.from(
			new Set((res.json as { data: { lang: string }[] }).data.map((c) => c.lang))
		);
		const result = langs.length > 0 ? langs : ["en"];
		this.printLanguagesCache.set(cacheKey, result);
		this.scheduleMapCachePersist(
			PRINT_LANGUAGES_CACHE_FILENAME,
			this.printLanguagesCache
		);
		return result;
	} catch {
		// Network/parsing failure — transient by nature, never cached (same rule
		// as getSetIconSvg/getCardLegalities elsewhere in this file, and same
		// reasoning as the branch above).
		return ["en"];
	}
}


/* --------------------------- Bulk actions ------------------------------ */


export async function loadPersistedMapCache<T>(this: MTGCollectionPlugin, 
	filename: string,
	map: Map<string, T>,
	isValid: (value: unknown) => boolean
): Promise<void> {
	const path = this.immutableCacheFilePath(filename);
	if (!path) return;
	try {
		if (!(await this.app.vault.adapter.exists(path))) return;
		const raw = await this.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		for (const [key, value] of Object.entries(parsed)) {
			if (!isValid(value)) continue;
			map.set(key, value as T);
		}
	} catch {
		// Silent by design — see the method's comment.
	}
}

// Deferred write (groups the close resolutions of an initial render into a
// single write, same idiom as scheduleLegalitiesPersist) — map is already
// exactly the shape we want to write (key -> value), no need for a {value,
// timestamp} wrapper per entry as for the legalities, which have a TTL to
// enforce.
