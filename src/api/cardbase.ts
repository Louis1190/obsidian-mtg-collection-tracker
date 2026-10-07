import { requestUrlOrNull } from "./safe-request";

/* -------------------------------------------------------------------------- */
/*  cardbase.dev — historique de prix (boîte "Price History") ET, depuis la  */
/*  colonne Cardmarket ajoutée à "Store Prices", le prix courant Cardmarket   */
/*  (dernier point de la même série déjà récupérée — aucun aller-retour       */
/*  réseau supplémentaire, voir getCardbaseLatestPrice ci-dessous).           */
/* -------------------------------------------------------------------------- */

// Point d'accès par impression (pas de version "tout le catalogue" comme
// Card Kingdom/Mana Pool) : GET /printings/{scryfall_id}/prices, auth
// optionnelle (Bearer, voir settings.cardbaseApiKey) — anonyme = 30 jours
// d'historique, avec clé = 365 jours, plafond appliqué silencieusement côté
// serveur donc pas besoin de logique cliente pour ça (voir fetchCardbase-
// PriceHistory : on demande toujours 365 jours, le serveur réduit lui-même
// si nécessaire). vendor omis dans la requête (on filtre côté client après
// coup) pour ne faire qu'un seul aller-retour au lieu d'un par magasin.
const CARDBASE_BASE_URL = "https://api.cardbase.dev/v1";

const CARDBASE_HEADERS = {
	// Même identifiant + contact que SCRYFALL_HEADERS (scryfall.ts) — cohérence
	// entre toutes les APIs de ce plugin, pas une exigence propre à cardbase.dev.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

// cardkingdom/tcgplayer/cardmarket/cardsphere alimentent tous les 4 le
// graphique "Price History" ; cardmarket alimente en plus, via
// getCardbaseLatestPrice, la colonne du même nom dans "Store Prices" (même
// requête déjà faite pour le graphique, aucun aller-retour réseau en plus).
// cardsphere est un vendeur documenté par cardbase mais dont la couverture
// semble actuellement vide en pratique — vérifié en direct (`vendor=
// cardsphere` sur Sol Ring ×3 impressions + Counterspell : `series: []`
// à chaque fois) — câblé quand même : si cardbase le peuple plus tard,
// cette courbe apparaît d'elle-même, sans autre changement de code.
// cardhoarder délibérément exclu : ce n'est pas un prix "papier", mais le
// marché des tickets Magic Online (jeu en ligne) — le mélanger aux 4 autres
// serait trompeur pour un plugin qui suit une collection physique. Une
// réponse réelle a par ailleurs inopinément inclus une série "manapool"
// (prix + points), alors que ce vendeur n'apparaît nulle part dans
// l'énumération `vendor` documentée par cardbase — pas retenue ici pour
// autant : ce plugin a déjà sa propre source Mana Pool directe
// (manapool.ts) pour Store Prices, et rien ne garantit que ce vendeur non
// documenté reste couvert de façon fiable côté cardbase.
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
	// meta.as_of de la réponse cardbase — date des données de prix les plus
	// récentes en base (pas forcément "aujourd'hui", l'ingestion tourne une
	// fois par jour). Affichée par renderPriceHistorySourceFooter, voir
	// card-detail-fx.ts — délibérément réutilisée depuis cette réponse déjà
	// récupérée plutôt que d'ajouter un appel GET /status séparé, jugé pas
	// justifié pour une simple date de fraîcheur déjà présente ailleurs.
	asOf?: string;
	// Prix de la listing Cardmarket la moins chère actuellement disponible
	// (price_type="low" du Price Guide natif) — voir pickCardmarketLatestPrice
	// et son point d'attache, MTGCollectionPlugin.getCardbasePriceHistory-
	// WithNativeCardmarket (plugin.ts). Pas un champ de PriceSeries/series
	// (pas une donnée qu'on veut tracer sur le graphique ni comparer jour à
	// jour comme "trend") — juste une info ponctuelle affichée en infobulle
	// sur la colonne Cardmarket de Store Prices. undefined si Cardmarket n'a
	// aucune listing pour cette impression/finition.
	cardmarketLow?: CardbaseLatestPrice;
}

interface CardbaseRawSeries {
	vendor?: string;
	finish?: string;
	price_type?: string;
	currency?: string;
	points?: [string, number][];
}

