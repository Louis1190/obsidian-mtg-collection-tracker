import { CardbaseFinish, CardbasePriceHistory, fetchCardbasePriceHistory, fetchCardbasePrintingCardmarketId, CardmarketNativePrices, fetchCardmarketNativePrices, withNativeCardmarketTrend, pickCardmarketTrendSeries, pickCardmarketLatestPrice, fetchCardbaseMovers, CardbaseVendor, CardbaseMoversResult, CardbaseMoverPeriod } from "../api/cardbase";
import { sleep } from "../api/scryfall";
import type MTGCollectionPlugin from "../plugin";

/* ---------------------------------------------------------------------------- */
/* cardbase.dev: price history, native Cardmarket prices, market trends (MTGCollectionPlugin). */
/* ---------------------------------------------------------------------------- */

export const CARDMARKET_ID_CACHE_FILENAME = "cardmarket-id-cache.json";
// See getCardLegalities/getTcgplayerUrl (scryfall-cache.ts) for the reasoning
// (cache + in-flight request shared by composite key scryfallId:finish).

export async function getCardbasePriceHistory(this: MTGCollectionPlugin, 
	scryfallId: string,
	finish: CardbaseFinish
): Promise<CardbasePriceHistory | undefined> {
	const cacheKey = `${scryfallId}:${finish}`;
	const cached = this.cardbasePriceHistoryCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const inFlight = this.cardbasePriceHistoryInFlight.get(cacheKey);
	if (inFlight) return inFlight;

	const promise = this.fetchCardbasePriceHistoryWithRetry(cacheKey, scryfallId, finish);
	this.cardbasePriceHistoryInFlight.set(cacheKey, promise);
	void promise.finally(() => this.cardbasePriceHistoryInFlight.delete(cacheKey));
	return promise;
}
// Background preloading window (neighboring cards in Cover Flow, see
// CardDetailModal/WantlistCardDetailModal/DeckCardDetailModal.schedulePrefetchNeighbors)
// — wider with a cardbase key (60 req/min tier) than without (10 req/min
// tier, see fetchCardbasePriceHistoryWithRetry below for the same
// reasoning about `days`). Deliberately conservative even with a key: this
// preloading adds to the request of the card actually displayed, which
// must always go first and stay fast.

export function cardbasePrefetchWindow(this: MTGCollectionPlugin): number {
	return this.settings.cardbaseApiKey ? 5 : 2;
}
// Preloads in the background the cardbase history of the neighboring cards
// (prev/next) of a navigation list, so that they are already in cache — or
// already in flight — by the time the user actually clicks on them.
// `items` has the same length/the same order as the caller's navigation
// list, a `null` marking entries to skip (Proxy card — no Price History
// box for it, see renderPriceHistoryBox). Strictly sequential, never in
// parallel: cardbase's rate limit (10-60 req/min depending on the key, see
// cardbasePrefetchWindow) is shared with the card currently displayed, so
// a parallel preloading burst could slow down THAT request — the one that
// matters most. getCardbasePriceHistory already deduplicates
// cache/in-flight by itself, so calling this method for an already known
// card costs nothing more than a Map read; the 120ms pause is only
// inserted after a genuine network round trip (not after a cache hit), so
// as not to needlessly slow down a preloading already largely satisfied by
// the session cache.

export async function prefetchCardbaseNeighbors(this: MTGCollectionPlugin, 
	items: ({ scryfallId: string; finish: CardbaseFinish } | null)[],
	centerIndex: number
): Promise<void> {
	const window = this.cardbasePrefetchWindow();
	const order: number[] = [];
	for (let d = 1; d <= window; d++) {
		if (centerIndex + d < items.length) order.push(centerIndex + d);
		if (centerIndex - d >= 0) order.push(centerIndex - d);
	}
	for (const idx of order) {
		const item = items[idx];
		if (!item) continue;
		const cacheKey = `${item.scryfallId}:${item.finish}`;
		const alreadyKnown = this.cardbasePriceHistoryCache.has(cacheKey);
		await this.getCardbasePriceHistory(item.scryfallId, item.finish);
		if (!alreadyKnown) await sleep(120);
	}
}
// Same retry logic as fetchCardLegalities/fetchTcgplayerUrl — a single
// retry after a short pause before giving up without caching the failure
// (so that a future request in the same session retries rather than stay
// stuck on "no data").
//
// `days` depending on the presence of a key: contrary to what the cardbase
// docs say ("silently capped to the tier limit"), a direct test against
// the real API shows that a `days` beyond the tier returns a real 400
// error ("days must be 30 or fewer for your access tier"), not a silent
// cap — asking for 365 without a valid key therefore made the request fail
// for sure (twice, with the 300ms pause between the two), hence a good
// part of the perceived slowness as long as no key is registered.

