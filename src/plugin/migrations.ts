import {
	CollectionCard,
} from "../core/card-model";
import {
	getArtCropUrl,
	fetchScryfallCollection,
	buildCardTextInfo,
} from "../api/scryfall";
import {
	CollectionList,
	DeckCard,
	genId,
	VIEW_TYPE_MTG_COLLECTION,
} from "../core/data-model";
import { MTGCollectionView } from "../view";
import type MTGCollectionPlugin from "../plugin";

// Rows as an EARLIER version of the plugin wrote them: the fields that a migration adds or converts may be
// missing (hence Partial), and some no longer exist in the current types (foilCount, foil, category
// "commander"). Rather than `any`: a typo in a field name remains a compile error.
type LegacyCard = Partial<CollectionCard> & { foilCount?: number; foil?: boolean };
type LegacyDeckCard = Partial<Omit<DeckCard, "category">> & { category?: DeckCard["category"] | "commander" };

/* -------------------------------------------------------------------------- */
/*  One-shot data migrations/backfills, run once via runSettingsMigrations()
    (plugin.ts) or onload() -- rarely touched outside adding a new one.
    Split out of plugin.ts on 2026-09-10.  */
/* -------------------------------------------------------------------------- */

export function migrateListDateCreated(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.lists.forEach((list, i) => {
		if (list.dateCreated === undefined) {
			list.dateCreated = Date.now() - (this.settings.lists.length - i) * 1000;
			changed = true;
		}
	});
	if (changed) void this.saveSettings();
}

// Same principle as migrateListDateCreated, for decks.

export function migrateDeckDateCreated(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.decks.forEach((deck, i) => {
		if (deck.dateCreated === undefined) {
			deck.dateCreated = Date.now() - (this.settings.decks.length - i) * 1000;
			changed = true;
		}
	});
	if (changed) void this.saveSettings();
}

// saveSettings() is called on each small interaction (incrementing a
// quantity, ticking foil...) — on a big collection, rewriting the whole
// JSON to disk on every click can become noticeable. We therefore group
// close calls into a single deferred write of short duration;
// flushPendingSave() guarantees that an isolated call (or the plugin
// closing) never waits indefinitely.

// Incremented on every call to saveSettings() (hence on every mutation,
// independently of the debounce of the disk write itself): serves as a
// marker for MTGCollectionView, which caches the result of a list's
// sort/grouping (costly on a big collection) and must know when to
// invalidate it — a change in this counter means "the data has moved since
// the last computation", independently of a change of
// filter/sort/grouping.

// Ids of CollectionCards added this session via addCardToCollection/importCsv (see these
// methods) — never persisted (like legalitiesCache above), so it empties naturally at every
// restart of Obsidian. A Set (not a Map per list) is enough: each CollectionCard already
// carries its own listId, so the "per list" filtering is done for free everywhere a specific
// list is already displayed. The insertion order of a JS Set is guaranteed stable, which
// serves to sort the pinned "Recently Added" group from most recent to oldest without needing
// a separate timestamp. Deliberately NOT updated by
// copyCollectionCardToList/moveCollectionCardToList/copyWantlistCardToList/moveWantlistCardToCollectionNoSave/copyList
// — these methods move or duplicate cards already existing in the collection, which is not a
// "brand-new" addition in the sense of this feature.

// Same principle as recentlyAddedCollectionCardIds above, on the wantlist
// side: fed only by addCardToWantlist/importWantlistCsv, never by
// copyWantlistCardToList/moveWantlistCardToCollectionNoSave
// (move/duplication, not a brand-new addition).


