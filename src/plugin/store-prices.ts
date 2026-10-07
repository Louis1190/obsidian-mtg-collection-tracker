import { Platform } from "obsidian";
import { CardKingdomPriceEntry, fetchCardKingdomPricelist, cardKingdomKey } from "../api/card-kingdom";
import { ManaPoolCardPrices, fetchManaPoolPricelist, ManaPoolPriceResult, pickManaPoolPrice } from "../api/manapool";
import { Finish } from "../core/card-model";
import type MTGCollectionPlugin from "../plugin";

/* ---------------------------------------------------------------------------- */
/*  Prix des magasins : tarifs Card Kingdom et Mana Pool (src/plugin/, groupe de méthodes de MTGCollectionPlugin).*/
/* ---------------------------------------------------------------------------- */

// Charge (une fois par session) tout le tarif Card Kingdom — un seul
// fichier pour le catalogue entier (~67 Mo), pas un point d'accès par
// carte comme Scryfall (voir card-kingdom.ts). N'écrit le cache qu'en cas
// de succès confirmé (map non vide) : un échec transitoire ne doit pas
// figer une table vide, qui priverait alors TOUTE carte de prix Card
// Kingdom pour le reste de la session — même logique que loadSymbology
// (scryfall-cache.ts). fetchCardKingdomPricelist renvoie déjà une Map vide (jamais
// une exception) sur un échec réseau/HTTP, même convention que
// fetchScryfallCollection ailleurs dans ce plugin.

export async function loadCardKingdomPrices(this: MTGCollectionPlugin): Promise<Map<string, CardKingdomPriceEntry>> {
	if (this.cardKingdomPricesCache) return this.cardKingdomPricesCache;
	if (!this.cardKingdomPricesFetchPromise) {
		// Mobile : lecture en flux (un tarif de 65 Mo via requestUrl y ferait planter l'application, voir fetchCardKingdomPricelist).
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
// Prix de vente Card Kingdom pour une impression précise (par scryfallId +
// foil/non-foil — voir cardKingdomKey). undefined si Card Kingdom ne
// vend/n'a jamais vendu cette carte dans cette finition.

export async function getCardKingdomPrice(this: MTGCollectionPlugin, scryfallId: string, isFoil: boolean): Promise<CardKingdomPriceEntry | undefined> {
	const map = await this.loadCardKingdomPrices();
	return map.get(cardKingdomKey(scryfallId, isFoil));
}
// Même logique que loadCardKingdomPrices : un seul aller-retour par
// session, cache écrit seulement en cas de succès confirmé (map non
// vide) pour qu'un échec transitoire ne prive pas toute la session de
// prix Mana Pool.

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
// Prix Mana Pool pour une impression précise, selon sa finition — voir
// pickManaPoolPrice pour la sélection NM/etched/foil et le fallback
// "prix le plus bas disponible". undefined si Mana Pool n'a aucun
// exemplaire de cette impression en stock.

export async function getManaPoolPrice(this: MTGCollectionPlugin, scryfallId: string, finish: Finish): Promise<ManaPoolPriceResult | undefined> {
	const map = await this.loadManaPoolPrices();
	const entry = map.get(scryfallId);
	return entry ? pickManaPoolPrice(entry, finish) : undefined;
}
