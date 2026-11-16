// What a cache keyed by Scryfall id may forget, and the rule to know it.
//
// The legalities cache had no way to forget: every card whose legalities were ever read stayed in the file for good. On a
// real 4,900-card collection it held 20,363 entries (11.4 MB, re-read at every start and re-written, whole, at every
// refresh), 15,450 of them for cards that were in no list, wantlist or deck and whose data was older than the TTL (found by
// the audit of 2026-11-15, docs/history/code-audit-2026-11-15.md). The rule that was kept after reading how the entries are
// used (plugin/scryfall-cache.ts, isLegalitiesFresh): an expired entry of a card the person HOLDS is still worth its place,
// because every display path serves it at once while the refresh runs; an entry nobody holds is only worth it while fresh.

interface CardRow {
	scryfallId?: string;
}

// The part of the settings that says which cards the person holds.
export interface HeldCards {
	collection?: CardRow[];
	wantlist?: CardRow[];
	decks?: { cards?: CardRow[] }[];
}

// Scryfall ids of every card held in a list, a wantlist or a deck (a row with no id is ignored).
export function scryfallIdsInUse(settings: HeldCards): Set<string> {
	const ids = new Set<string>();
	const add = (rows: CardRow[] | undefined) => {
		for (const row of rows ?? []) if (row.scryfallId) ids.add(row.scryfallId);
	};
	add(settings.collection);
	add(settings.wantlist);
	for (const deck of settings.decks ?? []) add(deck.cards);
	return ids;
}

// Removes from `entries` (and from `fetchedAt`, which is kept in step with it) every entry of a card that is NOT held and
// whose data is not fresh: older than `ttlMs`, or with no date at all (it cannot be judged, and the file never keeps such
// an entry). "Fresh" is the cache's own test, strictly younger than the TTL. Returns how many were removed.
export function pruneUnusedExpired(
	entries: Map<string, unknown>,
	fetchedAt: Map<string, number>,
	used: ReadonlySet<string>,
	now: number,
	ttlMs: number
): number {
	let removed = 0;
	for (const id of Array.from(entries.keys())) {
		if (used.has(id)) continue;
		const at = fetchedAt.get(id);
		if (at !== undefined && now - at < ttlMs) continue;
		entries.delete(id);
		fetchedAt.delete(id);
		removed++;
	}
	return removed;
}
