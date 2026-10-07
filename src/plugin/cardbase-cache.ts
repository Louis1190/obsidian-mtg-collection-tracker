import { CardbaseFinish, CardbasePriceHistory, fetchCardbasePriceHistory, fetchCardbasePrintingCardmarketId, CardmarketNativePrices, fetchCardmarketNativePrices, withNativeCardmarketTrend, pickCardmarketTrendSeries, pickCardmarketLatestPrice, fetchCardbaseMovers, CardbaseVendor, CardbaseMoversResult, CardbaseMoverPeriod } from "../api/cardbase";
import { sleep } from "../api/scryfall";
import type MTGCollectionPlugin from "../plugin";

/* ---------------------------------------------------------------------------- */
/*  cardbase.dev : historique de prix, prix Cardmarket natifs, tendances du marché (MTGCollectionPlugin).*/
/* ---------------------------------------------------------------------------- */

export const CARDMARKET_ID_CACHE_FILENAME = "cardmarket-id-cache.json";
// Voir getCardLegalities/getTcgplayerUrl (scryfall-cache.ts) pour le raisonnement
// (cache + requête en vol partagée par clé composite scryfallId:finish).

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
// Fenêtre de préchargement en arrière-plan (cartes voisines en Cover Flow,
// voir CardDetailModal/WantlistCardDetailModal/DeckCardDetailModal.
// schedulePrefetchNeighbors) — plus large avec une clé cardbase (palier
// 60 req/min) que sans (palier 10 req/min, voir fetchCardbasePriceHistory-
// WithRetry ci-dessous pour le même raisonnement sur `days`). Volontai-
// rement conservateur même avec clé : ce préchargement s'ajoute à la
// requête de la carte réellement affichée, qui doit toujours passer en
// premier et rester rapide.

export function cardbasePrefetchWindow(this: MTGCollectionPlugin): number {
	return this.settings.cardbaseApiKey ? 5 : 2;
}
// Précharge en arrière-plan l'historique cardbase des cartes voisines
// (prev/next) d'une liste de navigation, pour qu'elles soient déjà en
// cache — ou déjà en vol — au moment où l'utilisateur clique réellement
// dessus. `items` a la même longueur/le même ordre que la liste de
// navigation de l'appelant, un `null` marquant les entrées à ignorer
// (carte Proxy — pas de boîte Price History pour elle, voir renderPrice-
// HistoryBox). Strictement séquentiel, jamais en parallèle : le rate
// limit de cardbase (10-60 req/min selon la clé, voir cardbasePrefetch-
// Window) est partagé avec la carte actuellement affichée, donc une rafale
// parallèle de préchargement pourrait ralentir CETTE requête-là — celle
// qui compte le plus. getCardbasePriceHistory dédoublonne déjà cache/vol
// par lui-même, donc appeler cette méthode pour une carte déjà connue ne
// coûte rien de plus qu'une lecture de Map ; la pause de 120ms n'est
// insérée qu'après un véritable aller-retour réseau (pas après un hit de
// cache), pour ne pas ralentir inutilement un préchargement déjà en
// grande partie satisfait par le cache de session.

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
// Même logique de retentative que fetchCardLegalities/fetchTcgplayerUrl —
// une unique retentative après une courte pause avant d'abandonner sans
// mettre l'échec en cache (pour qu'une future demande dans la même
// session retente plutôt que de rester bloquée sur "pas de données").
//
// `days` selon la présence d'une clé : contrairement à ce que dit la doc
// cardbase ("silently capped to the tier limit"), un test direct contre
// l'API réelle montre qu'un `days` au-delà du palier renvoie une vraie
// erreur 400 ("days must be 30 or fewer for your access tier"), pas un
// plafonnement silencieux — demander 365 sans clé valide faisait donc
// échouer la requête à coup sûr (deux fois, avec la pause de 300ms entre
// les deux), d'où une bonne partie de la lenteur perçue tant qu'aucune
// clé n'est enregistrée.

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
// Palier de profondeur d'historique cardbase (voir fetchCardbasePrice-
// HistoryWithRetry ci-dessus pour le raisonnement complet) — extrait ici
// pour être partagé avec fetchCardmarketNativePricesWithRetry ci-dessous,
// qui demande la même fenêtre de jours pour rester cohérent avec
// l'historique générique déjà affiché à côté.

