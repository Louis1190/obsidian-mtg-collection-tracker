import { Platform } from "obsidian";
import { requestUrlOrNull } from "./safe-request";
import { JsonArrayRowStream, pushBytes } from "../core/json-array-stream";
import { PackedTable, PackedTableBuilder } from "../core/packed-table";
import { Finish } from "../core/card-model";
import type { CardbaseFinish } from "./cardbase";

/* -------------------------------------------------------------------------- */
/* Mana Pool pricelist — 3rd source for the "Store Prices" box */
/* -------------------------------------------------------------------------- */

// Public endpoint, confirmed (direct curl): no key, no account, despite what
// the API's general docs suggest ("you must have a Mana Pool account and
// generate an API access token") — that requirement concerns the
// seller/buyer/orders endpoints, not /prices/singles. Complete JSON (~68 MB on 2026-11-22,
// the whole in-stock catalog) under {"meta":{...},"data":[{scryfall_id,
// price_cents, price_cents_nm, price_cents_foil, price_cents_nm_foil,
// price_cents_etched, price_cents_nm_etched, url, ...}]} — unlike Card
// Kingdom, a single row per scryfall_id already covers all finishes (no
// separate row per foil/non-foil), so no composite key is needed here, just
// scryfall_id. No "per card" version either — one round trip for the whole
// catalog, indexed once in memory (see fetchManaPoolPricelist) as with Card
// Kingdom. The v1 docs themselves warn that it is "still in active
// development and is subject to change without notice" — nothing guarantees
// that this anonymous access stays open indefinitely.
const MANAPOOL_PRICES_URL = "https://manapool.com/api/v1/prices/singles";

const MANAPOOL_HEADERS = {
	// Same identifier + contact as SCRYFALL_HEADERS (scryfall.ts) — general
	// good practice, not a requirement documented specifically by Mana Pool as
	// it is at Scryfall.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

// All the price variants (cents) for a given printing, as returned by Mana
// Pool — selecting the right pair according to the card's finish is done in
// pickManaPoolPrice, not here.
export interface ManaPoolCardPrices {
	url: string;
	priceCents: number | null;
	priceCentsNm: number | null;
	priceCentsFoil: number | null;
	priceCentsNmFoil: number | null;
	priceCentsEtched: number | null;
	priceCentsNmEtched: number | null;
}

export interface ManaPoolPriceResult {
	priceCents: number;
	// False if no Near Mint copy was in stock for this finish and we fell back
	// to the lowest available price (all conditions combined) — lets the
	// caller show a warning rather than pass a "Played" price off as NM.
	isNearMint: boolean;
	url: string;
	// Set only when the price comes from our own Mana Pool files (phones and tablets, see getOwnManaPoolPrice) instead of Mana Pool's price list: the
	// price is then the lowest across all conditions (never Near Mint), about a day old, and `asOf` is the day it is from ("YYYY-MM-DD").
	source?: "price-history";
	asOf?: string;
}

interface ManaPoolRawEntry {
	scryfall_id?: string;
	url?: string;
	price_cents?: number | null;
	price_cents_nm?: number | null;
	price_cents_foil?: number | null;
	price_cents_nm_foil?: number | null;
	price_cents_etched?: number | null;
	price_cents_nm_etched?: number | null;
}

// What the rest of the plugin asks of the pricelist.
export interface ManaPoolPricelist {
	/** Rows kept. 0 means nothing usable came back (a failure: the caller does not keep an empty list for the session). */
	readonly size: number;
	/** Every price Mana Pool has for this printing, undefined when it has no row for it. */
	get(scryfallId: string): ManaPoolCardPrices | undefined;
}

const EMPTY_PRICELIST: ManaPoolPricelist = { size: 0, get: () => undefined };

// The six price fields of a row, in the order of the table's columns.
const PRICE_FIELDS = ["price_cents", "price_cents_nm", "price_cents_foil", "price_cents_nm_foil", "price_cents_etched", "price_cents_nm_etched"] as const;

// A cell of the table holding "no price". Cents are stored as 32-bit integers (4 bytes a cell); -1 can never be a price.
const NO_PRICE = -1;
// A price above this (21 million dollars) does not exist: it would not fit the cell, so it counts as none.
const MAX_CENTS = 2 ** 31 - 1;

// A price of 0/missing/invalid is not a real price to display — same treatment as Card Kingdom and Scryfall itself (never "$0.00").
// Whole cents: a fraction of a cent is not a price, and the API only writes integers.
function centsCell(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_CENTS) return NO_PRICE;
	return Math.round(value) || NO_PRICE;
}

const fromCell = (cell: number): number | null => (cell === NO_PRICE ? null : cell);

// 104,000 rows live in a PackedTable (core/packed-table.ts): ~10 MB instead of the ~40 MB the same rows cost as a Map of objects.
class PackedPricelist implements ManaPoolPricelist {
	constructor(private readonly table: PackedTable) {}

	get size(): number {
		return this.table.size;
	}

