import { UsdEurRate, fetchUsdEurRate } from "../api/frankfurter";
import type MTGCollectionPlugin from "../plugin";

/* ---------------------------------------------------------------------------- */
/* USD/EUR exchange rate (frankfurter.dev), a single one per session */
/* (MTGCollectionPlugin). */
/* ---------------------------------------------------------------------------- */

// Loads (once per session) the USD/EUR rate from frankfurter.dev. Only writes
// the cache on a confirmed success — same logic as
// loadSymbology/loadCardKingdomPrices: a transient failure must not freeze a
// "no rate" for the rest of the session, which would then deprive the Price
// History chart of its unified axis for good (automatic fallback to the dual
// axis, see renderPriceHistoryChart) where a later attempt could have
// succeeded. This also holds for a REJECTION (network cut: requestUrl(..., {
// throw: false }) only spares HTTP statuses, not transport errors) — without
// the .catch below, the rejected promise stayed memorized in
// usdEurRateFetchPromise for the whole session and all callers (Price History
// chart, Home's Market Trends block) received it every time; now a rejection
// behaves like an ordinary failure: undefined, and the next request retries
// (fixed on 2026-09-23, when adding a 2nd consumer of this rate).

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
