import { WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VIEW_TYPE_MTG_COLLECTION,
} from "../core/data-model";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  Plugin lifecycle: activateView, settings load/save, backup/restore.
    Split out of plugin.ts on 2026-09-10 (onload/onunload themselves stay in
    plugin.ts as the literal Obsidian entry point).  */
/* -------------------------------------------------------------------------- */

export const SAVE_DEBOUNCE_MS = 400;
export async function activateView(this: MTGCollectionPlugin) {
	const { workspace } = this.app;
	let leaf: WorkspaceLeaf | null = null;
	const existing = workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION);

	// An already existing tab may have ended up in a sidebar (left/right)
	// instead of the main workspace — observed on iOS/Android: the view
	// appeared stuck in the right-hand side drawer (a WorkspaceMobileDrawer on
	// mobile), limited to ~50% of the screen width, whereas on desktop it's a
	// normal full-screen tab. getLeaf("tab") does guarantee a new tab "within
	// the root split" (Obsidian doc below), but that only applies to CREATION
	// — an already existing tab, found via getLeavesOfType, was simply
	// revealed where it already was, even once misplaced in
	// rightSplit/leftSplit (an imperfect mobile session restore, or an
	// accidental move). We therefore check its root and recreate it in the
	// main workspace if necessary, rather than reveal it as is.
	if (existing.length > 0 && existing[0].getRoot() === workspace.rootSplit) {
		leaf = existing[0];
	} else {
		if (existing.length > 0) existing[0].detach();
		// Tab in the main workspace rather than in the sidebar: the grid needs
		// width to display properly.
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_MTG_COLLECTION, active: true });
	}

	if (leaf) void workspace.revealLeaf(leaf);
}


export async function loadSettings(this: MTGCollectionPlugin) {
	// Read via settings-sync.ts (and not loadData()): we need the raw text of the
	// file and its signature to be able to merge later with a version coming from
	// another device instead of overwriting it.
	this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.readSettingsFromDisk());
	// Sort, view mode, collapsed menu…: specific to this device, never synchronized (core/device-settings.ts).
	this.loadDeviceLocalSettings();
	await this.runSettingsMigrations();
	this.markSettingsLoaded();
}

// The 3 catch-ups that query Scryfall (migrateEnrich*/migrateArtCropUrls) run INSIDE
// onload(): fetchScryfallCollection doesn't catch transport errors (throw:false only
// covers HTTP statuses), so offline, behind a TLS-inspecting firewall
// (SSLHandshakeException observed on the Android emulator) or on a captive portal,
// the exception bubbled up to onload() and the whole plugin failed to load ("Plugin
// failure") — although a single card with no artist is enough to trigger the request
// at EVERY startup. This data is only an enrichment: we swallow the failure, and
// since each catch-up's "missing" predicate is always true, it will retry by itself
// at the next startup.
async function tolerateNetworkFailure(label: string, run: () => Promise<void>) {
	try {
		await run();
	} catch (e) {
		console.warn(`MTG Collection Tracker: startup catch-up "${label}" skipped (network unavailable?), will retry at the next start.`, e);
	}
}

// Extracted from loadSettings() to be reused also by restoreBackup()
// below: a backup file may come from an older version of the plugin
// (different data structure), so restoring must go through the same chain
// of migrations as a normal load at startup rather than blindly trust the
// file.

export async function runSettingsMigrations(this: MTGCollectionPlugin) {
	this.ensureInboxList();
	this.migrateFoilSplit();
	this.migrateFoilToFinish();
	this.migrateDamagedCondition();
	this.migrateDeckCommanderCategory();
	this.migrateCollectionToLists();
	this.migrateListDateCreated();
	this.migrateDeckDateCreated();
	await tolerateNetworkFailure("collection metadata", () => this.migrateEnrichMetadata());
	await tolerateNetworkFailure("collection art crops", () => this.migrateArtCropUrls());
	this.migrateDeckCardDefaults();
	await tolerateNetworkFailure("deck metadata", () => this.migrateEnrichDeckMetadata());
}

// Lists created before the introduction of the "by creation date" sort
// don't have this field. We fill it in using their current order in the
// array as a reference point (JS arrays preserve insertion order as long
// as they aren't explicitly reordered): the first of the list gets the
// oldest timestamp, the last the most recent.

export async function saveSettings(this: MTGCollectionPlugin) {
	this.dataVersion++;
	// The cache is invalidated immediately (lazy recomputation at next access,
	// not here): simple and safe, and the recomputation itself stays fast even
	// on a big collection (see getDistinctArtists). The in-memory state
	// (this.settings) is already up to date at this instant — only the disk
	// write is deferred, so everything reading this.settings elsewhere
	// (render(), etc.) sees the mutation right away despite the debounce.
	this.cachedArtists = null;
	this.cachedSets = null;
	// Display settings go into the device's storage, not into data.json.
	this.saveDeviceLocalSettings();
	// And what changed must also go to GitHub, if enabled.
	this.markGithubDirty();
	if (this.pendingSaveTimer !== null) window.clearTimeout(this.pendingSaveTimer);
	this.pendingSaveTimer = window.setTimeout(() => {
		this.pendingSaveTimer = null;
		void this.persistSettings();
	}, SAVE_DEBOUNCE_MS);
}

// Immediately writes any pending save — used when the plugin is disabled
// so as never to lose the last changes remaining within the grouping
// delay.

export async function flushPendingSave(this: MTGCollectionPlugin) {
	if (this.pendingSaveTimer === null) return;
	window.clearTimeout(this.pendingSaveTimer);
	this.pendingSaveTimer = null;
	await this.persistSettings();
}

// Deduplicated and sorted list of the artists present in the collection,
// cached: even at 100,000 cards, the number of DISTINCT artists stays on
// the order of a few thousand (the whole history of Magic counts only
// about 2000-3000), so searching a prefix in it stays instant.

export function getDistinctArtists(this: MTGCollectionPlugin): string[] {
	if (this.cachedArtists) return this.cachedArtists;
	const set = new Set<string>();
	this.settings.collection.forEach((c) => {
		if (c.artist) set.add(c.artist);
	});
	this.cachedArtists = Array.from(set).sort();
	return this.cachedArtists;
}

// Distinct sets present in the collection, code + name (the code serves
// for the filter itself and to find the official symbol; the name remains
// what is displayed and typed).

export function getDistinctSets(this: MTGCollectionPlugin): { code: string; name: string }[] {
	if (this.cachedSets) return this.cachedSets;
	const map = new Map<string, string>();
	this.settings.collection.forEach((c) => {
		if (c.setCode && c.setName && !map.has(c.setCode)) map.set(c.setCode, c.setName);
	});
	this.cachedSets = Array.from(map, ([code, name]) => ({ code, name })).sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	return this.cachedSets;
}

// Old versions stored a "foilCount" counter on the same row as the normal
// version. We split that into separate rows (a foil card is now an entry in
// its own right), and assign to each row its own identifier (id), now used
// as the key for actions.