export async function fetchCardbasePriceHistoryWithRetry(this: MTGCollectionPlugin, 
	cacheKey: string,
	scryfallId: string,
	finish: CardbaseFinish
): Promise<CardbasePriceHistory | undefined> {
	const days = this.cardbaseDaysForTier();
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await fetchCardbasePriceHistory(scryfallId, this.settings.cardbaseApiKey, finish, days);
		if (result) {
			this.cardbasePriceHistoryCache.set(cacheKey, result);
			return result;
		}
		if (attempt === 0) await sleep(300);
	}
	return undefined;
}
// Depth tier of the cardbase history (see
// fetchCardbasePriceHistoryWithRetry above for the full reasoning) —
// extracted here to be shared with fetchCardmarketNativePricesWithRetry
// below, which asks for the same window of days to stay consistent with
// the generic history already displayed next to it.

export function cardbaseDaysForTier(this: MTGCollectionPlugin): number {
	return this.settings.cardbaseApiKey ? 365 : 30;
}
// cardmarket_id of a printing (GET /printings/{scryfall_id}, see cardbase.ts) —
// same cache+in-flight-request scheme as getTcgplayerUrl (scryfall-cache.ts),
// `null` cached for a confirmed absence (printing not mapped on the Cardmarket
// side by cardbase), not for a network failure.

export async function getCardbaseCardmarketId(this: MTGCollectionPlugin, scryfallId: string): Promise<number | null> {
	const cached = this.cardmarketIdCache.get(scryfallId);
	if (cached !== undefined) return cached;

	const inFlight = this.cardmarketIdInFlight.get(scryfallId);
	if (inFlight) return inFlight;

	const promise = this.fetchCardmarketIdWithRetry(scryfallId);
	this.cardmarketIdInFlight.set(scryfallId, promise);
	void promise.finally(() => this.cardmarketIdInFlight.delete(scryfallId));
	return promise;
}
// Same retry logic as fetchCardLegalities/fetchTcgplayerUrl — a single
// retry after a short pause. undefined (transient network/HTTP failure)
// and null (404, or 200 without cardmarket_id) are both normalized to
// `null` here: on the caller side
// (getCardbasePriceHistoryWithNativeCardmarket below), both translate
// anyway into the same graceful fallback (keep the old "retail" value).

export async function fetchCardmarketIdWithRetry(this: MTGCollectionPlugin, scryfallId: string): Promise<number | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await fetchCardbasePrintingCardmarketId(scryfallId, this.settings.cardbaseApiKey);
		if (result !== undefined) {
			this.cardmarketIdCache.set(scryfallId, result);
			this.scheduleMapCachePersist(CARDMARKET_ID_CACHE_FILENAME, this.cardmarketIdCache);
			return result;
		}
		if (attempt === 0) await sleep(300);
	}
	return null;
}
// Cardmarket native price (GET /cardmarket/{cardmarket_id}/prices, see
// cardbase.ts) — same cache+in-flight-request scheme as
// getCardbasePriceHistory above, keyed by cardmarketId (not scryfallId:
// several Scryfall printings/art variants can share the same Cardmarket
// product, may as well share the cache between them).

