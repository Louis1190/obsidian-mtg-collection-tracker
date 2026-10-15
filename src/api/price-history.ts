import { parseShard, type PriceHistoryShard } from "../core/price-history";
import { parseCardbaseMovers, type CardbaseMoverPeriod, type CardbaseMoversBody, type CardbaseMoversResult, type CardbaseVendor } from "./cardbase";
import { gunzipBytes } from "./github";
import { requestUrlOrNull } from "./safe-request";

/* -------------------------------------------------------------------------- */
/* Our own price history: downloading ONE shard file (see core/price-history.ts) */
/* -------------------------------------------------------------------------- */

export const PRICE_HISTORY_BASE_URL = "https://louis1190.github.io/mtg-price-history";

const HEADERS = {
	// Same identifier + contact as the other data sources (cardbase.ts, scryfall.ts).
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
};

// The address above is the ENTRY POINT. Next to the files sits a tiny `site.json` that says where the files are NOW: usually
// "right here", or the https address of another host if they ever have to move (GitHub Pages has a soft bandwidth limit, and the
// address above is baked into every plugin version already installed). The plugin reads it first (price-history-cache.ts), so a
// move needs a change to that one file, not an update of the plugin. The file is `{ "v": 1, "shards": "" }`: tools/price-history,
// site-static/site.json.
export const SITE_MANIFEST_FILE = "site.json";

/** A manifest is a few bytes; anything bigger is not one. */
const SITE_MANIFEST_MAX_BYTES = 4096;

/**
 * The address of the shard files that a `site.json` names: "" = right here (no address given), otherwise a plain https address
 * without a trailing slash. null = unusable (not an object, another format version, or an address that is not a plain https
 * URL on a named host): the caller then carries on as if the file did not exist. This is the only thing in the plugin that lets
 * a downloaded file choose where the plugin sends requests, so it is strict: https only, no credentials, query or fragment,
 * a host name with a dot that is not an IP address.
 */