export function migrateFoilSplit(this: MTGCollectionPlugin) {
	const needsMigration = this.settings.collection.some(
		(c) => (c as LegacyCard).foilCount !== undefined || !c.id
	);
	if (!needsMigration) return;

	const migrated: CollectionCard[] = [];
	(this.settings.collection as LegacyCard[]).forEach((c) => {
		const now = Date.now();
		const base = {
			scryfallId: c.scryfallId,
			name: c.name,
			setCode: c.setCode,
			setName: c.setName,
			collectorNumber: c.collectorNumber,
			rarity: c.rarity,
			manaCost: c.manaCost,
			manaValue: c.manaValue ?? 0,
			typeLine: c.typeLine,
			artist: c.artist ?? "",
			colors: c.colors ?? [],
			keywords: c.keywords ?? [],
			releasedAt: c.releasedAt ?? "",
			imageUrl: c.imageUrl,
			artCropUrl: c.artCropUrl ?? c.imageUrl ?? "",
			priceUsd: c.priceUsd,
			priceUsdFoil: c.priceUsdFoil ?? "",
			priceEur: c.priceEur ?? "",
			priceEurFoil: c.priceEurFoil ?? "",
			priceUsdEtched: c.priceUsdEtched ?? "",
			priceEurEtched: c.priceEurEtched ?? "",
			listId: c.listId,
			language: c.language ?? "en",
			condition: c.condition ?? "",
			dateAdded: c.dateAdded ?? now,
			dateModified: c.dateModified ?? now,
			borderColor: c.borderColor,
			frame: c.frame,
			frameEffects: c.frameEffects,
			oracleText: c.oracleText,
		};
		if (c.foilCount !== undefined) {
			if ((c.count ?? 0) > 0 || c.foilCount === 0) {
				migrated.push({ ...base, id: genId(), count: c.count ?? 0, finish: "regular" } as CollectionCard);
			}
			if (c.foilCount > 0) {
				migrated.push({ ...base, id: genId(), count: c.foilCount, finish: "foiled" } as CollectionCard);
			}
		} else {
			migrated.push({
				...base,
				id: c.id ?? genId(),
				count: c.count ?? 0,
				finish: c.finish ?? (c.foil ? "foiled" : "regular"),
			} as CollectionCard);
		}
	});
	this.settings.collection = migrated;
	void this.saveSettings();
}

// "foil" (boolean) becomes "finish" (Regular/Foiled/Etched/Proxy): Etched
// and Proxy are new values that no existing card can already have, so the
// conversion is a simple switch foil ? "foiled" : "regular". Applies to the
// collection AND the wantlist (same field in
// Guarantees that exactly one "Inbox" list (isInbox: true, see
// CollectionList) always exists — called from runSettingsMigrations, hence
// both at normal load and after a backup restore (an older backup file
// never has this flag, just like a very first installation). No-op as soon
// as a list already carries it, whichever — this flag is set nowhere else
// in the code, so once created it can only be duplicated by a manual edit
// of data.json, not handled here. unshift (not push): purely cosmetic,
// places the list at the head of the raw array — the real visual pinning
// comes from renderListGrid, which extracts it and displays it separately,
// independently of its position here.

export function ensureInboxList(this: MTGCollectionPlugin) {
	if (this.settings.lists.some((l) => l.isInbox)) return;
	this.settings.lists.unshift({
		id: genId(),
		name: "Inbox",
		dateCreated: Date.now(),
		isInbox: true,
	});
}

// both, migrateFoilSplit only handles the collection).

export function migrateFoilToFinish(this: MTGCollectionPlugin) {
	let changed = false;
	const convert = (c: LegacyCard) => {
		if (c.finish !== undefined) return;
		c.finish = c.foil ? "foiled" : "regular";
		delete c.foil;
		if (c.priceUsdEtched === undefined) c.priceUsdEtched = "";
		if (c.priceEurEtched === undefined) c.priceEurEtched = "";
		changed = true;
	};
	(this.settings.collection as LegacyCard[]).forEach(convert);
	(this.settings.wantlist as LegacyCard[]).forEach(convert);
	if (changed) void this.saveSettings();
}


export function migrateDamagedCondition(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.collection.forEach((c) => {
		if (c.condition === "DMG") {
			c.condition = "PO";
			changed = true;
		}
	});
	if (changed) void this.saveSettings();
}


export function migrateDeckCommanderCategory(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.decks.forEach((deck) => {
		(deck.cards as LegacyDeckCard[]).forEach((c) => {
			if (c.category === "commander") {
				c.category = undefined;
				c.deckFunctionOverride = "Commander";
				changed = true;
			}
		});
	});
	if (changed) void this.saveSettings();
}

