import { Platform } from "obsidian";
import { requestUrlOrNull } from "./safe-request";
import { Finish } from "../core/card-model";

/* -------------------------------------------------------------------------- */
/* Mana Pool pricelist — 3rd source for the "Store Prices" box */
/* -------------------------------------------------------------------------- */

// Public endpoint, confirmed (direct curl): no key, no account, despite what
// the API's general docs suggest ("you must have a Mana Pool account and
// generate an API access token") — that requirement concerns the
// seller/buyer/orders endpoints, not /prices/singles. Complete JSON (~50 MB,
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

// A price of 0/missing/invalid is not a real price to display — same
// treatment as Card Kingdom and Scryfall itself (never "$0.00").
function normalizeCents(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// The Mana Pool pricelist (49 MB decompressed) is NOT loaded on phone / tablet: requestUrl encodes the whole
// response as base64 there (66 MB of text) and the Obsidian app crashes for lack of memory (same cause as Card
// Kingdom, see card-kingdom.ts), and reading it as a stream with fetch() is impossible — Mana Pool does not
// answer with access-control-allow-origin (checked in the real Android app: "Failed to fetch"). There is no
// per-card endpoint (the url's filters are ignored, the complete file comes back). The Mana Pool column of
// "Store Prices" therefore stays greyed out there, with the mention "Not on mobile" (renderStorePricesBox).
export function manaPoolPricesSupported(): boolean {
	return !Platform.isMobileApp;
}

export async function fetchManaPoolPricelist(): Promise<Map<string, ManaPoolCardPrices>> {
	const map = new Map<string, ManaPoolCardPrices>();
	if (!manaPoolPricesSupported()) return map;
	const res = await requestUrlOrNull({
		url: MANAPOOL_PRICES_URL,
		headers: MANAPOOL_HEADERS,
	});
	if (!res || res.status !== 200) return map;

	const rows = (res.json as { data?: ManaPoolRawEntry[] } | undefined)?.data ?? [];

	for (const row of rows) {
		if (!row.scryfall_id || !row.url) continue;
		// A printing should appear only once in this stream (one row = all
		// finishes for that scryfall_id) — keep the first one encountered as a
		// precaution if a duplicate appears anyway, same precedent as Card Kingdom
		// for its own duplicates.
		if (map.has(row.scryfall_id)) continue;

		map.set(row.scryfall_id, {
			url: row.url,
			priceCents: normalizeCents(row.price_cents),
			priceCentsNm: normalizeCents(row.price_cents_nm),
			priceCentsFoil: normalizeCents(row.price_cents_foil),
			priceCentsNmFoil: normalizeCents(row.price_cents_nm_foil),
			priceCentsEtched: normalizeCents(row.price_cents_etched),
			priceCentsNmEtched: normalizeCents(row.price_cents_nm_etched),
		});
	}

	return map;
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