export async function getCardmarketNativePrices(this: MTGCollectionPlugin, cardmarketId: number): Promise<CardmarketNativePrices | undefined> {
	const cached = this.cardmarketNativePricesCache.get(cardmarketId);
	if (cached !== undefined) return cached;

	const inFlight = this.cardmarketNativePricesInFlight.get(cardmarketId);
	if (inFlight) return inFlight;

	const promise = this.fetchCardmarketNativePricesWithRetry(cardmarketId);
	this.cardmarketNativePricesInFlight.set(cardmarketId, promise);
	void promise.finally(() => this.cardmarketNativePricesInFlight.delete(cardmarketId));
	return promise;
}


export async function fetchCardmarketNativePricesWithRetry(this: MTGCollectionPlugin, cardmarketId: number): Promise<CardmarketNativePrices | undefined> {
	const days = this.cardbaseDaysForTier();
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await fetchCardmarketNativePrices(cardmarketId, this.settings.cardbaseApiKey, days);
		if (result) {
			this.cardmarketNativePricesCache.set(cardmarketId, result);
			return result;
		}
		if (attempt === 0) await sleep(300);
	}
	return undefined;
}
// Entry point used by renderStorePricesBox/renderPriceHistoryBox (the 3
// modals) instead of getCardbasePriceHistory alone — combines the generic
// history (Card Kingdom/TCGplayer/Cardsphere, unchanged) with Cardmarket's
// real native "trend" price when available (see withNativeCardmarketTrend,
// cardbase.ts, for the graceful fallback). Deliberately NOT used by
// prefetchCardbaseNeighbors (see above): that preloading keeps calling
// only getCardbasePriceHistory to stay conservative on the request budget
// of neighboring cards — only the card actually displayed gets the native
// Cardmarket price immediately, a navigation to a neighbor may therefore
// briefly display the old column while the two extra requests resolve,
// rather than tripling the network cost of each preload.

export async function getCardbasePriceHistoryWithNativeCardmarket(this: MTGCollectionPlugin, 
	scryfallId: string,
	finish: CardbaseFinish
): Promise<CardbasePriceHistory | undefined> {
	const history = await this.getCardbasePriceHistory(scryfallId, finish);
	if (!history) return undefined;
	const cardmarketId = await this.getCardbaseCardmarketId(scryfallId);
	if (!cardmarketId) return history;
	const native = await this.getCardmarketNativePrices(cardmarketId);
	const merged = withNativeCardmarketTrend(history, pickCardmarketTrendSeries(native, finish));
	// "low" (cheapest Cardmarket listing currently) — already present in
	// `native` (same response as "trend" above, no extra network round trip),
	// just never read until now. See CardbasePriceHistory.cardmarketLow
	// (cardbase.ts) for where it is consumed (tooltip on the Cardmarket column
	// of Store Prices).
	merged.cardmarketLow = pickCardmarketLatestPrice(native, finish, "low");
	return merged;
}
// "Market Trends" (Home dashboard block, home-render.ts — formerly its own
// modal) — top gainers/losers of the whole market, not of the user's
// collection (see cardbase.ts; Home filters client-side to owned cards to
// make some rows clickable, but this request itself always stays
// unfiltered). `limit` fixed at the API's MAXIMUM (100 per side, still a
// single request — see cardbase.ts) since 2026-09-23: before, 20 was enough
// for a list scanned by eye, but the top of each list is dominated by
// aberrant prices (see core/market-movers.ts) that Home discards client-side
// — with 20 rows, this filter could leave almost nothing. We cache the RAW
// rows, not the filtered result: the filter is pure and instantaneous, and a
// future threshold setting must not require a new request.
const MOVERS_FETCH_LIMIT = 100;

export async function getCardbaseMovers(this: MTGCollectionPlugin,
	period: CardbaseMoverPeriod,
	vendor: CardbaseVendor | undefined
): Promise<CardbaseMoversResult | undefined> {
	const cacheKey = `${period}:${vendor ?? "all"}`;
	const cached = this.cardbaseMoversCache.get(cacheKey);
	if (cached !== undefined) return cached;
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await fetchCardbaseMovers(this.settings.cardbaseApiKey, period, vendor, MOVERS_FETCH_LIMIT);
		if (result) {
			this.cardbaseMoversCache.set(cacheKey, result);
			return result;
		}
		if (attempt === 0) await sleep(300);
	}
	return undefined;
}