// One-off catch-up of borderColor/frame/frameEffects ("border:" filter, card-search.ts) for every
// entry created before this feature — unlike legalitiesCache/bulkFetchLegalities (see their comment
// in src/plugin/scryfall-cache.ts), this data is NOT a separate cache with a TTL: it is persisted
// directly on each CollectionCard/WantlistCard/DeckCard (see their comment in
// types.ts/data-model.ts), because a printed card's border/frame never changes — once caught up for
// a given scryfallId, never any need to ask for it again. A new card already gets it directly when
// added (addCardToCollection, addCardToWantlist, addCardToDeck,
// changeCollectionCardPrinting/changeWantlistCardPrinting, importCsv/importWantlistCsv) — this
// method therefore only catches up older entries, or ones imported from a data.json predating this
// feature. Called once at startup (see onload), WITHOUT an hourly interval unlike
// maybeAutoRefreshLegalities: once the whole collection is covered, targets below is systematically
// empty and the call becomes an immediate no-op for the rest of the plugin's life — no need to
// periodically re-check data that never goes stale.

export async function backfillBorderData(this: MTGCollectionPlugin): Promise<void> {
	// scryfallId → ALL the entries that share it (not just one): a same
	// printing can appear several times at once (two collection rows in
	// different conditions, a deck AND the collection, etc.), and each must
	// receive the data once its batch is resolved.
	const targets = new Map<string, { borderColor?: string; frame?: string; frameEffects?: string[] }[]>();
	const register = (id: string, entry: { borderColor?: string; frame?: string; frameEffects?: string[] }) => {
		if (!id || entry.borderColor !== undefined) return;
		const list = targets.get(id);
		if (list) list.push(entry);
		else targets.set(id, [entry]);
	};
	this.settings.collection.forEach((c) => register(c.scryfallId, c));
	this.settings.wantlist.forEach((c) => register(c.scryfallId, c));
	this.settings.decks.forEach((d) => d.cards.forEach((c) => register(c.scryfallId, c)));

	const missingIds = Array.from(targets.keys());
	if (missingIds.length === 0) return;

	// Same onChunkResolved mechanism as bulkFetchLegalities (see src/plugin/scryfall-cache.ts) —
	// resolves each batch of 75 as soon as it comes back, not only the very last one. Less
	// critical here than an "instant" keyboard response since nothing waits synchronously for
	// this data, but still applies results progressively rather than waiting for the very end of
	// a 10k-card collection before the first byte written.
	let changed = false;
	await fetchScryfallCollection(missingIds, undefined, (chunkResults) => {
		chunkResults.forEach((card, id) => {
			const entries = targets.get(id);
			if (!entries) return;
			entries.forEach((entry) => {
				entry.borderColor = card.border_color ?? "";
				entry.frame = card.frame ?? "";
				entry.frameEffects = card.frame_effects ?? [];
			});
			changed = true;
		});
	});

	if (!changed) return;
	void this.saveSettings();
	// Same gesture as maybeAutoRefreshLegalities/maybeAutoRefreshPrices: a
	// view already open (restored by Obsidian at startup) must reflect the
	// freshly caught-up data.
	this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
		if (leaf.view instanceof MTGCollectionView) leaf.view.render();
	});
}

// One-off catch-up of oracleText ("oracle:" filter, card-search.ts), same
// design as backfillBorderData just above — intrinsic IMMUTABLE data (a
// printing's rules text never changes, barring errata), so a single
// catch-up is enough, no TTL like the legalities. A separate function
// rather than merged into backfillBorderData: an entry already caught up
// by an earlier plugin version (before this field was added) already has
// borderColor !== undefined, so would never be re-recorded if this
// function's "missing" filter reused the same test — each immutable field
// added after the fact needs its own pass. A new card already gets it
// directly when added (same 14 sites as borderColor/frame/frameEffects —
// see their own comment); this method therefore only catches up older
// entries.

