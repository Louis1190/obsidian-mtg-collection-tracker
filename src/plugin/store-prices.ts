import { Platform } from "obsidian";
import { CardKingdomPriceEntry, fetchCardKingdomPricelist, cardKingdomKey } from "../api/card-kingdom";
import { ManaPoolCardPrices, fetchManaPoolPricelist, ManaPoolPriceResult, pickManaPoolPrice } from "../api/manapool";
import { Finish } from "../core/card-model";
import type MTGCollectionPlugin from "../plugin";

/* ---------------------------------------------------------------------------- */
/* Store prices: Card Kingdom and Mana Pool pricelists (src/plugin/, method group of MTGCollectionPlugin). */
/* ---------------------------------------------------------------------------- */

// Loads (once per session) the whole Card Kingdom pricelist — a single file for
// the entire catalog (~67 MB), not a per-card endpoint like Scryfall (see
// card-kingdom.ts). Only writes the cache on a confirmed success (non-empty map):
// a transient failure must not freeze an empty table, which would then deprive
// EVERY card of a Card Kingdom price for the rest of the session — same logic as
// loadSymbology (scryfall-cache.ts). fetchCardKingdomPricelist already returns an
// empty Map (never an exception) on a network/HTTP failure, same convention as
// fetchScryfallCollection elsewhere in this plugin.

export async function loadCardKingdomPrices(this: MTGCollectionPlugin): Promise<Map<string, CardKingdomPriceEntry>> {
	if (this.cardKingdomPricesCache) return this.cardKingdomPricesCache;
	if (!this.cardKingdomPricesFetchPromise) {
		// Mobile: stream reading (a 65 MB pricelist via requestUrl would crash the app there, see fetchCardKingdomPricelist).
		this.cardKingdomPricesFetchPromise = fetchCardKingdomPricelist({ stream: Platform.isMobileApp }).then((map) => {
			if (map.size === 0) {
				this.cardKingdomPricesFetchPromise = null;
				return map;
			}
			this.cardKingdomPricesCache = map;
			return map;
		});
	}
	return this.cardKingdomPricesFetchPromise;
}
// Card Kingdom selling price for a precise printing (by scryfallId +
// foil/non-foil — see cardKingdomKey). undefined if Card Kingdom doesn't
// sell/has never sold this card in this finish.

export async function getCardKingdomPrice(this: MTGCollectionPlugin, scryfallId: string, isFoil: boolean): Promise<CardKingdomPriceEntry | undefined> {
	const map = await this.loadCardKingdomPrices();
	return map.get(cardKingdomKey(scryfallId, isFoil));
}
// Same logic as loadCardKingdomPrices: a single round trip per session,
// cache written only on confirmed success (non-empty map) so that a
// transient failure doesn't deprive the whole session of Mana Pool prices.

export async function loadManaPoolPrices(this: MTGCollectionPlugin): Promise<Map<string, ManaPoolCardPrices>> {
	if (this.manaPoolPricesCache) return this.manaPoolPricesCache;
	if (!this.manaPoolPricesFetchPromise) {
		this.manaPoolPricesFetchPromise = fetchManaPoolPricelist().then((map) => {
			if (map.size === 0) {
				this.manaPoolPricesFetchPromise = null;
				return map;
			}
			this.manaPoolPricesCache = map;
			return map;
		});
	}
	return this.manaPoolPricesFetchPromise;
}
// Mana Pool price for a precise printing, according to its finish — see
// pickManaPoolPrice for the NM/etched/foil selection and the "lowest
// available price" fallback. undefined if Mana Pool has no copy of this
// printing in stock.

export async function getManaPoolPrice(this: MTGCollectionPlugin, scryfallId: string, finish: Finish): Promise<ManaPoolPriceResult | undefined> {
	const map = await this.loadManaPoolPrices();
	const entry = map.get(scryfallId);
	return entry ? pickManaPoolPrice(entry, finish) : undefined;
}
