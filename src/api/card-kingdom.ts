import { requestUrlOrNull } from "./safe-request";
import { JsonArrayRowStream } from "../core/json-array-stream";

/* -------------------------------------------------------------------------- */
/* Card Kingdom pricelist — complements Scryfall with a real "store" price */
/* -------------------------------------------------------------------------- */

// Public endpoint, confirmed (direct curl): no key, no account, complete
// JSON (~67 MB, the whole Card Kingdom catalog in one file) under
// {"meta":{"base_url":...},"data":[{scryfall_id, is_foil, price_retail, url,
// ...}]}. Unlike Scryfall's /cards/collection (75 cards per request), there
// is no "per card" version — one round trip for the whole catalog, indexed
// once in memory (see fetchCardKingdomPricelist) rather than re-scanned for
// each card displayed.
const CARD_KINGDOM_PRICELIST_URL = "https://api.cardkingdom.com/api/v2/pricelist";

const CARD_KINGDOM_HEADERS = {
	// Same identifier + contact as SCRYFALL_HEADERS (scryfall.ts) — consistency
	// across all of this plugin's APIs, not a requirement specific to Card
	// Kingdom.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

export interface CardKingdomPriceEntry {
	priceRetail: number;
	url: string;
}

interface CardKingdomRawEntry {
	scryfall_id?: string;
	is_foil?: string;
	price_retail?: string;
	url?: string;
}

// Pricelist body (`res.json` is `any`: we type it here, once).
interface CardKingdomPricelistBody {
	meta?: { base_url?: string };
	data?: CardKingdomRawEntry[];
}

// Composite key scryfall_id+foil: Card Kingdom gives a separate row per
// finish (just as Scryfall itself separates usd/usd_foil), so a non-foil card
// and its foil version have two distinct prices to look up independently.
export function cardKingdomKey(scryfallId: string, isFoil: boolean): string {
	return `${scryfallId}:${isFoil ? "foil" : "nonfoil"}`;
}

// A single round trip for the whole catalog, indexed into a Map for O(1)
// lookup per card afterwards — see plugin.ts getCardKingdomPrices for the
// per-session cache (never persisted, like
// allSetsCache/symbologyCache/legalitiesCache: a bulky, read-only object
// that goes stale quickly has no business in the settings JSON blob).
export async function fetchCardKingdomPricelist(options: { stream?: boolean } = {}): Promise<Map<string, CardKingdomPriceEntry>> {
	return options.stream ? fetchPricelistStreamed() : fetchPricelistWhole();
}

const DEFAULT_BASE_URL = "https://www.cardkingdom.com/";

// One pricelist row -> one Map entry (or nothing). Shared by both ways of reading the pricelist, so that they
// keep exactly the same rows.
function addRow(map: Map<string, CardKingdomPriceEntry>, baseUrl: string, row: CardKingdomRawEntry): void {
	if (!row.scryfall_id || !row.url) return;
	const price = Number(row.price_retail);
	// A price of 0 (or missing/invalid) is not a real market price to display
	// — Scryfall itself never shows "$0.00" for a card with no price data,
	// same treatment here.
	if (!Number.isFinite(price) || price <= 0) return;

	const key = cardKingdomKey(row.scryfall_id, row.is_foil === "true");
	// Several rows can share the same scryfall_id+finish (different
	// variants/SKUs at Card Kingdom for the same printing) — we keep the first
	// one encountered rather than resolving these duplicates, out of scope for
	// a simple selling price.
	if (map.has(key)) return;

	map.set(key, {
		priceRetail: price,
		url: `${baseUrl.replace(/\/$/, "")}/${row.url.replace(/^\//, "")}`,
	});
}

// Computer: the whole response at once through requestUrl (65 MB decompressed, no memory concern on a computer).
async function fetchPricelistWhole(): Promise<Map<string, CardKingdomPriceEntry>> {
	const map = new Map<string, CardKingdomPriceEntry>();
	const res = await requestUrlOrNull({
		url: CARD_KINGDOM_PRICELIST_URL,
		headers: CARD_KINGDOM_HEADERS,
	});
	if (!res || res.status !== 200) return map;

	const baseUrl: string = (res.json as CardKingdomPricelistBody | undefined)?.meta?.base_url ?? DEFAULT_BASE_URL;
	const rows = (res.json as CardKingdomPricelistBody | undefined)?.data ?? [];
	for (const row of rows) addRow(map, baseUrl, row);
	return map;
}

// Phone / tablet: STREAMED. requestUrl encodes the whole response as base64 before returning it (65 MB -> 86 MB
// of text, i.e. an allocation of ~90 MB) and the Obsidian app crashes (OutOfMemoryError, seen in the Android
// emulator; on iOS the system kills the app for the same memory reason) when a card's detail window opens.
// fetch() reads the response chunk by chunk (≤ 1 MB each) and JsonArrayRowStream keeps only the current row:
// memory stays bounded, only the final Map (~40 MB of small entries) is kept. The Card Kingdom API answers with
// `access-control-allow-origin: *`, which fetch requires; Mana Pool does not send it (see manapool.ts,
// manaPoolPricesSupported). Headers: a browser forbids setting User-Agent, only Accept gets through. Measured in
// the real Android app (emulator): 67.8 MB read in 665 chunks, 4.6 s, JavaScript heap 48 MB, no crash. Any error
// (a network cut mid-response included) returns an empty Map, never a partial Map: an incomplete pricelist would
// be kept for the session (a non-empty Map is cached) and would wrongly make it look as if some cards have no
// price.
async function fetchPricelistStreamed(): Promise<Map<string, CardKingdomPriceEntry>> {
	const map = new Map<string, CardKingdomPriceEntry>();
	try {
		// fetch and not requestUrl, on purpose: requestUrl cannot read as a stream (it returns the whole response,
		// base64-encoded on mobile, hence the crash described above). Obsidian's linter recommends requestUrl
		// (no-restricted-globals, a warning) and forbids disabling it: this particular warning is known and accepted,
		// see docs/obsidian-compliance.md.
		const res = await fetch(CARD_KINGDOM_PRICELIST_URL, { headers: { Accept: "application/json" } });
		if (!res.ok || !res.body) return map;

		let baseUrl: string | null = null;
		const stream = new JsonArrayRowStream("data", (rowJson) => {
			if (baseUrl === null) baseUrl = baseUrlFromPrefix(stream.prefix);
			addRow(map, baseUrl, JSON.parse(rowJson) as CardKingdomRawEntry);
		});
		const reader = res.body.getReader();
		const decoder = new TextDecoder("utf-8");
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			stream.push(decoder.decode(value, { stream: true }));
		}
		stream.push(decoder.decode());
		return stream.failed ? new Map() : map;
	} catch {
		return new Map();
	}
}

// {"meta":{"created_at":"…","base_url":"https:\/\/www.cardkingdom.com\/"}, — the text that precedes the "data" array.
function baseUrlFromPrefix(prefix: string): string {
	const match = /"base_url"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(prefix);
	if (!match) return DEFAULT_BASE_URL;
	try {
		const value: unknown = JSON.parse(match[1]);
		return typeof value === "string" && value ? value : DEFAULT_BASE_URL;
	} catch {
		return DEFAULT_BASE_URL;
	}
}