export async function backfillOracleTextData(this: MTGCollectionPlugin): Promise<void> {
	const targets = new Map<string, { oracleText?: string }[]>();
	const register = (id: string, entry: { oracleText?: string }) => {
		if (!id || entry.oracleText !== undefined) return;
		const list = targets.get(id);
		if (list) list.push(entry);
		else targets.set(id, [entry]);
	};
	this.settings.collection.forEach((c) => register(c.scryfallId, c));
	this.settings.wantlist.forEach((c) => register(c.scryfallId, c));
	this.settings.decks.forEach((d) => d.cards.forEach((c) => register(c.scryfallId, c)));

	const missingIds = Array.from(targets.keys());
	if (missingIds.length === 0) return;

	// Same onChunkResolved mechanism as backfillBorderData
	// above/bulkFetchLegalities (src/plugin/scryfall-cache.ts).
	let changed = false;
	await fetchScryfallCollection(missingIds, undefined, (chunkResults) => {
		chunkResults.forEach((card, id) => {
			const entries = targets.get(id);
			if (!entries) return;
			const oracleText = buildCardTextInfo(card).oracleText;
			entries.forEach((entry) => {
				entry.oracleText = oracleText;
			});
			changed = true;
		});
	});

	if (!changed) return;
	void this.saveSettings();
	this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
		if (leaf.view instanceof MTGCollectionView) leaf.view.render();
	});
}

// One-off catch-up of the price (see DeckCard.priceUsd/etc.,
// data-model.ts) for decks created before this feature — scoped to decks
// ONLY, unlike backfillBorderData/backfillOracleTextData just above: a
// CollectionCard/WantlistCard always has this price from its creation
// (non-optional field, never absent), only DeckCard needs it. Same
// onChunkResolved mechanism as its two neighbors — but unlike them, the
// price is NOT immutable: this catch-up only covers "never yet caught up
// even once" (like border/oracleText), continuous freshness is ensured
// separately by refreshAllPrices/maybeAutoRefreshPrices (which already
// include decks, see their own comment) — a deck already caught up once
// never comes back through here, but stays kept up to date by that
// mechanism.

export async function backfillDeckCardPrices(this: MTGCollectionPlugin): Promise<void> {
	interface PriceTarget {
		priceUsd?: string;
		priceUsdFoil?: string;
		priceEur?: string;
		priceEurFoil?: string;
		priceUsdEtched?: string;
		priceEurEtched?: string;
	}
	const targets = new Map<string, PriceTarget[]>();
	const register = (id: string, entry: PriceTarget) => {
		if (!id || entry.priceUsd !== undefined) return;
		const list = targets.get(id);
		if (list) list.push(entry);
		else targets.set(id, [entry]);
	};
	this.settings.decks.forEach((d) => d.cards.forEach((c) => register(c.scryfallId, c)));

	const missingIds = Array.from(targets.keys());
	if (missingIds.length === 0) return;

	let changed = false;
	await fetchScryfallCollection(missingIds, undefined, (chunkResults) => {
		chunkResults.forEach((card, id) => {
			const entries = targets.get(id);
			if (!entries) return;
			entries.forEach((entry) => {
				entry.priceUsd = card.prices?.usd ?? "";
				entry.priceUsdFoil = card.prices?.usd_foil ?? "";
				entry.priceEur = card.prices?.eur ?? "";
				entry.priceEurFoil = card.prices?.eur_foil ?? "";
				entry.priceUsdEtched = card.prices?.usd_etched ?? "";
				entry.priceEurEtched = card.prices?.eur_etched ?? "";
			});
			changed = true;
		});
	});

	if (!changed) return;
	void this.saveSettings();
	this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
		if (leaf.view instanceof MTGCollectionView) leaf.view.render();
	});
}

// Old versions of the plugin automatically grouped by set. We convert these
// groupings once and for all into real "Lists" named after the set, so that
// existing data stays visible.

export function migrateCollectionToLists(this: MTGCollectionPlugin) {
	const orphans = this.settings.collection.filter((c) => !c.listId);
	if (orphans.length === 0) return;

	const bySet = new Map<string, CollectionList>();
	orphans.forEach((card) => {
		let list = bySet.get(card.setCode);
		if (!list) {
			list =
				this.settings.lists.find((l) => l.name === card.setName) ??
				this.createListSilent(card.setName || card.setCode || "Unsorted");
			bySet.set(card.setCode, list);
		}
		card.listId = list.id;
	});
	void this.saveSettings();
}