// undefined = échec (réseau, 4xx/5xx, réponse mal formée) — à distinguer par
// l'appelant d'un succès confirmé avec une série vide (carte réellement sans
// historique chez ces deux magasins), qui doit lui être mis en cache tel
// quel. Toujours price_type=retail : c'est ce que les colonnes Card Kingdom/
// TCGplayer de la boîte "Store Prices" affichent déjà (voir card-kingdom.ts/
// renderStorePricesBox) — une courbe "buylist" ne se comparerait pas au
// point le plus récent déjà visible juste au-dessus.
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

	const rawSeries = (res.json?.data?.series as CardbaseRawSeries[] | undefined) ?? [];
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
		historyBegins: res.json?.meta?.history_begins,
		asOf: res.json?.meta?.as_of,
	};
}

export interface CardbaseLatestPrice {
	price: number;
	currency: string;
}

// Dernier point (le plus récent) de la série d'un magasin donné, pour la
// colonne "Cardmarket" de Store Prices — vérifié directement contre l'API
// réelle (pas juste supposé) que `vendor=cardmarket` renvoie bien un
// `price_type=retail` en EUR, comme cardkingdom/tcgplayer en USD ; `points`
// est déjà trié par date croissante par cardbase (voir sa doc), donc le
// dernier élément est le plus récent, pas besoin de re-trier ici.
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

// Variation veille→aujourd'hui pour un magasin donné, à partir des DEUX
// DERNIERS points déjà présents dans la série (aucun fetch en plus — cet
// historique est déjà récupéré pour la boîte "Price History"/la colonne
// Cardmarket, voir renderStorePricesBox). undefined si la série a moins de 2
// points (carte trop récente dans le jeu de données cardbase, cf.
// meta.history_begins) ou si le prix de la veille est 0 (une division par 0
// n'a pas de sens ici). "flat" (0%) est un résultat valide, distinct
// d'undefined — l'appelant décide s'il veut l'afficher ou le masquer.
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

// undefined = échec (réseau, 4xx/5xx) ; `null` (côté appelant, voir
// plugin.ts) = réponse confirmée sans cardmarket_id (impression que
// cardbase n'a pas mappée côté Cardmarket) — deux cas différents, à ne pas
// confondre dans le cache.
export async function fetchCardbasePrintingCardmarketId(
	scryfallId: string,
	apiKey: string
): Promise<number | undefined | null> {
	const headers: Record<string, string> = { ...CARDBASE_HEADERS };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await requestUrlOrNull({ url: `${CARDBASE_BASE_URL}/printings/${scryfallId}`, headers });
	if (res && res.status === 404) return null;
	if (!res || res.status !== 200) return undefined;
	const data = res.json?.data as CardbasePrintingRaw | undefined;
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

// Pas de filtre vendor/price_type/finish côté serveur pour cet endpoint
// (contrairement à /printings/{id}/prices) — on récupère toujours les 12
// séries (2 finitions × 6 types) et on filtre côté client (voir
// pickCardmarketTrendSeries). Même logique days/palier que fetchCardbase-
// PriceHistory (l'appelant, plugin.ts, calcule la même valeur pour les deux).
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

	const rawSeries = (res.json?.data?.series as CardmarketRawSeries[] | undefined) ?? [];
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

// "etched" n'existe pas côté Cardmarket (son API ne connaît que normal/foil,
// voir CardmarketFinish) — replié sur "foil", même traitement que "surged"
// déjà appliqué ailleurs dans ce plugin pour la même raison (pas de valeur
// dédiée disponible côté source, foil est le plus proche). undefined si
// aucune série "trend" pour cette finition (impression trop récente,
// finition non vendue par Cardmarket) — l'appelant (withNativeCardmarketTrend)
// sait alors garder l'ancienne valeur "retail" plutôt que d'afficher un
// trou.
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

// Même repli finish "etched" → "foil" que pickCardmarketTrendSeries
// ci-dessus. Généralisé sur `priceType` (pas figé sur "low") même si le
// seul appelant actuel demande "low" (le prix de la listing la moins chère
// actuellement disponible) — la réponse native contient déjà les 6 types du
// Price Guide (voir fetchCardmarketNativePrices), `pickCardmarketTrendSeries`
// n'en garde qu'un ("trend") pour la colonne/le graphique principal ; cette
// fonction-ci récupère un point ponctuel (pas une série complète, pas besoin
// d'historique pour un "prix le plus bas actuel") parmi les 5 types restants
// qui seraient sinon jetés sans jamais être lus.
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

// Remplace la série "cardmarket" (générique, price_type=retail) de `history`
// par la série "trend" native quand elle est disponible — repli gracieux
// délibéré : si `nativeTrend` est undefined (cardmarket_id introuvable,
// endpoint natif en échec, aucun point pour cette finition), `history` est
// renvoyé TEL QUEL, avec sa colonne "cardmarket" générique déjà en place,
// plutôt que de retirer toute donnée Cardmarket — jamais pire qu'avant cette
// fonctionnalité. Renvoie exactement la même forme CardbasePriceHistory déjà
// consommée par renderPriceHistoryChart/getCardbaseLatestPrice/getCardbase-
// DayChange, donc aucun changement requis côté rendu — seule la donnée
// change de source.
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
/*  "Market Trends" — GET /movers, les cartes qui ont le plus bougé, EN      */
/*  PRIX, sur le marché ENTIER (pas scopé à la collection de l'utilisateur — */
/*  seul endroit de ce fichier dans ce cas) — voir modals/market-trends-     */
/*  modal.ts. Une seule requête, pas de pagination (contrairement à          */
/*  /changes, jugé trop volumineux pour un usage par carte — voir la         */
/*  discussion qui a mené à explorer /movers à la place), et le nom de la    */
/*  carte est déjà inclus dans la réponse, pas besoin d'un aller-retour      */
/*  Scryfall en plus pour l'afficher.                                        */
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
	// Voir CardbasePriceHistory.asOf ci-dessus pour le raisonnement complet
	// (meta.as_of déjà présent sur cette réponse, pas d'appel /status séparé).
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

// undefined = échec réseau/HTTP. `vendor` omis = tous vendeurs confondus
// (ce que l'endpoint fait lui-même par défaut). `limit` s'applique
// indépendamment à gainers ET losers (voir la doc cardbase — "Maximum
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
		gainers: parseCardbaseMovers(res.json?.data?.gainers),
		losers: parseCardbaseMovers(res.json?.data?.losers),
		asOf: res.json?.meta?.as_of,
	};
}

