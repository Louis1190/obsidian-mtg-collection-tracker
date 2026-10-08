import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

/* -------------------------------------------------------------------------- */
/* requestUrl that never throws */
/* -------------------------------------------------------------------------- */
// `requestUrl({ throw: false })` only covers HTTP statuses (404, 429, 500…): a TRANSPORT error — offline, DNS, a
// corporate network's firewall or TLS inspection, captive portal — still makes the promise reject. The
// data-source fetchers (cardbase, Card Kingdom, Mana Pool) promise "a failure value, never an exception"
// (undefined or an empty Map: the interface has a branch for that, "—" or "No price history available yet.");
// without this, the rejected promise never reached that branch: the frame stayed on its loading dots, and for
// the Card Kingdom / Mana Pool pricelists the REJECTED promise stayed cached for the whole session.
// Returns null instead of the response when the request could not complete: the caller treats null like any
// other failure (the same path as a non-200 status).
export async function requestUrlOrNull(params: Omit<RequestUrlParam, "throw">): Promise<RequestUrlResponse | null> {
	try {
		return await requestUrl({ ...params, throw: false });
	} catch {
		return null;
	}
}