	get(scryfallId: string): ManaPoolCardPrices | undefined {
		const row = this.table.find(scryfallId);
		if (row < 0) return undefined;
		const t = this.table;
		return {
			url: t.text(row),
			priceCents: fromCell(t.number(row, 0)),
			priceCentsNm: fromCell(t.number(row, 1)),
			priceCentsFoil: fromCell(t.number(row, 2)),
			priceCentsNmFoil: fromCell(t.number(row, 3)),
			priceCentsEtched: fromCell(t.number(row, 4)),
			priceCentsNmEtched: fromCell(t.number(row, 5)),
		};
	}
}

// The Mana Pool pricelist (68 MB decompressed, 2026-11-22) is NOT loaded on phone / tablet: requestUrl encodes the whole
// response as base64 there (66 MB of text) and the Obsidian app crashes for lack of memory (same cause as Card
// Kingdom, see card-kingdom.ts), and reading it as a stream with fetch() is impossible — Mana Pool does not
// answer with access-control-allow-origin (checked in the real Android app: "Failed to fetch"). There is no
// per-card endpoint (the url's filters are ignored, the complete file comes back). The Mana Pool column of
// "Store Prices" therefore reads our own Mana Pool files there instead (getManaPoolPrice, plugin/store-prices.ts): the lowest price across all
// conditions, a day old, shown as "Lowest" over its day (renderStorePricesBox). Before 1.0.562 it said "Not on mobile".
export function manaPoolPricesSupported(): boolean {
	return !Platform.isMobileApp;
}

// The page of a printing at Mana Pool, built from what the plugin already knows: the price list gives `https://manapool.com/card/<set>/<number>/<name>`
// with the set and number Scryfall uses (checked 2026-10-16 on 4 029 printings of a real collection: all equal), and the address WITHOUT the name
// answers with a 301 to the full one (checked on a card). Used where the price list is not loaded (phones and tablets).
export function manaPoolCardUrl(setCode: string, collectorNumber: string): string {
	return `https://manapool.com/card/${encodeURIComponent(setCode.toLowerCase())}/${encodeURIComponent(collectorNumber.toLowerCase())}`;
}

// Which Mana Pool series of our own files a card is looked up as: the same split as pickManaPoolPrice ("etched" has its own price, "surged" is a
// foil as everywhere else in this plugin).
export function toManaPoolSeriesFinish(finish: Finish): CardbaseFinish {
	if (finish === "etched") return "etched";
	if (finish === "foiled" || finish === "surged") return "foil";
	return "normal";
}

// Read as bytes through the row stream, like the Card Kingdom list on a computer (see fetchPricelistWhole in card-kingdom.ts): the
// 104,000 row objects of a whole `.json` parse never exist at once. Never throws: any failure is an empty pricelist.
export async function fetchManaPoolPricelist(): Promise<ManaPoolPricelist> {
	if (!manaPoolPricesSupported()) return EMPTY_PRICELIST;
	const res = await requestUrlOrNull({
		url: MANAPOOL_PRICES_URL,
		headers: MANAPOOL_HEADERS,
	});
	if (!res || res.status !== 200) return EMPTY_PRICELIST;

	try {
		const table = new PackedTableBuilder({ columns: PRICE_FIELDS.length, numberType: "int32" });
		const cells = new Array<number>(PRICE_FIELDS.length);
		const stream = new JsonArrayRowStream("data", (rowJson) => {
			const row = JSON.parse(rowJson) as ManaPoolRawEntry;
			if (!row.scryfall_id || !row.url) return;
			for (let i = 0; i < PRICE_FIELDS.length; i++) cells[i] = centsCell(row[PRICE_FIELDS[i]]);
			// A printing should appear only once in this stream (one row = all finishes for that scryfall_id) — the table keeps the first
			// one encountered as a precaution if a duplicate appears anyway, same precedent as Card Kingdom for its own duplicates. A row
			// whose id is not a UUID is not kept: no card has such an id, so nothing could ever ask for it.
			table.add(row.scryfall_id, 0, cells, row.url);
		});
		await pushBytes(stream, new Uint8Array(res.arrayBuffer));
		// No row worth keeping (an array that was never found, a body that is not a pricelist included) is a failure.
		return table.size === 0 ? EMPTY_PRICELIST : new PackedPricelist(table.build());
	} catch {
		return EMPTY_PRICELIST;
	}
}

// Selects the (NM, lowest available price) pair matching the card's finish
// — "etched" has its own dedicated field at Mana Pool (unlike Card
// Kingdom, which only has a generic foil price); "surged" has — as
// everywhere else in this plugin (see getRawCardPrice/types.ts) — no
// dedicated price field, so it is treated as "foiled". Falls back to the
// lowest price, all conditions combined, when no NM copy is in stock for
// this finish, rather than showing nothing.
export function pickManaPoolPrice(entry: ManaPoolCardPrices, finish: Finish): ManaPoolPriceResult | undefined {
	let nm: number | null;
	let fallback: number | null;
	if (finish === "etched") {
		nm = entry.priceCentsNmEtched;
		fallback = entry.priceCentsEtched;
	} else if (finish === "foiled" || finish === "surged") {
		nm = entry.priceCentsNmFoil;
		fallback = entry.priceCentsFoil;
	} else {
		nm = entry.priceCentsNm;
		fallback = entry.priceCents;
	}

	const priceCents = nm ?? fallback;
	if (priceCents == null) return undefined;
	return { priceCents, isNearMint: nm != null, url: entry.url };
}