export function cardbaseDaysForTier(this: MTGCollectionPlugin): number {
	return this.settings.cardbaseApiKey ? 365 : 30;
}
// cardmarket_id d'une impression (GET /printings/{scryfall_id}, voir
// cardbase.ts) — même schéma cache+requête-en-vol que getTcgplayerUrl
// (scryfall-cache.ts), `null` mis en cache pour une absence confirmée (impression
// non mappée côté Cardmarket par cardbase), pas pour un échec réseau.

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
// Même logique de retentative que fetchCardLegalities/fetchTcgplayerUrl —
// une unique retentative après une courte pause. undefined (échec réseau/
// HTTP transitoire) et null (404, ou 200 sans cardmarket_id) sont tous
// deux normalisés en `null` ici : côté appelant (getCardbasePriceHistory-
// WithNativeCardmarket ci-dessous), les deux se traduisent de toute façon
// par le même repli gracieux (garder l'ancienne valeur "retail").

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
// Prix natif Cardmarket (GET /cardmarket/{cardmarket_id}/prices, voir
// cardbase.ts) — même schéma cache+requête-en-vol que getCardbasePrice-
// History plus haut, clé cardmarketId (pas scryfallId : plusieurs
// impressions/art variants Scryfall peuvent partager le même produit
// Cardmarket, autant partager le cache entre elles).

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
// Point d'entrée utilisé par renderStorePricesBox/renderPriceHistoryBox
// (les 3 modales) à la place de getCardbasePriceHistory seule — combine
// l'historique générique (Card Kingdom/TCGplayer/Cardsphere, inchangé)
// avec le vrai prix "trend" natif de Cardmarket quand il est disponible
// (voir withNativeCardmarketTrend, cardbase.ts, pour le repli gracieux).
// Volontairement PAS utilisé par prefetchCardbaseNeighbors (voir plus
// haut) : ce préchargement continue de n'appeler que getCardbasePrice-
// History pour rester conservateur sur le budget de requêtes des cartes
// voisines — seule la carte réellement affichée obtient le prix Cardmarket
// natif immédiatement, une navigation vers une voisine peut donc afficher
// brièvement l'ancienne colonne le temps que les deux requêtes en plus
// résolvent, plutôt que de tripler le coût réseau de chaque préchargement.

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
	// "low" (listing Cardmarket la moins chère actuellement) — déjà
	// présent dans `native` (même réponse que "trend" ci-dessus, aucun
	// aller-retour réseau en plus), juste jamais lu jusqu'ici. Voir
	// CardbasePriceHistory.cardmarketLow (cardbase.ts) pour où c'est
	// consommé (infobulle sur la colonne Cardmarket de Store Prices).
	merged.cardmarketLow = pickCardmarketLatestPrice(native, finish, "low");
	return merged;
}
// "Market Trends" (bloc du dashboard Home, home-render.ts — anciennement
// sa propre modale) — top gainers/losers du marché entier, pas de la
// collection de l'utilisateur (voir cardbase.ts; Home filtre côté client
// aux cartes possédées pour rendre certaines lignes cliquables, mais cette
// requête elle-même reste toujours non filtrée). `limit` fixe au MAXIMUM de
// l'API (100 par côté, toujours une seule requête — voir cardbase.ts) depuis
// le 2026-09-23 : avant, 20 suffisaient pour une liste parcourue à l'œil,
// mais le haut de chaque liste est dominé par des prix aberrants (voir
// core/market-movers.ts) que Home écarte côté client — avec 20 lignes, ce
// filtre pouvait ne laisser presque rien. On met en cache les lignes BRUTES,
// pas le résultat filtré : le filtre est pur et instantané, et un futur
// réglage de seuil ne doit pas nécessiter de nouvelle requête.
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