// Ancien mécanisme (jusqu'au 2026-09-15) : demander days=365 sur
// /printings/{id}/prices et s'appuyer sur un 400 précis ("days must be 30
// or fewer for your access tier") pour détecter une clé qui n'élève pas
// réellement le palier. Ce comportement n'existe plus — vérifié en direct
// ET confirmé par la doc actuelle de cardbase (https://cardbase.dev/docs) :
// dépasser son palier est maintenant plafonné silencieusement (200, avec
// meta.history_begins reflétant ce qui a vraiment été renvoyé), jamais
// rejeté en 400. Pire, en test réel, même une fausse clé a obtenu bien plus
// que les 30 jours "anonymes" annoncés — donc ce signal ne fonctionnait
// déjà plus du tout, pas juste "différemment". Voir docs/history/price-
// history-chart.md (entrée 2026-09-15) pour l'investigation complète.
//
// Nouveau mécanisme : /bulk/prices/{date} exige une authentification (401
// "Unauthorized" si absente/invalide — vérifié en direct, jamais mis en
// cache côté cardbase, Cache-Control: no-store) et vérifie l'auth AVANT la
// validité de la date (vérifié en direct sur 3 dates différentes : une date
// bidon et une date dans le futur lointain renvoient toutes les deux 401
// sans clé, jamais un 400 "date invalide" à la place). En demandant une
// date volontairement hors plage (fixe, plus de 365 jours dans le passé,
// donc jamais besoin de maintenance), le serveur ne peut renvoyer 401 QUE
// si la clé est rejetée — n'importe quelle autre réponse (400/404 attendus
// pour "date trop ancienne") signifie que la clé a été acceptée, sans
// jamais atteindre le vrai 302 vers le dump complet (donc aucun
// téléchargement déclenché juste pour tester une clé).
const CARDBASE_TEST_BULK_DATE = "2000-01-01";

export type CardbaseConnectionStatus = "ok" | "rejected" | "error";

// N'est appelée qu'avec une clé non vide — l'appelant (setting-tab.ts) gère
// à part le cas "aucune clé saisie", qui n'a pas besoin d'un aller-retour
// réseau pour être diagnostiqué (toujours limité à 30 jours, par définition).
export async function testCardbaseConnection(apiKey: string): Promise<CardbaseConnectionStatus> {
	const res = await requestUrlOrNull({
		url: `${CARDBASE_BASE_URL}/bulk/prices/${CARDBASE_TEST_BULK_DATE}`,
		headers: { ...CARDBASE_HEADERS, Authorization: `Bearer ${apiKey}` },
	});
	// Pas de réponse du tout (hors ligne…) : le même « error » qu'un 429/5xx — la clé n'est pas en cause.
	if (!res) return "error";
	if (res.status === 401) return "rejected";
	if (res.status === 429 || res.status >= 500) return "error";
	return "ok";
}
