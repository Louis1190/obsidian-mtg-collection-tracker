import type { CardbaseMover, CardbaseFinish } from "../api/cardbase";
import type { Finish } from "./card-model";
import type { PriceCurrency } from "./price";

/* -------------------------------------------------------------------------- */
/*  Logique PURE derrière le bloc "Market Trends" de Home (2026-09-23) :       */
/*  filtre d'anomalies, ancienneté des données, correspondance avec la         */
/*  collection/wantlist, prix affiché. Aucun accès Obsidian/DOM — testée dans  */
/*  market-movers.test.ts ; le rendu lui-même est dans view/home-render.ts.   */
/* -------------------------------------------------------------------------- */

export const MOVER_MIN_PRICE = 2;
export const MOVER_MAX_JUMP_RATIO = 5;
export const MOVER_HIGH_PRICE = 250;
export const MOVER_HIGH_PRICE_MAX_JUMP_RATIO = 2;

export function shouldHideMover(m: Pick<CardbaseMover, "priceFrom" | "priceTo">): boolean {
	const { priceFrom, priceTo } = m;
	if (!Number.isFinite(priceFrom) || !Number.isFinite(priceTo)) return true;
	const lo = Math.min(priceFrom, priceTo);
	const hi = Math.max(priceFrom, priceTo);
	// lo < MOVER_MIN_PRICE couvre aussi 0/négatif : la division ci-dessous ne
	// s'exécute jamais avec lo <= 0.
	if (lo < MOVER_MIN_PRICE) return true;
	const ratio = hi / lo;
	if (ratio > MOVER_MAX_JUMP_RATIO) return true;
	return hi >= MOVER_HIGH_PRICE && ratio > MOVER_HIGH_PRICE_MAX_JUMP_RATIO;
}

// Filtre puis trie explicitement (gainers : plus forte hausse d'abord ;
// losers : plus forte baisse d'abord) plutôt que de faire confiance à l'ordre
// de l'API — il est déjà celui-là aujourd'hui, mais rien ne le garantit. Ne
// modifie pas le tableau reçu (il vit dans le cache de session du plugin,
// cardbaseMoversCache, et resservira tel quel au prochain affichage).
export function selectDisplayMovers(rows: CardbaseMover[], direction: "up" | "down", limit: number): CardbaseMover[] {
	const kept = rows.filter((m) => !shouldHideMover(m));
	kept.sort(direction === "up" ? (a, b) => b.changePct - a.changePct : (a, b) => a.changePct - b.changePct);
	return kept.slice(0, limit);
}

/* --- Ancienneté des données ------------------------------------------------
   cardbase met ses prix à jour une fois par jour (~06:40 UTC) : une date
   `as_of` (meta.as_of, voir CardbaseMoversResult) de la veille ou d'avant-
   hier est normale, pas un incident. Le 2026-09-23, elle datait pourtant du
   2026-09-09 (/status annonçait la mise à jour suivante pour le 09-10) — et
   le bloc n'affichait que "Data as of 2026-09-09" en tout petit, sans rien
   signaler. Seuil à 3 jours : assez large pour ne jamais s'allumer sur un
   décalage ordinaire (week-end compris), assez court pour attraper un vrai
   arrêt du pipeline. */
export const MOVERS_STALE_AFTER_DAYS = 3;

// undefined = date absente ou illisible (pas d'avertissement dans ce cas —
// mieux vaut se taire que de crier sur une donnée qu'on ne sait pas lire).
// asOf est une date "YYYY-MM-DD" (UTC) ; le décompte se fait en jours
// entiers depuis minuit UTC de cette date, jamais négatif.
export function getMoversAgeDays(asOf: string | undefined, now: number): number | undefined {
	if (!asOf) return undefined;
	const t = Date.parse(`${asOf}T00:00:00Z`);
	if (!Number.isFinite(t)) return undefined;
	return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function isMoversDataStale(ageDays: number | undefined): boolean {
	return ageDays !== undefined && ageDays >= MOVERS_STALE_AFTER_DAYS;
}

/* --- Correspondance avec la collection/wantlist ----------------------------
   Une ligne de /movers est propre à une impression ET à une finition (le prix
   d'un foil bouge indépendamment du non-foil) : "je possède cette carte" ne
   veut donc dire quelque chose ici que pour la MÊME finition — un badge
   "possédée ×2" sur un mouvement de prix foil alors que les deux exemplaires
   sont non-foil laisserait croire que c'est LEUR valeur qui a bougé. Finish
   (ce plugin) → CardbaseFinish : Surge Foil se cote comme un foil (voir
   getRawCardPrice, price.ts) ; Proxy n'a aucune valeur de marché → null. */
export function moverFinishOf(finish: Finish): CardbaseFinish | null {
	switch (finish) {
		case "regular":
			return "normal";
		case "foiled":
		case "surged":
			return "foil";
		case "etched":
			return "etched";
		default:
			return null;
	}
}

export function moverOwnershipKey(scryfallId: string, finish: CardbaseFinish): string {
	return `${scryfallId}|${finish}`;
}

/* --- Prix affiché ----------------------------------------------------------
   cardbase donne chaque prix dans la devise NATIVE du vendeur (USD pour
   TCGplayer/Card Kingdom/Cardsphere, EUR pour Cardmarket) : dans "All
   vendors", une liste mêle donc les deux. On convertit dans la devise choisie
   par l'utilisateur (settings.priceCurrency) — comme le graphique Price
   History, et pour la même raison : des lignes comparables entre elles.
   `convert` est injectée (voir convertUsdEur, api/frankfurter.ts) plutôt
   qu'importée, pour que ce module reste sans dépendance vers Obsidian ; sans
   fonction (taux indisponible), on affiche le montant natif tel quel plutôt
   que de cacher le prix — jamais un chiffre faux, au pire un chiffre dans
   l'autre devise avec son propre symbole. */
export interface MoverPriceDisplay {
	// Devise réellement affichée : celle demandée, ou la devise native du
	// vendeur si aucune conversion n'a été possible.
	currency: PriceCurrency;
	from: number;
	to: number;
	delta: number;
	converted: boolean;
}

export type MoverConvert = (amount: number, from: PriceCurrency, to: PriceCurrency) => number;

export function moverNativeCurrency(m: Pick<CardbaseMover, "currency">): PriceCurrency {
	return m.currency.toUpperCase() === "EUR" ? "eur" : "usd";
}

export function getMoverPriceDisplay(
	m: Pick<CardbaseMover, "currency" | "priceFrom" | "priceTo">,
	target: PriceCurrency,
	convert: MoverConvert | undefined
): MoverPriceDisplay {
	const native = moverNativeCurrency(m);
	if (native === target || !convert) {
		return { currency: native, from: m.priceFrom, to: m.priceTo, delta: m.priceTo - m.priceFrom, converted: false };
	}
	const from = convert(m.priceFrom, native, target);
	const to = convert(m.priceTo, native, target);
	return { currency: target, from, to, delta: to - from, converted: true };
}
