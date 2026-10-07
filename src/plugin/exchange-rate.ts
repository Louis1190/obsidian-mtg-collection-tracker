import { UsdEurRate, fetchUsdEurRate } from "../api/frankfurter";
import type MTGCollectionPlugin from "../plugin";

/* ---------------------------------------------------------------------------- */
/*  Taux de change USD/EUR (frankfurter.dev), un seul par session (MTGCollectionPlugin).*/
/* ---------------------------------------------------------------------------- */

// Charge (une fois par session) le taux USD/EUR de frankfurter.dev.
// N'écrit le cache qu'en cas de succès confirmé — même logique que
// loadSymbology/loadCardKingdomPrices : un échec transitoire ne doit pas
// figer un "pas de taux" pour le reste de la session, qui priverait alors
// le graphique Price History de son axe unifié pour de bon (repli
// automatique sur le double axe, voir renderPriceHistoryChart) là où une
// tentative ultérieure aurait pu réussir. Cela vaut aussi pour un REJET
// (réseau coupé : requestUrl(..., { throw: false }) ne s'épargne que les
// statuts HTTP, pas les erreurs de transport) — sans le .catch ci-dessous, la
// promesse rejetée restait mémorisée dans usdEurRateFetchPromise pour toute
// la session et tous les appelants (graphique Price History, bloc Market
// Trends de Home) la recevaient à chaque fois ; désormais un rejet se
// comporte comme un échec ordinaire : undefined, et la prochaine demande
// réessaie (corrigé le 2026-09-23, en ajoutant un 2e consommateur à ce taux).

export async function getUsdEurRate(this: MTGCollectionPlugin): Promise<UsdEurRate | undefined> {
	if (this.usdEurRateCache) return this.usdEurRateCache;
	if (!this.usdEurRateFetchPromise) {
		this.usdEurRateFetchPromise = fetchUsdEurRate()
			.then((rate) => {
				if (!rate) {
					this.usdEurRateFetchPromise = null;
					return undefined;
				}
				this.usdEurRateCache = rate;
				return rate;
			})
			.catch(() => {
				this.usdEurRateFetchPromise = null;
				return undefined;
			});
	}
	return this.usdEurRateFetchPromise;
}
