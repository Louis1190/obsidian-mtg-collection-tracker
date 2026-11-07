import { SCRYFALL_HEADERS, requestScryfall, sleep } from "../api/scryfall";
import {
	PrintedNameSubject,
	displayImage,
	displayName,
	parsePrintedNameKey,
	printedImageFromBody,
	printedNameFromBody,
	printedNameKey,
	printedNameKeyOfHit,
	printedNameUrl,
} from "../core/printed-name";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  Names and pictures printed on copies in another language: cache +         */
/*  background lookup (core/printed-name.ts has the rules; written 2026-11-07) */
/* -------------------------------------------------------------------------- */

// printed-names-cache.json — the generic persisted map (see loadPersistedMapCache,
// scryfall-cache.ts): "tla:193:fr" -> "Blâme de pierre", or "" once Scryfall has said that print has
// no name of its own. A printing's name in a language never changes, so nothing expires.
export const PRINTED_NAMES_CACHE_FILENAME = "printed-names-cache.json";
// printed-images-cache.json — same key, the address of the print's `normal` picture, or "" when Scryfall has no REAL scan of it
// (a stand-in or nothing, see printedImageFromBody). It comes out of the very request that gives the name, so there is one
// lookup per print; a name already known from before this cache existed is looked up once more, and only when the setting
// "Card images" asks for printed pictures.
export const PRINTED_IMAGES_CACHE_FILENAME = "printed-images-cache.json";

// A copy whose name is unknown asks for it a moment later, all the misses of one render together.
const PRINTED_NAME_DEBOUNCE_MS = 400;
// After a failed request nothing more is asked for 30 s: offline or a refusing Scryfall is left alone,
// and the copies come back to the queue by themselves at a later render. Same rule as the neighbour
// prefetch of the card text (CARD_TEXT_PREFETCH_PAUSE_MS, scryfall-cache.ts).
const PRINTED_NAME_PAUSE_MS = 30_000;
// Scryfall's rules ask for bulk data when many names or card images are looked up quickly, and there is no bulk file small enough for a
// phone. What can be done here is to stay well under the hard limit (10 a second for this endpoint): a backfill for a large number of copies
// is a one-time background job, one request every half second (the strictest tier, 2 a second, the same pace as the search endpoints), then
// remembered for good. The copies on screen come first (render order).
const PRINTED_NAME_GAP_MS = 500;
// While a long run goes on (a few hundred copies, one request each), the views redraw every so
// many names so they show up as they arrive rather than all at the end.
const PRINTED_NAME_REFRESH_EVERY = 40;

// The name printed on a copy, for display and for search: undefined for a copy that is not in
// another language, whose print has no name of its own, or whose name is not known YET (then it is
// queued, fetched in the background and the views redraw when it arrives). Asked for only where a name is
// needed: by the rows and the sorting when "Card names" is on "printed" (cardDisplayName), and by a text
// search for each card it checks, so a search finds the printed name of a copy marked "French" even with
// the setting on English; with the setting on English and no search typed, nothing is looked up.
export function getPrintedName(this: MTGCollectionPlugin, card: Omit<PrintedNameSubject, "name">): string | undefined {
	const key = printedNameKey(card);
	if (!key) return undefined;
	const known = this.printedNamesCache.get(key);
	if (known !== undefined) return known || undefined;
	this.queuePrintedName(key);
	return undefined;
}

// The picture a copy is shown with, following the "Card images" setting: the print in the copy's language when Scryfall has a
// real scan of it, the copy's own (English) picture otherwise — also while the address is not known yet (the lookup is queued
// and the views redraw when it arrives). Only asked for in printed mode: nobody else pays for it.
export function cardDisplayImage(
	this: MTGCollectionPlugin,
	card: { imageUrl: string; setCode?: string; collectorNumber?: string; language?: string }
): string {
	const mode = this.settings.cardImageMode;
	if (mode !== "printed") return card.imageUrl;
	const key = printedNameKey(card);
	if (!key) return card.imageUrl;
	const known = this.printedImagesCache.get(key);
	if (known === undefined) this.queuePrintedName(key);
	return displayImage(card.imageUrl, mode, known);
}

// The name a copy is shown with, following the "Card names" setting.
export function cardDisplayName(this: MTGCollectionPlugin, card: PrintedNameSubject): string {
	const mode = this.settings.cardNameMode;
	return displayName(card, mode, mode === "printed" ? this.getPrintedName(card) : undefined);
}

// A card found by its name in another language (see resolveEnglishPrints, scryfall.ts) arrives with
// its `lang` and `printed_name`: remember them, so a copy added that way never needs a request.
export function rememberPrintedName(
	this: MTGCollectionPlugin,
	hit: { set: string; collector_number: string; lang?: string; printed_name?: string }
): void {
	const key = printedNameKeyOfHit(hit);
	const name = hit.printed_name?.trim();
	if (!key || !name || this.printedNamesCache.get(key) === name) return;
	this.printedNamesCache.set(key, name);
	this.printedNamesVersion++;
	this.scheduleMapCachePersist(PRINTED_NAMES_CACHE_FILENAME, this.printedNamesCache);
}

