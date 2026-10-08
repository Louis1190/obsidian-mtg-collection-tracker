import { requestUrl } from "obsidian";

/* -------------------------------------------------------------------------- */
/* frankfurter.dev — USD/EUR exchange rate, to unify the Y axis of the "Price */
/* History" chart (see buildYAxis/renderPriceHistoryChart, card-detail-fx.ts) */
/* when one series (Cardmarket, EUR) has to be compared with the other three */
/* (USD) on the same axis rather than on a second, separate axis. This plugin */
/* only tracks USD/EUR (see PriceCurrency, price.ts) — a single rate is */
/* enough, no need for the full currency catalog that frankfurter.dev exposes */
/* otherwise. */
/* -------------------------------------------------------------------------- */

// Public API, no key (checked live via curl), European Central Bank rates
// updated every other business day — enough for a DISPLAY conversion
// (aligning two curves on the same chart), never used for a real financial
// transaction.
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

const FRANKFURTER_HEADERS = {
	// Same identifier + contact as SCRYFALL_HEADERS (scryfall.ts) — consistency
	// across all of this plugin's APIs, not a requirement specific to
	// frankfurter.dev.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

// Body of /latest (`res.json` is `any`). `unknown`: the type of each value is checked just below.
interface FrankfurterLatestBody {
	rates?: { EUR?: unknown };
	date?: unknown;
}

export interface UsdEurRate {
	// How many EUR for 1 USD (e.g. 0.868) — direction fixed once and for all
	// here, convertUsdEur below handles both directions.
	usdToEur: number;
	date: string;
}

// undefined = failure (network, non-200 status, malformed response) — to be
// told apart by the caller from a valid rate; see getUsdEurRate (plugin.ts)
// for the cache policy (a transient failure is never cached, same logic as
// fetchCardKingdomPricelist/fetchManaPoolPricelist).
export async function fetchUsdEurRate(): Promise<UsdEurRate | undefined> {
	const res = await requestUrl({
		url: `${FRANKFURTER_BASE_URL}/latest?base=USD&symbols=EUR`,
		headers: FRANKFURTER_HEADERS,
		throw: false,
	});
	if (res.status !== 200) return undefined;
	const rate = (res.json as FrankfurterLatestBody | undefined)?.rates?.EUR;
	const date = (res.json as FrankfurterLatestBody | undefined)?.date;
	if (typeof rate !== "number" || typeof date !== "string") return undefined;
	return { usdToEur: rate, date };
}

// Applies a single "today" rate to an amount, whatever the actual date of
// the historical point being converted — frankfurter.dev does expose past
// rates (endpoint /v1/{date}), but fetching one per point of each curve
// would multiply the requests for a chart that remains a visual reference,
// not an accounting calculation. The resulting offset stays small: EUR/USD
// typically moves only a few % over the 30/365-day window this chart covers.
// Documented explicitly in the tooltip shown on the converted curve (see
// card-detail-fx.ts) rather than left silent.
export function convertUsdEur(amount: number, from: "usd" | "eur", to: "usd" | "eur", rate: UsdEurRate): number {
	if (from === to) return amount;
	return from === "usd" ? amount * rate.usdToEur : amount / rate.usdToEur;
}
