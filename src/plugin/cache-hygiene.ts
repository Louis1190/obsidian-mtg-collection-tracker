import { cacheConflictCopies } from "../core/conflict-copies";
import type MTGCollectionPlugin from "../plugin";
import { CARDMARKET_ID_CACHE_FILENAME } from "./cardbase-cache";
import { PRINTED_IMAGES_CACHE_FILENAME, PRINTED_NAMES_CACHE_FILENAME } from "./printed-names";
import {
	ALL_SETS_CACHE_FILENAME,
	ICON_CACHE_FILENAME,
	LEGALITIES_CACHE_FILENAME,
	PRINT_LANGUAGES_CACHE_FILENAME,
	SCRYFALL_IMMUTABLE_CACHE_FILENAME,
} from "./scryfall-cache";

/* -------------------------------------------------------------------------- */
/*  Housekeeping of the plugin's own folder (audit of 2026-11-15, lot 3).      */
/* -------------------------------------------------------------------------- */

// The files of the plugin's folder whose content is a CACHE, i.e. rebuilt from Scryfall when it is missing: a conflict
// copy of one of them holds nothing that matters. Named from the constants the caches are written under, so a new cache
// has to be added here on purpose. Never data.json (the user's collection) nor the sync-backups/ folder.
export const REGENERABLE_CACHE_FILES: ReadonlySet<string> = new Set([
	LEGALITIES_CACHE_FILENAME,
	SCRYFALL_IMMUTABLE_CACHE_FILENAME,
	ICON_CACHE_FILENAME,
	ALL_SETS_CACHE_FILENAME,
	PRINT_LANGUAGES_CACHE_FILENAME,
	CARDMARKET_ID_CACHE_FILENAME,
	PRINTED_NAMES_CACHE_FILENAME,
	PRINTED_IMAGES_CACHE_FILENAME,
]);

// Deletes the Syncthing conflict copies of the caches (core/conflict-copies.ts says why they pile up). Silent and never
// blocking: nothing to configure, nothing shown, any failure leaves the copy for a later start. Only direct children of
// the plugin's folder are looked at, and the deletion is permanent (these are hidden plugin files, not notes, so there is
// nothing for the trash to give back). Syncthing carries the deletion to the other devices. Returns how many were removed.

export async function cleanCacheConflictCopies(this: MTGCollectionPlugin): Promise<number> {
	const dir = this.manifest.dir;
	if (!dir) return 0;
	let removed = 0;
	try {
		const adapter = this.app.vault.adapter;
		const { files } = await adapter.list(dir);
		const prefix = `${dir}/`;
		// Direct children only: a path from the listing that is not "<dir>/<name>" with a plain name is never touched. Belt
		// and braces: the name test just below already refuses a path that has a folder in it (its origin would then read
		// "folder/legalities-cache.json", which is no cache), so this filter does not change what is deleted today; it keeps
		// holding if that test is ever loosened.
		const children = files.filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"));
		const names = new Set(cacheConflictCopies(children.map((f) => f.slice(prefix.length)), REGENERABLE_CACHE_FILES));
		for (const path of children) {
			if (!names.has(path.slice(prefix.length))) continue;
			try {
				await adapter.remove(path);
				removed++;
			} catch {
				// Left for the next start.
			}
		}
	} catch {
		// A folder that cannot be listed (a mobile quirk, a sync in progress): nothing to clean this time.
	}
	if (removed > 0) console.debug(`MTG Collection Tracker: removed ${removed} sync conflict cop${removed === 1 ? "y" : "ies"} of cache files.`);
	return removed;
}
