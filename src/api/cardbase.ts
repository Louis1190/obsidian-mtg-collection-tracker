import { requestUrlOrNull } from "./safe-request";

/* -------------------------------------------------------------------------- */
/* cardbase.dev — price history ("Price History" box) AND, since the */
/* Cardmarket column was added to "Store Prices", the current Cardmarket */
/* price (last point of the same series already fetched — no additional */
/* network round trip, see getCardbaseLatestPrice below). */
/* -------------------------------------------------------------------------- */

// Per-printing endpoint (no "whole catalog" version like Card Kingdom/Mana
// Pool): GET /printings/{scryfall_id}/prices, optional auth (Bearer, see
// settings.cardbaseApiKey) — anonymous = 30 days of history, with a key =
// 365 days, a cap applied silently server-side so no client logic is needed
// for it (see fetchCardbasePriceHistory: we always ask for 365 days, the
// server reduces it itself if necessary). vendor omitted from the request
// (we filter client-side afterwards) so as to make a single round trip
// instead of one per store.
const CARDBASE_BASE_URL = "https://api.cardbase.dev/v1";

const CARDBASE_HEADERS = {
	// Same identifier + contact as SCRYFALL_HEADERS (scryfall.ts) — consistency
	// across all of this plugin's APIs, not a requirement specific to
	// cardbase.dev.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

// cardkingdom/tcgplayer/cardmarket/cardsphere all 4 feed the "Price
// History" chart; cardmarket additionally feeds, via
// getCardbaseLatestPrice, the column of the same name in "Store Prices"
// (same request already made for the chart, no extra network round trip).
// cardsphere is a vendor documented by cardbase but whose coverage
// currently seems empty in practice — checked live (`vendor=cardsphere` on
// Sol Ring ×3 printings + Counterspell: `series: []` every time) — wired
// anyway: if cardbase populates it later, this curve appears by itself,
// with no other code change. cardhoarder deliberately excluded: it is not a
// "paper" price but the Magic Online ticket market (the online game) —
// mixing it with the other 4 would be misleading for a plugin that tracks a
// physical collection. A real response also unexpectedly included a
// "manapool" series (price + points), although this vendor appears nowhere
// in the `vendor` enumeration documented by cardbase — not adopted here all
// the same: this plugin already has its own direct Mana Pool source
// (manapool.ts) for Store Prices, and nothing guarantees that this
// undocumented vendor stays reliably covered on cardbase's side.
export type CardbaseVendor = "cardkingdom" | "tcgplayer" | "cardmarket" | "cardsphere";
export type CardbaseFinish = "normal" | "foil" | "etched";

// Display labels for the two enums above — colocated with the types
// themselves (not in home-render.ts, where they first lived) specifically
// so both Home's Market Trends block AND card-preview-modal.ts can import
// them without either one importing from the other: home-render.ts already
// needs to import CardPreviewModal (modals/card-preview-modal.ts, 2026-09-23)
// to open it on a row click, and that modal needs these same two label maps
// for its own price row — either direction of a home-render.ts ⇄
// card-preview-modal.ts import would be circular.
export const CARDBASE_VENDOR_LABELS: Record<CardbaseVendor, string> = {
	cardkingdom: "Card Kingdom",
	tcgplayer: "TCGplayer",
	cardmarket: "Cardmarket",
	cardsphere: "Cardsphere",
};

export const CARDBASE_FINISH_LABELS: Record<CardbaseFinish, string> = {
	normal: "Regular",
	foil: "Foil",
	etched: "Etched",
};

export interface CardbasePricePoint {
	date: string;
	price: number;
}

export interface CardbasePriceSeries {
	vendor: CardbaseVendor;
	finish: CardbaseFinish;
	currency: string;
	points: CardbasePricePoint[];
}

export interface CardbasePriceHistory {
	scryfallId: string;
	series: CardbasePriceSeries[];
	historyBegins?: string;
	// meta.as_of of the cardbase response — date of the most recent price data
	// in the database (not necessarily "today", ingestion runs once a day).
	// Displayed by renderPriceHistorySourceFooter, see card-detail-fx.ts —
	// deliberately reused from this already-fetched response rather than
	// adding a separate GET /status call, judged not worth it for a simple
	// freshness date already available elsewhere.
	asOf?: string;
	// Price of the cheapest Cardmarket listing currently available
	// (price_type="low" of the native Price Guide) — see
	// pickCardmarketLatestPrice and its attachment point,
	// MTGCollectionPlugin.getCardbasePriceHistoryWithNativeCardmarket
	// (plugin.ts). Not a field of PriceSeries/series (not data we want to plot
	// on the chart nor compare day to day like "trend") — just a one-off piece
	// of information shown in a tooltip on the Cardmarket column of Store
	// Prices. undefined if Cardmarket has no listing for this printing/finish.
	cardmarketLow?: CardbaseLatestPrice;
}

interface CardbaseRawSeries {
	vendor?: string;
	finish?: string;
	price_type?: string;
	currency?: string;
	points?: [string, number][];
}

// Body of /printings/{id}/prices (`res.json` is `any`: we type it here, once).
interface CardbaseHistoryBody {
	data?: { series?: CardbaseRawSeries[] };
	meta?: { history_begins?: string; as_of?: string };
}

// undefined = failure (network, 4xx/5xx, malformed response) — to be told
// apart by the caller from a confirmed success with an empty series (a card
// that really has no history at these two stores), which must be cached as
// is. Always price_type=retail: this is what the Card Kingdom/TCGplayer
// columns of the "Store Prices" box already display (see
// card-kingdom.ts/renderStorePricesBox) — a "buylist" curve could not be
// compared with the latest point already visible just above.
export async function fetchCardbasePriceHistory(
	scryfallId: string,
	apiKey: string,
	finish: CardbaseFinish,
	days: number
): Promise<CardbasePriceHistory | undefined> {
	const url = `${CARDBASE_BASE_URL}/printings/${scryfallId}/prices?finish=${finish}&price_type=retail&days=${days}`;
	const headers: Record<string, string> = { ...CARDBASE_HEADERS };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await requestUrlOrNull({ url, headers });
	if (!res || res.status !== 200) return undefined;

	const rawSeries = (res.json as CardbaseHistoryBody | undefined)?.data?.series ?? [];
	const series: CardbasePriceSeries[] = [];
	for (const raw of rawSeries) {
		if (
			raw.vendor !== "cardkingdom" &&
			raw.vendor !== "tcgplayer" &&
			raw.vendor !== "cardmarket" &&
			raw.vendor !== "cardsphere"
		)
			continue;
		if (!raw.points?.length) continue;
		series.push({
			vendor: raw.vendor,
			finish: (raw.finish as CardbaseFinish) ?? finish,
			currency: raw.currency ?? "USD",
			points: raw.points.map(([date, price]) => ({ date, price })),
		});
	}

	return {
		scryfallId,
		series,
		historyBegins: (res.json as CardbaseHistoryBody | undefined)?.meta?.history_begins,
		asOf: (res.json as CardbaseHistoryBody | undefined)?.meta?.as_of,
	};
}

export interface CardbaseLatestPrice {
	price: number;
	currency: string;
}

// Last (most recent) point of a given store's series, for the "Cardmarket"
// column of Store Prices — checked directly against the real API (not just
// assumed) that `vendor=cardmarket` does return a `price_type=retail` in
// EUR, like cardkingdom/tcgplayer in USD; `points` is already sorted by
// ascending date by cardbase (see its docs), so the last element is the
// most recent, no need to re-sort here.
export function getCardbaseLatestPrice(
	history: CardbasePriceHistory | undefined,
	vendor: CardbaseVendor
): CardbaseLatestPrice | undefined {
	const series = history?.series.find((s) => s.vendor === vendor);
	const last = series?.points[series.points.length - 1];
	return last ? { price: last.price, currency: series.currency } : undefined;
}

export interface CardbaseDayChange {
	changePct: number;
	direction: "up" | "down" | "flat";
}

// Yesterday→today change for a given store, from the LAST TWO points already
// present in the series (no extra fetch — this history is already fetched
// for the "Price History" box/the Cardmarket column, see
// renderStorePricesBox). undefined if the series has fewer than 2 points
// (card too recent in cardbase's dataset, cf. meta.history_begins) or if
// yesterday's price is 0 (a division by 0 makes no sense here). "flat" (0%)
// is a valid result, distinct from undefined — the caller decides whether to
// display or hide it.
export function getCardbaseDayChange(
	history: CardbasePriceHistory | undefined,
	vendor: CardbaseVendor
): CardbaseDayChange | undefined {
	const series = history?.series.find((s) => s.vendor === vendor);
	if (!series || series.points.length < 2) return undefined;
	const prev = series.points[series.points.length - 2].price;
	const curr = series.points[series.points.length - 1].price;
	if (!prev) return undefined;
	const changePct = ((curr - prev) / prev) * 100;
	const direction: CardbaseDayChange["direction"] = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
	return { changePct, direction };
}


interface CardbasePrintingRaw {
	cardmarket_id?: number;
}

// undefined = failure (network, 4xx/5xx); `null` (caller side, see
// plugin.ts) = confirmed response without a cardmarket_id (a printing
// cardbase hasn't mapped on the Cardmarket side) — two different cases,
// not to be confused in the cache.
export async function fetchCardbasePrintingCardmarketId(
	scryfallId: string,
	apiKey: string
): Promise<number | undefined | null> {
	const headers: Record<string, string> = { ...CARDBASE_HEADERS };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await requestUrlOrNull({ url: `${CARDBASE_BASE_URL}/printings/${scryfallId}`, headers });
	if (res && res.status === 404) return null;
	if (!res || res.status !== 200) return undefined;
	const data = (res.json as { data?: CardbasePrintingRaw } | undefined)?.data;
	return data?.cardmarket_id ?? null;
}

export type CardmarketFinish = "normal" | "foil";

export interface CardmarketNativeSeries {
	finish: CardmarketFinish;
	priceType: string; // "avg" | "low" | "trend" | "avg1" | "avg7" | "avg30"
	currency: string;
	points: CardbasePricePoint[];
}

export interface CardmarketNativePrices {
	cardmarketId: number;
	series: CardmarketNativeSeries[];
}

interface CardmarketRawSeries {
	finish?: string;
	price_type?: string;
	currency?: string;
	points?: [string, number][];
}

// Body of /cardmarket/{id}/prices (`res.json` is `any`: we type it here, once).
interface CardmarketPricesBody {
	data?: { series?: CardmarketRawSeries[] };
}

// No vendor/price_type/finish filter server-side for this endpoint (unlike
// /printings/{id}/prices) — we always fetch all 12 series (2 finishes × 6
// types) and filter client-side (see pickCardmarketTrendSeries). Same
// days/tier logic as fetchCardbasePriceHistory (the caller, plugin.ts,
// computes the same value for both).
export async function fetchCardmarketNativePrices(
	cardmarketId: number,
	apiKey: string,
	days: number
): Promise<CardmarketNativePrices | undefined> {
	const headers: Record<string, string> = { ...CARDBASE_HEADERS };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await requestUrlOrNull({
		url: `${CARDBASE_BASE_URL}/cardmarket/${cardmarketId}/prices?days=${days}`,
		headers,
	});
	if (!res || res.status !== 200) return undefined;

	const rawSeries = (res.json as CardmarketPricesBody | undefined)?.data?.series ?? [];
	const series: CardmarketNativeSeries[] = [];
	for (const raw of rawSeries) {
		if ((raw.finish !== "normal" && raw.finish !== "foil") || !raw.price_type || !raw.points?.length) continue;
		series.push({
			finish: raw.finish,
			priceType: raw.price_type,
			currency: raw.currency ?? "EUR",
			points: raw.points.map(([date, price]) => ({ date, price })),
		});
	}
	return { cardmarketId, series };
}

// "etched" doesn't exist on Cardmarket's side (its API only knows normal/foil,
// see CardmarketFinish) — folded into "foil", same treatment as "surged"
// already applied elsewhere in this plugin for the same reason (no dedicated
// value available at the source, foil is the closest). undefined if there is
// no "trend" series for this finish (printing too recent, finish not sold by
// Cardmarket) — the caller (withNativeCardmarketTrend) then knows to keep the
// old "retail" value rather than show a gap.
export function pickCardmarketTrendSeries(
	native: CardmarketNativePrices | undefined,
	finish: CardbaseFinish
): CardbasePriceSeries | undefined {
	if (!native) return undefined;
	const cmFinish: CardmarketFinish = finish === "normal" ? "normal" : "foil";
	const series = native.series.find((s) => s.finish === cmFinish && s.priceType === "trend");
	if (!series || !series.points.length) return undefined;
	return { vendor: "cardmarket", finish, currency: series.currency, points: series.points };
}

// Same "etched" → "foil" finish fallback as pickCardmarketTrendSeries above.
// Generalized over `priceType` (not fixed to "low") even though the only
// current caller asks for "low" (the price of the cheapest listing currently
// available) — the native response already contains the 6 Price Guide types
// (see fetchCardmarketNativePrices), `pickCardmarketTrendSeries` keeps only
// one ("trend") for the main column/chart; this function fetches a one-off
// point (not a full series, no need for history for a "current lowest price")
// among the 5 remaining types that would otherwise be thrown away without
// ever being read.
export function pickCardmarketLatestPrice(
	native: CardmarketNativePrices | undefined,
	finish: CardbaseFinish,
	priceType: string
): CardbaseLatestPrice | undefined {
	if (!native) return undefined;
	const cmFinish: CardmarketFinish = finish === "normal" ? "normal" : "foil";
	const series = native.series.find((s) => s.finish === cmFinish && s.priceType === priceType);
	const last = series?.points[series.points.length - 1];
	return last ? { price: last.price, currency: series.currency } : undefined;
}

// Replaces the "cardmarket" series (generic, price_type=retail) of `history`
// with the native "trend" series when it is available — deliberate graceful
// fallback: if `nativeTrend` is undefined (cardmarket_id not found, native
// endpoint failing, no point for this finish), `history` is returned AS IS,
// with its generic "cardmarket" column already in place, rather than
// removing all Cardmarket data — never worse than before this feature.
// Returns exactly the same CardbasePriceHistory shape already consumed by
// renderPriceHistoryChart/getCardbaseLatestPrice/getCardbaseDayChange, so no
// change is needed on the rendering side — only the data changes source.
export function withNativeCardmarketTrend(
	history: CardbasePriceHistory,
	nativeTrend: CardbasePriceSeries | undefined
): CardbasePriceHistory {
	if (!nativeTrend) return history;
	return {
		...history,
		series: [...history.series.filter((s) => s.vendor !== "cardmarket"), nativeTrend],
	};
}

/* -------------------------------------------------------------------------- */
/* "Market Trends" — GET /movers, the cards that moved the most, in PRICE, */
/* across the WHOLE market (not scoped to the user's collection — the only */
/* place in this file where that's the case) — see */
/* modals/market-trends-modal.ts. A single request, no pagination (unlike */
/* /changes, judged too voluminous for per-card use — see the discussion that */
/* led to exploring /movers instead), and the card's name is already included */
/* in the response, no extra Scryfall round trip needed to display it. */
/* -------------------------------------------------------------------------- */

export type CardbaseMoverPeriod = "1d" | "7d" | "30d";

export interface CardbaseMover {
	scryfallId: string;
	name: string;
	vendor: CardbaseVendor;
	finish: CardbaseFinish;
	currency: string;
	priceFrom: number;
	priceTo: number;
	changePct: number;
}

export interface CardbaseMoversResult {
	period: CardbaseMoverPeriod;
	gainers: CardbaseMover[];
	losers: CardbaseMover[];
	// See CardbasePriceHistory.asOf above for the full reasoning (meta.as_of
	// already present on this response, no separate /status call).
	asOf?: string;
}

interface CardbaseMoverRaw {
	scryfall_id?: string;
	name?: string;
	vendor?: string;
	finish?: string;
	currency?: string;
	price_from?: number;
	price_to?: number;
	change_pct?: number;
}

// Body of /movers (`res.json` is `any`: we type it here, once).
interface CardbaseMoversBody {
	data?: { gainers?: CardbaseMoverRaw[]; losers?: CardbaseMoverRaw[] };
	meta?: { as_of?: string };
}

function parseCardbaseMovers(raw: CardbaseMoverRaw[] | undefined): CardbaseMover[] {
	const result: CardbaseMover[] = [];
	for (const m of raw ?? []) {
		if (
			!m.scryfall_id ||
			!m.name ||
			(m.vendor !== "cardkingdom" && m.vendor !== "tcgplayer" && m.vendor !== "cardmarket" && m.vendor !== "cardsphere") ||
			(m.finish !== "normal" && m.finish !== "foil" && m.finish !== "etched") ||
			m.price_from == null ||
			m.price_to == null ||
			m.change_pct == null
		)
			continue;
		result.push({
			scryfallId: m.scryfall_id,
			name: m.name,
			vendor: m.vendor,
			finish: m.finish,
			currency: m.currency ?? "USD",
			priceFrom: m.price_from,
			priceTo: m.price_to,
			changePct: m.change_pct,
		});
	}
	return result;
}

// undefined = network/HTTP failure. `vendor` omitted = all vendors
// combined (what the endpoint itself does by default). `limit` applies
// independently to gainers AND losers (see cardbase's docs — "Maximum
// number of gainers and losers each to return").
export async function fetchCardbaseMovers(
	apiKey: string,
	period: CardbaseMoverPeriod,
	vendor: CardbaseVendor | undefined,
	limit: number
): Promise<CardbaseMoversResult | undefined> {
	const headers: Record<string, string> = { ...CARDBASE_HEADERS };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	let url = `${CARDBASE_BASE_URL}/movers?period=${period}&limit=${limit}`;
	if (vendor) url += `&vendor=${vendor}`;

	const res = await requestUrlOrNull({ url, headers });
	if (!res || res.status !== 200) return undefined;

	return {
		period,
		gainers: parseCardbaseMovers((res.json as CardbaseMoversBody | undefined)?.data?.gainers),
		losers: parseCardbaseMovers((res.json as CardbaseMoversBody | undefined)?.data?.losers),
		asOf: (res.json as CardbaseMoversBody | undefined)?.meta?.as_of,
	};
}

// Old mechanism (until 2026-09-15): ask for days=365 on
// /printings/{id}/prices and rely on a specific 400 ("days must be 30 or
// fewer for your access tier") to detect a key that doesn't actually raise
// the tier. That behavior no longer exists — checked live AND confirmed by
// cardbase's current docs (https://cardbase.dev/docs): exceeding one's tier
// is now silently capped (200, with meta.history_begins reflecting what was
// actually returned), never rejected with a 400. Worse, in a real test even
// a fake key got much more than the announced "anonymous" 30 days — so this
// signal had already stopped working altogether, not just "differently".
// See docs/history/price-history-chart.md (2026-09-15 entry) for the full
// investigation.
//
// New mechanism: /bulk/prices/{date} requires authentication (401
// "Unauthorized" if missing/invalid — checked live, never cached on
// cardbase's side, Cache-Control: no-store) and checks auth BEFORE the
// validity of the date (checked live on 3 different dates: a bogus date and
// a date far in the future both return 401 without a key, never a "date
// invalid" 400 instead). By asking for a deliberately out-of-range date
// (fixed, more than 365 days in the past, so it never needs maintenance),
// the server can return 401 ONLY if the key is rejected — any other
// response (400/404 expected for "date too old") means the key was
// accepted, without ever reaching the real 302 to the full dump (so no
// download is triggered just to test a key).
const CARDBASE_TEST_BULK_DATE = "2000-01-01";

export type CardbaseConnectionStatus = "ok" | "rejected" | "error";

// Only called with a non-empty key — the caller (setting-tab.ts) handles the
// "no key entered" case separately, which needs no network round trip to be
// diagnosed (always limited to 30 days, by definition).
export async function testCardbaseConnection(apiKey: string): Promise<CardbaseConnectionStatus> {
	const res = await requestUrlOrNull({
		url: `${CARDBASE_BASE_URL}/bulk/prices/${CARDBASE_TEST_BULK_DATE}`,
		headers: { ...CARDBASE_HEADERS, Authorization: `Bearer ${apiKey}` },
	});
	// No response at all (offline…): the same "error" as a 429/5xx — the key isn't at fault.
	if (!res) return "error";
	if (res.status === 401) return "rejected";
	if (res.status === 429 || res.status >= 500) return "error";
	return "ok";
}