export function parseSiteManifest(json: unknown): { shards: string } | null {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
	const { v, shards } = json as { v?: unknown; shards?: unknown };
	if (v !== 1) return null;
	if (shards === undefined || shards === null || shards === "") return { shards: "" };
	if (typeof shards !== "string" || shards.length > 300) return null;
	let url: URL;
	try {
		url = new URL(shards);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
	if (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) return null;
	return { shards: shards.replace(/\/+$/, "") };
}

/**
 * Reads `site.json` next to the entry point. `null` = the host answered 404 (no manifest: the files are right here);
 * `undefined` = failure of any kind (offline, another status, junk); otherwise the parsed manifest. Never throws.
 */
export async function fetchSiteManifest(baseUrl: string): Promise<{ shards: string } | null | undefined> {
	const res = await requestUrlOrNull({ url: `${baseUrl.replace(/\/+$/, "")}/${SITE_MANIFEST_FILE}`, headers: HEADERS });
	if (!res) return undefined;
	if (res.status === 404) return null;
	if (res.status !== 200 || res.arrayBuffer.byteLength > SITE_MANIFEST_MAX_BYTES) return undefined;
	try {
		return parseSiteManifest(JSON.parse(new TextDecoder().decode(new Uint8Array(res.arrayBuffer)))) ?? undefined;
	} catch {
		return undefined;
	}
}

/** The file that holds a card: the first 3 hex characters of its Scryfall id (4 096 files, 8-30 KB each). */
export function priceHistoryShardName(scryfallId: string): string {
	return scryfallId.slice(0, 3).toLowerCase();
}

export function priceHistoryShardUrl(baseUrl: string, shardName: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/s/${shardName}.json.gz`;
}

/** Reading the files needs gunzip (Chromium, Android WebView, iOS/iPadOS 16.4+); a device without it simply keeps cardbase. */
export function priceHistoryReadable(): boolean {
	return typeof DecompressionStream !== "undefined";
}

const GZIP_MAGIC = [0x1f, 0x8b];

// A shard is 8-30 KB of gzip and about 30-120 KB of JSON today; a year of history makes it four times that. The limits are an order of
// magnitude above: they only exist so that a host that answers with something else (the address comes from a downloaded file, see
// parseSiteManifest) cannot make the plugin allocate gigabytes. Past them the answer is a failure like any other (cardbase takes over).
const SHARD_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const SHARD_MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * The shard file of a card. `null` = the host answered 404 (no such file: the card is unknown to the files);
 * `undefined` = failure of any kind (offline, a status other than 200 or 404, damaged or foreign content). Never
 * throws.
 */
export async function fetchPriceHistoryShard(baseUrl: string, scryfallId: string): Promise<PriceHistoryShard | null | undefined> {
	const res = await requestUrlOrNull({ url: priceHistoryShardUrl(baseUrl, priceHistoryShardName(scryfallId)), headers: HEADERS });
	if (!res) return undefined;
	if (res.status === 404) return null;
	if (res.status !== 200) return undefined;
	try {
		if (res.arrayBuffer.byteLength > SHARD_MAX_DOWNLOAD_BYTES) return undefined;
		const bytes = new Uint8Array(res.arrayBuffer);
		// A CDN may already have undone the compression on the way: accept both.
		const gzipped = bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
		// Bounded while it decompresses (an answer that is not gzip is already bounded by the download limit above).
		const text = new TextDecoder().decode(gzipped ? await gunzipBytes(bytes, SHARD_MAX_JSON_BYTES) : bytes);
		return parseShard(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* Market movers (Home): lists our daily job computes from the same files      */
/* -------------------------------------------------------------------------- */

/** The file of one list: `movers/<period>-<view>.json`, view = "all" (no vendor chosen) or the vendor's name. Twelve small files in all. */
export function moversFileUrl(baseUrl: string, period: CardbaseMoverPeriod, vendor: CardbaseVendor | undefined): string {
	return `${baseUrl.replace(/\/+$/, "")}/movers/${period}-${vendor ?? "all"}.json`;
}

// A list file is about 8 KB (20 rows a side). The limits only exist because the address can come from a downloaded file (see
// parseSiteManifest): something much bigger is not one of ours, and a failure is answered like any other (cardbase takes over).
const MOVERS_MAX_BYTES = 256 * 1024;
const MOVERS_MAX_ROWS = 100;

/**
 * One movers list, in cardbase's own response shape (tools/price-history/lib/movers.mjs writes it), read with the parser the
 * cardbase response already goes through: a row with an unknown vendor, finish or a missing field is dropped. undefined = failure of any kind
 * (offline, a status other than 200, the wrong period, no lists, junk): the caller then asks cardbase. Never throws.
 */
export async function fetchOwnMovers(baseUrl: string, period: CardbaseMoverPeriod, vendor: CardbaseVendor | undefined): Promise<CardbaseMoversResult | undefined> {
	const res = await requestUrlOrNull({ url: moversFileUrl(baseUrl, period, vendor), headers: HEADERS });
	if (!res || res.status !== 200) return undefined;
	try {
		if (res.arrayBuffer.byteLength > MOVERS_MAX_BYTES) return undefined;
		const body = JSON.parse(new TextDecoder().decode(new Uint8Array(res.arrayBuffer))) as CardbaseMoversBody | null;
		const data = body?.data;
		if (!data || data.period !== period || !Array.isArray(data.gainers) || !Array.isArray(data.losers)) return undefined;
		const asOf = body?.meta?.as_of;
		return {
			period,
			gainers: parseCardbaseMovers(data.gainers).slice(0, MOVERS_MAX_ROWS),
			losers: parseCardbaseMovers(data.losers).slice(0, MOVERS_MAX_ROWS),
			asOf: typeof asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : undefined,
			source: "price-history",
		};
	} catch {
		return undefined;
	}
}
