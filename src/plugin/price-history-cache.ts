import type { CardbaseFinish, CardbasePriceHistory } from "../api/cardbase";
import { sleep } from "../api/scryfall";
import { fetchPriceHistoryShard, fetchSiteManifest, parseSiteManifest, priceHistoryReadable, priceHistoryShardName } from "../api/price-history";
import { buildPriceHistory, type PriceHistoryShard } from "../core/price-history";
import type MTGCollectionPlugin from "../plugin";

/* ---------------------------------------------------------------------------- */
/* Our own price history, in front of cardbase (MTGCollectionPlugin).            */
/* ---------------------------------------------------------------------------- */
// The card detail asks getCardbasePriceHistoryWithNativeCardmarket (cardbase-cache.ts) for a card's history;
// when this source is on it answers first, and cardbase is only asked when it has nothing for the card (the
// service unreachable, a card the files don't know, a finish without any series). When it is off — no service
// address yet, or a device that cannot gunzip — nothing here runs and the old path is untouched.

// Shards kept for the session. A parsed shard is ~120 KB; a Cover Flow session touches a few dozen.
const SHARD_CACHE_LIMIT = 64;
// The files change once a day: a session left open for days must not keep showing the prices it read on the first one. After this
// long an entry is read again; if that fails the old one is still served (data a few hours or days old beats sending the card to
// cardbase's frozen figures), and the next try is paused like any failed download.
const SHARD_TTL_MS = 6 * 60 * 60 * 1000;
// After a failed download the same file is not asked again for this long: opening one card asks for its history
// three times (chart, Cardmarket column, badges), and a host that is down must not be hit three times per card.
const FAILURE_PAUSE_MS = 30 * 1000;

// Where the files are (site.json next to them, see src/api/price-history.ts): asked once per session, again every 6 hours for a
// session that stays open, and again after 5 minutes when it could not be asked. What was answered last is kept on this DEVICE
// (local storage, never data.json: another device can be reached differently) so that a host that is down when Obsidian starts
// does not send us back to the address baked into this version once the files have moved.
const POINTER_TTL_MS = 6 * 60 * 60 * 1000;
const POINTER_RETRY_MS = 5 * 60 * 1000;
const POINTER_STORAGE_KEY = "mtg-price-history-shards-base";

function readStoredBase(plugin: MTGCollectionPlugin): string | undefined {
	try {
		const app = plugin.app as unknown as { loadLocalStorage?: (k: string) => unknown };
		const stored: unknown = typeof app.loadLocalStorage === "function" ? app.loadLocalStorage(POINTER_STORAGE_KEY) : null;
		// Checked like a fresh answer: what a device kept is not trusted more than what a host says.
		return typeof stored === "string" ? parseSiteManifest({ v: 1, shards: stored })?.shards || undefined : undefined;
	} catch {
		return undefined;
	}
}

function storeBase(plugin: MTGCollectionPlugin, base: string | null): void {
	try {
		const app = plugin.app as unknown as { saveLocalStorage?: (k: string, v: unknown) => void };
		if (typeof app.saveLocalStorage === "function") app.saveLocalStorage(POINTER_STORAGE_KEY, base);
	} catch {
		/* the answer simply is not kept: asked again next session */
	}
}

/** The address the shard files are downloaded from right now: what site.json says, else the last good one, else the entry point. */
export async function getPriceHistoryBase(this: MTGCollectionPlugin): Promise<string> {
	const known = this.priceHistoryPointer;
	if (known && Date.now() < known.until) return known.base;
	if (this.priceHistoryPointerInFlight) return this.priceHistoryPointerInFlight;
	const entry = this.priceHistoryBaseUrl;
	const promise = (async () => {
		const manifest = await fetchSiteManifest(entry);
		let base: string;
		let ttl = POINTER_TTL_MS;
		if (manifest === undefined) {
			// Could not ask (or junk came back): what was known, soon asked again.
			base = known?.base ?? readStoredBase(this) ?? entry;
			ttl = POINTER_RETRY_MS;
		} else {
			// No manifest (404) or one that says "right here": the entry point itself.
			base = manifest === null || manifest.shards === "" ? entry : manifest.shards;
			storeBase(this, base === entry ? null : base);
		}
		this.priceHistoryPointer = { base, until: Date.now() + ttl };
		return base;
	})();
	this.priceHistoryPointerInFlight = promise;
	void promise.finally(() => {
		this.priceHistoryPointerInFlight = null;
	});
	return promise;
}

export function ownPriceHistoryEnabled(this: MTGCollectionPlugin): boolean {
	return this.priceHistoryBaseUrl !== "" && priceHistoryReadable();
}

/** The shard that holds a card: from the session cache, from a request already under way, or downloaded now. */
export async function getPriceHistoryShard(this: MTGCollectionPlugin, scryfallId: string): Promise<PriceHistoryShard | null | undefined> {
	const name = priceHistoryShardName(scryfallId);
	const cached = this.priceHistoryShardCache.get(name);
	if (cached !== undefined && Date.now() - cached.at < SHARD_TTL_MS) {
		// Most recently used last, so the oldest is what gets dropped.
		this.priceHistoryShardCache.delete(name);
		this.priceHistoryShardCache.set(name, cached);
		return cached.shard;
	}
	const inFlight = this.priceHistoryShardInFlight.get(name);
	if (inFlight) return inFlight;
	// From here `cached`, if there is one, is out of date.
	if (Date.now() < (this.priceHistoryShardFailedUntil.get(name) ?? 0)) return cached?.shard;

	const promise = (async () => {
		let result: PriceHistoryShard | null | undefined;
		const base = await this.getPriceHistoryBase();
		for (let attempt = 0; attempt < 2; attempt++) {
			result = await fetchPriceHistoryShard(base, scryfallId);
			if (result !== undefined) break;
			if (attempt === 0) await sleep(300);
		}
		if (result === undefined) {
			this.priceHistoryShardFailedUntil.set(name, Date.now() + FAILURE_PAUSE_MS);
			return cached?.shard;
		}
		// `null` (the files don't have it) is a confirmed answer: kept, like cardbase's empty histories.
		this.priceHistoryShardCache.delete(name);
		this.priceHistoryShardCache.set(name, { shard: result, at: Date.now() });
		while (this.priceHistoryShardCache.size > SHARD_CACHE_LIMIT) {
			const oldest = this.priceHistoryShardCache.keys().next().value;
			if (oldest === undefined) break;
			this.priceHistoryShardCache.delete(oldest);
		}
		return result;
	})();
	this.priceHistoryShardInFlight.set(name, promise);
	void promise.finally(() => this.priceHistoryShardInFlight.delete(name));
	return promise;
}

/** A card's history from our own files, or undefined: off, unreachable, or nothing for this card and finish. */
export async function getOwnPriceHistory(this: MTGCollectionPlugin, scryfallId: string, finish: CardbaseFinish): Promise<CardbasePriceHistory | undefined> {
	if (!this.ownPriceHistoryEnabled()) return undefined;
	const shard = await this.getPriceHistoryShard(scryfallId);
	return shard ? buildPriceHistory(shard, scryfallId, finish) : undefined;
}