export async function migrateEnrichMetadata(this: MTGCollectionPlugin) {
	const missing = this.settings.collection.filter((c) => !c.artist && c.scryfallId);
	if (missing.length === 0) return;

	const uniqueIds = Array.from(new Set(missing.map((c) => c.scryfallId)));
	const enrichMap = await fetchScryfallCollection(uniqueIds);
	if (enrichMap.size === 0) return;

	missing.forEach((card) => {
		const scry = enrichMap.get(card.scryfallId);
		if (!scry) return;
		card.artist = scry.artist ?? "";
		card.colors = scry.colors ?? [];
		card.manaValue = scry.cmc ?? 0;
		card.releasedAt = scry.released_at ?? "";
	});
	await this.saveSettings();
}

// Fetches the real artwork alone (art_crop) and the keyword abilities
// (keywords) for cards that don't have them yet (created before these
// fields were introduced).

export async function migrateArtCropUrls(this: MTGCollectionPlugin) {
	const missing = this.settings.collection.filter(
		(c) =>
			c.scryfallId &&
			(!c.artCropUrl ||
				c.artCropUrl === c.imageUrl ||
				c.keywords === undefined ||
				c.priceUsdFoil === undefined)
	);
	if (missing.length === 0) return;

	const uniqueIds = Array.from(new Set(missing.map((c) => c.scryfallId)));
	const enrichMap = await fetchScryfallCollection(uniqueIds);
	if (enrichMap.size === 0) return;

	missing.forEach((card) => {
		const scry = enrichMap.get(card.scryfallId);
		if (!scry) return;
		card.artCropUrl = getArtCropUrl(scry);
		card.keywords = scry.keywords ?? [];
		card.priceUsdFoil = scry.prices?.usd_foil ?? "";
		card.priceEur = scry.prices?.eur ?? "";
		card.priceEurFoil = scry.prices?.eur_foil ?? "";
		card.priceUsdEtched = scry.prices?.usd_etched ?? "";
		card.priceEurEtched = scry.prices?.eur_etched ?? "";
	});
	await this.saveSettings();
}

// Fills in deck cards created before the introduction of sorting/grouping
// with safe default values (before the enrichment via Scryfall).

export function migrateDeckCardDefaults(this: MTGCollectionPlugin) {
	let changed = false;
	const now = Date.now();
	this.settings.decks.forEach((deck) => {
		(deck.cards as LegacyDeckCard[]).forEach((c) => {
			if (c.dateAdded === undefined) {
				c.dateAdded = now;
				changed = true;
			}
			if (c.dateModified === undefined) {
				c.dateModified = now;
				changed = true;
			}
			if (c.manaValue === undefined) {
				c.manaValue = 0;
				changed = true;
			}
			if (c.artist === undefined) {
				c.artist = "";
				changed = true;
			}
			if (c.colors === undefined) {
				c.colors = [];
				changed = true;
			}
			if (c.setName === undefined) {
				c.setName = "";
				changed = true;
			}
			if (c.artCropUrl === undefined) {
				c.artCropUrl = c.imageUrl ?? "";
				changed = true;
			}
			if (c.keywords === undefined) {
				c.keywords = [];
				changed = true;
			}
		});
	});
	if (changed) void this.saveSettings();
}

// Fetches the artist, colors, mana value, artwork alone and keyword
// abilities missing for existing deck cards, in a handful of grouped
// requests.

export async function migrateEnrichDeckMetadata(this: MTGCollectionPlugin) {
	const allDeckCards = this.settings.decks.flatMap((d) => d.cards);
	const missing = allDeckCards.filter(
		(c) =>
			c.scryfallId &&
			(!c.artist ||
				!c.artCropUrl ||
				c.artCropUrl === c.imageUrl ||
				c.keywords === undefined)
	);
	if (missing.length === 0) return;

	const uniqueIds = Array.from(new Set(missing.map((c) => c.scryfallId)));
	const enrichMap = await fetchScryfallCollection(uniqueIds);
	if (enrichMap.size === 0) return;

	missing.forEach((card) => {
		const scry = enrichMap.get(card.scryfallId);
		if (!scry) return;
		card.artist = scry.artist ?? "";
		card.colors = scry.colors ?? [];
		card.manaValue = scry.cmc ?? 0;
		card.artCropUrl = getArtCropUrl(scry);
		card.keywords = scry.keywords ?? [];
		if (!card.setName) card.setName = scry.set_name ?? "";
	});
	await this.saveSettings();
}

