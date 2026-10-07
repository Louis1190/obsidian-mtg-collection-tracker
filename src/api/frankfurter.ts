import { requestUrl } from "obsidian";

/* -------------------------------------------------------------------------- */
/*  frankfurter.dev — taux de change USD/EUR, pour unifier l'axe Y du          */
/*  graphique "Price History" (voir buildYAxis/renderPriceHistoryChart,        */
/*  card-detail-fx.ts) quand une série (Cardmarket, EUR) doit être comparée    */
/*  aux trois autres (USD) sur le même axe plutôt que sur un second axe        */
/*  séparé. Ce plugin ne suit que USD/EUR (voir PriceCurrency, price.ts) — un  */
/*  seul taux suffit, pas besoin du catalogue complet de devises que           */
/*  frankfurter.dev expose par ailleurs.                                       */
/* -------------------------------------------------------------------------- */

// API publique, sans clé (vérifié en direct via curl), taux de la Banque
// Centrale Européenne mis à jour un jour ouvré sur deux — suffisant pour une
// conversion d'AFFICHAGE (aligner deux courbes sur un même graphique),
// jamais utilisé pour une vraie transaction financière.
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

const FRANKFURTER_HEADERS = {
	// Même identifiant + contact que SCRYFALL_HEADERS (scryfall.ts) — cohérence
	// entre toutes les APIs de ce plugin, pas une exigence propre à frankfurter.dev.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

export interface UsdEurRate {
	// Combien d'EUR pour 1 USD (ex. 0.868) — sens fixé une bonne fois pour
	// toutes ici, convertUsdEur ci-dessous gère les deux directions.
	usdToEur: number;
	date: string;
}

// undefined = échec (réseau, statut non-200, réponse mal formée) — à
// distinguer par l'appelant d'un taux valide ; voir getUsdEurRate (plugin.ts)
// pour la politique de cache (un échec transitoire n'est jamais mis en
// cache, même logique que fetchCardKingdomPricelist/fetchManaPoolPricelist).
export async function fetchUsdEurRate(): Promise<UsdEurRate | undefined> {
	const res = await requestUrl({
		url: `${FRANKFURTER_BASE_URL}/latest?base=USD&symbols=EUR`,
		headers: FRANKFURTER_HEADERS,
		throw: false,
	});
	if (res.status !== 200) return undefined;
	const rate = res.json?.rates?.EUR;
	const date = res.json?.date;
	if (typeof rate !== "number" || typeof date !== "string") return undefined;
	return { usdToEur: rate, date };
}

// Applique un seul taux "aujourd'hui" à un montant, quelle que soit la date
// réelle du point historique converti — frankfurter.dev expose bien des taux
// passés (endpoint /v1/{date}), mais aller en chercher un par point de
// chaque courbe multiplierait les requêtes pour un graphique qui reste un
// repère visuel, pas un calcul comptable. Le décalage induit reste faible :
// EUR/USD ne bouge typiquement que de quelques % sur la fenêtre de 30/365
// jours couverte par ce graphique. Documenté explicitement dans l'infobulle
// affichée sur la courbe convertie (voir card-detail-fx.ts) plutôt que
// silencieux.
export function convertUsdEur(amount: number, from: "usd" | "eur", to: "usd" | "eur", rate: UsdEurRate): number {
	if (from === to) return amount;
	return from === "usd" ? amount * rate.usdToEur : amount / rate.usdToEur;
}
