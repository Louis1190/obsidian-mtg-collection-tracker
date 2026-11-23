import { requestUrlOrNull } from "./safe-request";
import { JsonArrayRowStream, pushBytes } from "../core/json-array-stream";
import { PackedTable, PackedTableBuilder } from "../core/packed-table";

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

/**
 * What the rest of the plugin asks of the pricelist: the selling price of a printing in a finish. Card Kingdom gives a separate
 * row per finish (just as Scryfall separates usd/usd_foil), so a non-foil card and its foil version are looked up independently.
 */
export interface CardKingdomPricelist {
	/** Rows kept. 0 means nothing usable came back (a failure: the caller does not keep an empty list for the session). */
	readonly size: number;
	/** The price and page of this printing in this finish, undefined when Card Kingdom does not list it. */
	get(scryfallId: string, isFoil: boolean): CardKingdomPriceEntry | undefined;
}

const EMPTY_PRICELIST: CardKingdomPricelist = { size: 0, get: () => undefined };

interface CardKingdomRawEntry {
	scryfall_id?: string;
	is_foil?: string;
	price_retail?: string;
	url?: string;
}

// 152,000 rows live in a PackedTable (core/packed-table.ts): 12 MB instead of the 56 MB the same rows cost as a
// Map of objects (measured 2026-11-22, `docs/history/memory-footprint-audit-2026-11-22.md`). The row keeps the price (one
// number) and the page RELATIVE to the pricelist's base address, which is the same for every row and is kept once here.
class PackedPricelist implements CardKingdomPricelist {
	private readonly base: string;

	constructor(
		private readonly table: PackedTable,
		baseUrl: string
	) {
		this.base = baseUrl.replace(/\/$/, "");
	}

	get size(): number {
		return this.table.size;
	}

	get(scryfallId: string, isFoil: boolean): CardKingdomPriceEntry | undefined {
		const row = this.table.find(scryfallId, isFoil ? 1 : 0);
		if (row < 0) return undefined;
		return { priceRetail: this.table.number(row, 0), url: `${this.base}/${this.table.text(row)}` };
	}
}

// A single round trip for the whole catalog, indexed once for O(1) lookup per card afterwards — see
// plugin/store-prices.ts for the per-session cache (never persisted, like
// allSetsCache/symbologyCache/legalitiesCache: a bulky, read-only object
// that goes stale quickly has no business in the settings JSON blob). Never throws: any failure is an empty pricelist.
export async function fetchCardKingdomPricelist(options: { stream?: boolean } = {}): Promise<CardKingdomPricelist> {
	return options.stream ? fetchPricelistStreamed() : fetchPricelistWhole();
}

const DEFAULT_BASE_URL = "https://www.cardkingdom.com/";

// One pricelist row -> one table row (or nothing). Shared by both ways of reading the pricelist, so that they keep exactly
// the same rows.
function addRow(table: PackedTableBuilder, row: CardKingdomRawEntry): void {
	if (!row.scryfall_id || !row.url) return;
	const price = Number(row.price_retail);
	// A price of 0 (or missing/invalid) is not a real market price to display
	// — Scryfall itself never shows "$0.00" for a card with no price data,
	// same treatment here.
	if (!Number.isFinite(price) || price <= 0) return;
	// Several rows can share the same scryfall_id+finish (different variants/SKUs at Card Kingdom for the same printing) — the table
	// keeps the first one encountered rather than resolving these duplicates, out of scope for a simple selling price. A row whose
	// id is not a UUID is not kept either: no card has such an id, so nothing could ever ask for it.
	table.add(row.scryfall_id, row.is_foil === "true" ? 1 : 0, [price], row.url.replace(/^\//, ""));
}

// The rows go to a stream that hands them over one at a time (core/json-array-stream.ts); the address the pages hang from
// is in the text that precedes the "data" array, so it is known from the first row.
function pricelistReader() {
	const table = new PackedTableBuilder({ columns: 1, numberType: "float64" });
	let baseUrl: string | null = null;
	const stream = new JsonArrayRowStream("data", (rowJson) => {
		if (baseUrl === null) baseUrl = baseUrlFromPrefix(stream.prefix);
		addRow(table, JSON.parse(rowJson) as CardKingdomRawEntry);
	});
	return {
		stream,
		// No row worth keeping (an array that was never found, a body that is not a pricelist included) is a failure.
		finish: (): CardKingdomPricelist => (table.size === 0 ? EMPTY_PRICELIST : new PackedPricelist(table.build(), baseUrl ?? DEFAULT_BASE_URL)),
	};
}

// Computer: the whole response at once through requestUrl (65 MB, no crash risk on a computer), but read as BYTES through the
// same row stream as the phone and not through `.json`: a whole parse made 152,000 row objects at once, a peak of 348 MB of process
// memory for a 12 MB result; decoded a slice at a time the peak is 163 MB (measured on a 67 MB document), the window never freezes
// (`pushBytes` yields every 2 MB) and the text of the whole response is never built.
async function fetchPricelistWhole(): Promise<CardKingdomPricelist> {
	const res = await requestUrlOrNull({
		url: CARD_KINGDOM_PRICELIST_URL,
		headers: CARD_KINGDOM_HEADERS,
	});
	if (!res || res.status !== 200) return EMPTY_PRICELIST;
	try {
		const reader = pricelistReader();
		await pushBytes(reader.stream, new Uint8Array(res.arrayBuffer));
		return reader.finish();
	} catch {
		return EMPTY_PRICELIST;
	}
}

// Phone / tablet: STREAMED. requestUrl encodes the whole response as base64 before returning it (65 MB -> 86 MB
// of text, i.e. an allocation of ~90 MB) and the Obsidian app crashes (OutOfMemoryError, seen in the Android
// emulator; on iOS the system kills the app for the same memory reason) when a card's detail window opens.
// fetch() reads the response chunk by chunk (≤ 1 MB each) and JsonArrayRowStream keeps only the current row:
// memory stays bounded, only the final table (~12 MB) is kept. The Card Kingdom API answers with
// `access-control-allow-origin: *`, which fetch requires; Mana Pool does not send it (see manapool.ts,
// manaPoolPricesSupported). Headers: a browser forbids setting User-Agent, only Accept gets through. Measured in
// the real Android app (emulator): 67.8 MB read in 665 chunks, 4.6 s, no crash. Any error
// (a network cut mid-response included) returns an empty pricelist, never a partial one: an incomplete pricelist would
// be kept for the session (a non-empty one is cached) and would wrongly make it look as if some cards have no
// price.
async function fetchPricelistStreamed(): Promise<CardKingdomPricelist> {
	try {
		// fetch and not requestUrl, on purpose: requestUrl cannot read as a stream (it returns the whole response,
		// base64-encoded on mobile, hence the crash described above). Obsidian's linter recommends requestUrl
		// (no-restricted-globals, a warning) and forbids disabling it: this particular warning is known and accepted,
		// see docs/obsidian-compliance.md.
		const res = await fetch(CARD_KINGDOM_PRICELIST_URL, { headers: { Accept: "application/json" } });
		if (!res.ok || !res.body) return EMPTY_PRICELIST;

		const reader = pricelistReader();
		const body = res.body.getReader();
		const decoder = new TextDecoder("utf-8");
		for (;;) {
			const { done, value } = await body.read();
			if (done) break;
			reader.stream.push(decoder.decode(value, { stream: true }));
		}
		reader.stream.push(decoder.decode());
		return reader.finish();
	} catch {
		return EMPTY_PRICELIST;
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