// Something that shows a name outside the views' own render (an open card detail window) asks to be told when names
// were learned; returns the function that stops listening (call it when the window closes).
export function onPrintedNamesLearned(this: MTGCollectionPlugin, listener: () => void): () => void {
	this.printedNameListeners.add(listener);
	return () => void this.printedNameListeners.delete(listener);
}

// New names are in the cache: the views redraw (their rows read the name at render time) and the listeners update
// what they show in place.
function announceLearnedNames(plugin: MTGCollectionPlugin): void {
	// Each one on its own: a view that fails to redraw must not keep a detail window from updating, and the other way round.
	const attempt = (fn: () => void) => {
		try {
			fn();
		} catch (error) {
			console.error("MTG Collection Tracker: could not show a printed name", error);
		}
	};
	attempt(() => plugin.refreshOpenViews());
	[...plugin.printedNameListeners].forEach((listener) => attempt(listener));
}

// The plugin is being disabled: nothing more is asked for (the run in progress stops after its current request) and nothing new is queued.
export function stopPrintedNameLookups(this: MTGCollectionPlugin): void {
	if (this.printedNameTimer !== undefined) window.clearTimeout(this.printedNameTimer);
	this.printedNameTimer = undefined;
	this.printedNameQueue.clear();
	this.printedNamePausedUntil = Number.POSITIVE_INFINITY;
	this.printedNameListeners.clear();
}

export function queuePrintedName(this: MTGCollectionPlugin, key: string): void {
	if (this.printedNameQueue.has(key) || this.printedNameInFlight === key || performance.now() < this.printedNamePausedUntil) return;
	this.printedNameQueue.add(key);
	if (this.printedNameTimer !== undefined) return;
	this.printedNameTimer = window.setTimeout(() => {
		this.printedNameTimer = undefined;
		void this.drainPrintedNames();
	}, PRINTED_NAME_DEBOUNCE_MS);
}

// One request per (printing, language), one after the other through requestScryfall's pacing:
// GET /cards/{set}/{number}/{lang}, which is not one of the 2-per-second endpoints. A 404 is a
// confirmed "no such print in that language" and is remembered; any other failure stops the run
// (nothing is remembered for it) and pauses it.
export async function drainPrintedNames(this: MTGCollectionPlugin): Promise<void> {
	if (this.printedNamesDraining) return;
	this.printedNamesDraining = true;
	let learned = 0;
	let sinceRefresh = 0;
	try {
		while (this.printedNameQueue.size > 0) {
			const key = this.printedNameQueue.values().next().value as string;
			this.printedNameQueue.delete(key);
			if (this.printedNamesCache.has(key) && this.printedImagesCache.has(key)) continue;
			const parts = parsePrintedNameKey(key);
			if (!parts) {
				this.printedNamesCache.set(key, "");
				this.printedImagesCache.set(key, "");
				continue;
			}
			// The languages a printing really exists in are already known for every printing whose
			// language picker was opened (printLanguagesCache): no request for one it was not printed in.
			const printedIn = this.printLanguagesCache.get(`${parts.set}:${parts.collectorNumber}`);
			if (printedIn && !printedIn.includes(parts.lang)) {
				this.printedNamesCache.set(key, "");
				this.printedImagesCache.set(key, "");
				continue;
			}
			let status: number;
			let body: unknown;
			this.printedNameInFlight = key;
			try {
				const res = await requestScryfall({ url: printedNameUrl(parts), headers: SCRYFALL_HEADERS, throw: false });
				status = res.status;
				body = res.json;
			} catch {
				status = 0;
			}
			this.printedNameInFlight = null;
			if (status === 200) {
				const name = printedNameFromBody(body);
				const image = printedImageFromBody(body);
				// a name seeded from the search hit is not overwritten by an empty one
				if (name || !this.printedNamesCache.has(key)) this.printedNamesCache.set(key, name);
				this.printedImagesCache.set(key, image);
				if (name || image) {
					learned++;
					sinceRefresh++;
					this.printedNamesVersion++;
				}
			} else if (status === 404) {
				this.printedNamesCache.set(key, "");
				this.printedImagesCache.set(key, "");
			} else {
				this.printedNamePausedUntil = performance.now() + PRINTED_NAME_PAUSE_MS;
				this.printedNameQueue.clear();
				break;
			}
			this.scheduleMapCachePersist(PRINTED_NAMES_CACHE_FILENAME, this.printedNamesCache);
			this.scheduleMapCachePersist(PRINTED_IMAGES_CACHE_FILENAME, this.printedImagesCache);
			if (sinceRefresh >= PRINTED_NAME_REFRESH_EVERY) {
				sinceRefresh = 0;
				announceLearnedNames(this);
			}
			// A request was made: leave Scryfall a breather before the next one.
			if (this.printedNameQueue.size > 0) await sleep(PRINTED_NAME_GAP_MS);
		}
	} finally {
		this.printedNamesDraining = false;
		this.scheduleMapCachePersist(PRINTED_NAMES_CACHE_FILENAME, this.printedNamesCache);
		this.scheduleMapCachePersist(PRINTED_IMAGES_CACHE_FILENAME, this.printedImagesCache);
		if (learned > 0 && sinceRefresh > 0) announceLearnedNames(this);
	}
}
