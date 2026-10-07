import { Platform } from "obsidian";
import { requestUrlOrNull } from "./safe-request";
import { Finish } from "../core/card-model";

/* -------------------------------------------------------------------------- */
/*  Mana Pool pricelist — 3ᵉ source pour la box "Store Prices"               */
/* -------------------------------------------------------------------------- */

// Endpoint public confirmé (curl direct) : pas de clé, pas de compte, malgré
// ce que suggère la doc générale de l'API ("you must have a Mana Pool
// account and generate an API access token") — cette exigence concerne les
// endpoints vendeur/acheteur/commandes, pas /prices/singles. JSON complet
// (~50 Mo, tout le catalogue en stock) sous {"meta":{...},"data":[{
// scryfall_id, price_cents, price_cents_nm, price_cents_foil,
// price_cents_nm_foil, price_cents_etched, price_cents_nm_etched, url,
// ...}]} — contrairement à Card Kingdom, une seule ligne par scryfall_id
// couvre déjà toutes les finitions (pas de ligne séparée par foil/non-foil),
// donc pas besoin de clé composite ici, juste scryfall_id. Pas de version
// "par carte" non plus — un seul aller-retour pour tout le catalogue, indexé
// une fois en mémoire (voir fetchManaPoolPricelist) comme pour Card Kingdom.
// La doc de la v1 prévient elle-même qu'elle est "still in active
// development and is subject to change without notice" — rien ne garantit
// que cet accès anonyme reste ouvert indéfiniment.
const MANAPOOL_PRICES_URL = "https://manapool.com/api/v1/prices/singles";

const MANAPOOL_HEADERS = {
	// Même identifiant + contact que SCRYFALL_HEADERS (scryfall.ts) — bonne
	// pratique générale, pas une exigence documentée spécifiquement par Mana
	// Pool comme elle l'est chez Scryfall.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

// Toutes les variantes de prix (cents) pour une impression donnée, telles que
// renvoyées par Mana Pool — la sélection de la bonne paire selon la finition
// de la carte se fait dans pickManaPoolPrice, pas ici.
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
	// Faux si aucun exemplaire Near Mint n'était en stock pour cette
	// finition et qu'on est retombé sur le prix le plus bas disponible
	// (toutes conditions confondues) — permet à l'appelant d'afficher une
	// mise en garde plutôt que de faire passer un prix "Played" pour du NM.
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

// Un prix à 0/absent/invalide n'est pas un vrai prix à afficher — même
// traitement que Card Kingdom et que Scryfall lui-même (jamais "$0.00").
function normalizeCents(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Le tarif Mana Pool (49 Mo décompressés) n'est PAS chargé sur téléphone / tablette : requestUrl y encode toute la réponse en base64
// (66 Mo de texte) et l'application Obsidian plante faute de mémoire (même cause que Card Kingdom, voir card-kingdom.ts), et la lire en
// flux par fetch() est impossible — Mana Pool ne répond pas avec access-control-allow-origin (vérifié dans l'application Android réelle :
// « Failed to fetch »). Il n'existe pas de point d'accès par carte (les filtres de l'url sont ignorés, le fichier complet revient). La
// colonne Mana Pool de « Store Prices » y reste donc grisée, avec la mention « Not on mobile » (renderStorePricesBox).
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

	const rows = (res.json?.data as ManaPoolRawEntry[] | undefined) ?? [];

	for (const row of rows) {
		if (!row.scryfall_id || !row.url) continue;
		// Une impression ne devrait apparaître qu'une fois dans ce flux (une
		// ligne = toutes les finitions pour ce scryfall_id) — garder la
		// première rencontrée par sécurité si un doublon apparaît malgré
		// tout, même précédent que Card Kingdom pour ses propres doublons.
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

// Sélectionne la paire (NM, prix le plus bas dispo) correspondant à la
// finition de la carte — "etched" a son propre champ dédié chez Mana Pool
// (contrairement à Card Kingdom, qui n'a qu'un prix foil générique) ;
// "surged" n'a — comme partout ailleurs dans ce plugin (voir
// getRawCardPrice/types.ts) — aucun champ de prix dédié, donc traité comme
// "foiled". Retombe sur le prix le plus bas toutes conditions confondues
// quand aucun exemplaire NM n'est en stock pour cette finition, plutôt que
// de ne rien afficher.
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
