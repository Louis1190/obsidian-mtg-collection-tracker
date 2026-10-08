import { Notice, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, type MTGCollectionSettings } from "../core/data-model";
import { DEVICE_LOCAL_KEYS, omitDeviceLocal, pickDeviceLocal } from "../core/device-settings";
import {
	applySettingsInPlace,
	mergeSettings,
	recordEntityStamps,
	recordScalarStamps,
	recordTombstones,
	snapshotEntityPrints,
	snapshotKeys,
	snapshotScalars,
} from "../core/settings-merge";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/* Multi-device synchronization of data.json (2026-10-03).

    data.json travels via Syncthing between the Mac, the iPad and the phone.
    Before this file, the plugin only read it at startup and rewrote it in full
    on every change: a device that received a more recent version kept it on disk
    but not in memory, then overwrote it at its next save (6
    data.sync-conflict-*.json files in the vault bear witness). Now:

    - every write is preceded by a disk check (stat, almost free); if the file
      has changed elsewhere, we MERGE (core/settings-merge.ts) instead of
      overwriting;
    - the plugin also watches the file outside of writes: Obsidian hook
      `onExternalSettingsChange` (instant on desktop), polling every 20 s, return
      to the foreground — Obsidian mobile is suspended in the background, a file
      that arrived during that time triggers no event there.

    EVERYTHING that touches the file goes through a single queue
    (`persistChain`): never two reads/merges/writes at the same time. */
/* -------------------------------------------------------------------------- */

// A polling check only costs a stat as long as the file hasn't moved: it can be done
// often. It is the safety net for cases where Obsidian emits no event (suspended mobile,
// a device's drifting clock); the event itself remains instantaneous.
export const SETTINGS_POLL_MS = 5 * 1000;
// The device's local storage (Obsidian limits it to the vault AND to the device, never synchronized).
export const DEVICE_SETTINGS_STORAGE_KEY = "mtg-collection-tracker:device-settings";
export const SYNC_BACKUP_DIR = "sync-backups";
export const SYNC_BACKUP_KEEP = 3;
// Beyond it, a merge that removes (or adds) as many items locally first keeps a copy
// of the local state and warns. A big deletion coming from another device (big "Delete
// list") or a big import is legitimate, but must remain recoverable; a big ADDITION is
// also what a device left on an old plugin version (without tombstones) that rewrites
// an old file would give: the cards deleted since would come back, and it must be
// possible to go back.
export const BIG_REMOVAL_THRESHOLD = 25;
export const BIG_ADDITION_THRESHOLD = 200;
// Tolerated gap between the mtime requested at write time and the one re-read right
// after: beyond it, someone else touched the file in the meantime. Wide on purpose:
// some file systems (the FAT/exFAT of an Android external storage) round the mtime to
// 2 s, and a file delivered by Syncthing carries the date of ITS author.
const WRITE_RACE_TOLERANCE_MS = 5000;
// Maximum number of successive reads before writing (see reconcileUntilStable).
const MAX_RECONCILE_PASSES = 3;
const SAVE_RETRY_MS = 5000;
// Safeguard: at most MERGE_WRITE_MAX writes triggered by an external check
// (hence not by a user modification) per window. Two devices that would
// endlessly send each other back their own version of a same setting (each
// judging that the other has "changed nothing") would rewrite 6 MB every few
// seconds, without end; here the loop stops by itself and the next real
// modification takes over.
export const MERGE_WRITE_WINDOW_MS = 2 * 60 * 1000;
export const MERGE_WRITE_MAX = 4;

export interface DiskSignature {
	mtime: number;
	size: number;
}

type Obj = Record<string, unknown>;

// Name of the data file in a folder chosen by the user (in the plugin's folder, it is Obsidian's
// data.json, as before).
export const CUSTOM_DATA_FILE_NAME = "mtg-collection-data.json";

// "" = the plugin's folder. Otherwise a vault-relative path, with no ".." or ".": null if invalid.
export function normalizeDataFolder(input: string): string | null {
	const parts = input
		.trim()
		.split(/[\\/]+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0 && p !== ".");
	if (parts.some((p) => p === "..")) return null;
	return parts.join("/");
}

function defaultDataPath(plugin: MTGCollectionPlugin): string | null {
	return plugin.manifest.dir ? normalizePath(`${plugin.manifest.dir}/data.json`) : null;
}

function dataFilePath(plugin: MTGCollectionPlugin): string | null {
	const folder = plugin.dataFolderInUse;
	return folder ? normalizePath(`${folder}/${CUSTOM_DATA_FILE_NAME}`) : defaultDataPath(plugin);
}

function parseSettingsText(text: string): Obj | null {
	try {
		const v: unknown = JSON.parse(text);
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
	} catch {
		return null;
	}
}

// A single queue for all the disk operations: the chain never rejects (any
// error is logged here), otherwise a single failure would block the
// following ones for good.
function enqueue(plugin: MTGCollectionPlugin, task: () => Promise<void>): Promise<void> {
	const run = plugin.persistChain.then(task).catch((e) => {
		console.error("MTG Collection Tracker: settings sync failed.", e);
	});
	plugin.persistChain = run;
	return run;
}

/* ------------------------------- chargement -------------------------------- */

// Replaces loadData() for the initial load: we need the file's TEXT (starting
// version of the merge, echo detection) and its signature, which loadData()
// doesn't provide. Same result otherwise (file missing or unreadable → null →
// default settings), with one extra precaution: an unreadable file is set aside
// before the first save overwrites it with empty settings.
export async function readSettingsFromDisk(this: MTGCollectionPlugin): Promise<Partial<MTGCollectionSettings> | null> {
	// Where is the file? It's a device-specific setting, hence read from the device's storage BEFORE
	// the file itself (the other device-specific settings are taken up just after).
	const stored = readLocalStore(this);
	const storedFolder = stored !== null && typeof stored === "object" ? (stored as Obj).dataFolder : "";
	this.dataFolderInUse = (typeof storedFolder === "string" && normalizeDataFolder(storedFolder)) || "";

	let path = dataFilePath(this);
	if (!path) return ((await this.loadData()) as Partial<MTGCollectionSettings> | null) ?? null;
	const adapter = this.app.vault.adapter;
	let seeding = false;
	if (!(await adapter.exists(path))) {
		// Folder chosen but file not (yet) there — for example not yet delivered by Syncthing on a new
		// device: rather than starting on an EMPTY collection (you'd think everything was lost), we
		// start again from the data at the original location; the first save will create the file.
		const fallback = this.dataFolderInUse ? defaultDataPath(this) : null;
		if (!fallback || !(await adapter.exists(fallback))) return null;
		path = fallback;
		seeding = true;
	}
	let text: string;
	try {
		text = await adapter.read(path);
	} catch (e) {
		console.error("MTG Collection Tracker: could not read the data file.", e);
		return null;
	}
	const data = parseSettingsText(text);
	if (!data) {
		const copy = normalizePath(`${this.manifest.dir}/data.unreadable-${Date.now()}.json`);
		try {
			await adapter.write(copy, text);
			new Notice(`MTG Collection Tracker: data.json could not be read. A copy was kept as ${copy}.`, 15000);
		} catch (e) {
			console.error("MTG Collection Tracker: could not keep a copy of the unreadable data.json.", e);
		}
		return null;
	}
	if (seeding) return data; // nothing is read "from" the active location
	this.diskText = text;
	this.syncBaseText = text;
	const st = await adapter.stat(path);
	this.diskSig = st ? { mtime: st.mtime, size: st.size } : null;
	return data;
}

export type DataFolderResult = { ok: true; mergedExisting: boolean } | { ok: false; message: string };

// Changes the folder that contains the data file ("Data folder" setting). Never any loss:
// 1. the old file is updated one last time then left in place — nothing is deleted;
// 2. if a data file already exists in the new folder (that of another device which Syncthing
//    delivered there, for example), it is MERGED with the in-memory data, not overwritten;
// 3. at the slightest error we go back to the previous location.
// Everything goes through the disk-operations queue.
export function changeDataFolder(this: MTGCollectionPlugin, folder: string): Promise<DataFolderResult> {
	return new Promise((resolve) => {
		void enqueue(this, async () => {
			const next = normalizeDataFolder(folder);
			if (next === null) return resolve({ ok: false, message: 'A folder cannot contain "..".' });
			const previous = this.dataFolderInUse;
			if (next === previous) return resolve({ ok: true, mergedExisting: false });
			const adapter = this.app.vault.adapter;
			const oldPath = dataFilePath(this);
			try {
				if (oldPath && this.settingsLoaded) {
					prepareLocal(this);
					await reconcileUntilStable(this, oldPath);
					await writeToDisk(this, oldPath);
				}
				this.dataFolderInUse = next;
				const newPath = dataFilePath(this);
				if (!newPath) throw new Error("No place to store the data.");
				if (next && !(await adapter.exists(next))) await adapter.mkdir(next);
				this.diskText = null;
				this.diskSig = null;
				this.syncBaseText = null;
				let merged = false;
				if (await adapter.exists(newPath)) {
					const text = await adapter.read(newPath);
					prepareLocal(this);
					const outcome = mergeForeignText(this, text, null);
					if (!outcome) throw new Error("The data file already in that folder is not valid.");
					this.syncBaseText = text;
					this.diskText = text;
					if (outcome.changedLocal) this.markGithubDirty();
					merged = true;
				}
				await writeToDisk(this, newPath);
				const st = await adapter.stat(newPath);
				if (!st) throw new Error("The data file could not be created there.");
				this.diskSig = { mtime: st.mtime, size: st.size };
				this.settings.dataFolder = next;
				this.saveDeviceLocalSettings();
				resolve({ ok: true, mergedExisting: merged });
			} catch (e) {
				console.error("MTG Collection Tracker: changing the data folder failed, keeping the previous one.", e);
				this.dataFolderInUse = previous;
				this.diskText = null;
				this.diskSig = null; // the next check will re-read the old file
				this.syncBaseText = null;
				resolve({ ok: false, message: e instanceof Error ? e.message : String(e) });
			}
		});
	});
}

// To be called once the settings are loaded AND migrated: deletions will be
// detected relative to this state.
export function markSettingsLoaded(this: MTGCollectionPlugin) {
	this.knownKeys = snapshotKeys(this.settings as unknown as Obj);
	this.knownScalars = snapshotScalars(this.settings as unknown as Obj);
	this.knownPrints = snapshotEntityPrints(this.settings as unknown as Obj);
	this.settingsLoaded = true;
}

/* ------------------------ device-specific settings ---------------------- */

// Reading of the local storage; fallback to localStorage if Obsidian's API (≥ 1.8.7) is missing.
function readLocalStore(plugin: MTGCollectionPlugin): unknown {
	try {
		const app = plugin.app as unknown as { loadLocalStorage?: (k: string) => unknown };
		if (typeof app.loadLocalStorage === "function") return app.loadLocalStorage(DEVICE_SETTINGS_STORAGE_KEY);
		const raw = window.localStorage.getItem(DEVICE_SETTINGS_STORAGE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function writeLocalStore(plugin: MTGCollectionPlugin, value: Obj): void {
	try {
		const app = plugin.app as unknown as { saveLocalStorage?: (k: string, v: unknown) => void };
		if (typeof app.saveLocalStorage === "function") app.saveLocalStorage(DEVICE_SETTINGS_STORAGE_KEY, value);
		else window.localStorage.setItem(DEVICE_SETTINGS_STORAGE_KEY, JSON.stringify(value));
	} catch (e) {
		console.warn("MTG Collection Tracker: could not save this device's display settings.", e);
	}
}

// Called right after reading data.json: the values specific to THIS device take over.
// First launch after the update (nothing in storage): we keep what data.json contained
// until now — the device therefore doesn't change look — and put it in storage right
// away, since data.json will no longer carry it.
export function loadDeviceLocalSettings(this: MTGCollectionPlugin) {
	const stored = readLocalStore(this);
	if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
		const target = this.settings as unknown as Obj;
		const defaults = DEFAULT_SETTINGS as unknown as Obj;
		for (const [k, v] of Object.entries(stored as Obj)) {
			// Only a known key, of the right type: a stale or tampered storage must not break anything.
			if (DEVICE_LOCAL_KEYS.has(k) && typeof v === typeof defaults[k]) target[k] = v;
		}
	}
	this.saveDeviceLocalSettings();
}

// Synchronous and inexpensive (about thirty values): called on every saveSettings().
export function saveDeviceLocalSettings(this: MTGCollectionPlugin) {
	const picked = pickDeviceLocal(this.settings);
	const serialized = JSON.stringify(picked);
	if (serialized === this.lastDeviceLocal) return;
	this.lastDeviceLocal = serialized;
	writeLocalStore(this, picked);
}

/* -------------------------------- writing --------------------------------- */

// Path of all the saves (see saveSettings, flushPendingSave).
export function persistSettings(this: MTGCollectionPlugin): Promise<void> {
	return enqueue(this, async () => {
		const path = dataFilePath(this);
		if (!path) {
			await this.saveData(this.settings);
			return;
		}
		prepareLocal(this);
		await reconcileUntilStable(this, path);
		await writeToDisk(this, path);
	}).then(() => {
		// Failed write: a single deferred new attempt — Obsidian silently
		// swallowed this kind of failure (saveData), the change then remained in
		// memory only until the next save.
		if (this.saveFailed && this.saveRetryTimer === null) {
			this.saveRetryTimer = window.setTimeout(() => {
				this.saveRetryTimer = null;
				void this.persistSettings();
			}, SAVE_RETRY_MS);
		}
	});
}

// Check (and possible merge) outside of writes: Obsidian hook, polling,
// return to the foreground. Only one check pending at a time.
export function checkForExternalChange(this: MTGCollectionPlugin, _reason = "poll"): Promise<void> {
	if (!this.settingsLoaded || this.externalCheckQueued) return Promise.resolve();
	this.externalCheckQueued = true;
	return enqueue(this, async () => {
		this.externalCheckQueued = false;
		const path = dataFilePath(this);
		if (!path) return;
		// The file hasn't moved: nothing to merge, so nothing to prepare either.
		const st = await this.app.vault.adapter.stat(path);
		const known = this.diskSig;
		if (!st || (known && known.mtime === st.mtime && known.size === st.size)) return;
		prepareLocal(this);
		const { needsWrite } = await reconcileUntilStable(this, path);
		if (!needsWrite) return;
		const now = Date.now();
		this.mergeWrites = this.mergeWrites.filter((t) => now - t < MERGE_WRITE_WINDOW_MS);
		if (this.mergeWrites.length >= MERGE_WRITE_MAX) {
			console.warn("MTG Collection Tracker: too many merge rewrites in a row, pausing until the next local change.");
			return;
		}
		this.mergeWrites.push(now);
		await writeToDisk(this, path);
	});
}

// Called by Obsidian when data.json changes on disk outside the plugin
// (compares the mtime to that of its last read/write — see app.js,
// Plugin._onConfigFileChange). Reliable on desktop; on mobile and when a
// device's clock drifts it can be missed: hence the polling below.
export function onExternalSettingsChange(this: MTGCollectionPlugin): Promise<void> {
	return this.checkForExternalChange("watcher");
}

export function setupSettingsSync(this: MTGCollectionPlugin) {
	this.registerInterval(window.setInterval(() => void this.checkForExternalChange("poll"), SETTINGS_POLL_MS));
	this.registerDomEvent(window, "focus", () => void this.checkForExternalChange("focus"));
	this.registerDomEvent(document, "visibilitychange", () => {
		if (document.visibilityState === "visible") void this.checkForExternalChange("visible");
	});
}

/* --------------------------------- internes -------------------------------- */

// Records the deletions made since the last write BEFORE any merge: a local
// deletion still within the grouping delay has no tombstone, the copy still
// present remotely would bring it back.
export function prepareLocal(plugin: MTGCollectionPlugin) {
	if (!plugin.knownKeys || !plugin.knownScalars || !plugin.knownPrints) return;
	const settings = plugin.settings as unknown as Obj;
	const now = Date.now();
	recordTombstones(settings, plugin.knownKeys, now);
	recordScalarStamps(settings, plugin.knownScalars, now);
	recordEntityStamps(settings, plugin.knownPrints, now);
	plugin.knownKeys = snapshotKeys(settings);
	plugin.knownScalars = snapshotScalars(settings);
	plugin.knownPrints = snapshotEntityPrints(settings);
}

// Merges, then re-checks the disk just before handing back control: a file that arrived
// during the read/merge (Syncthing renames its own over it) would otherwise be
// overwritten by the write that follows. The window that remains is that of a single
// stat → write.
async function reconcileUntilStable(plugin: MTGCollectionPlugin, path: string): Promise<{ needsWrite: boolean }> {
	let needsWrite = false;
	for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass++) {
		const outcome = await reconcile(plugin, path);
		needsWrite = needsWrite || outcome.needsWrite;
		const st = await plugin.app.vault.adapter.stat(path);
		const known = plugin.diskSig;
		if (!st || (known && known.mtime === st.mtime && known.size === st.size)) break;
	}
	return { needsWrite };
}

export interface ForeignMergeOutcome {
	/** The local state has changed (it must be saved and the views refreshed). */
	changedLocal: boolean;
	/** The merged state contains something the source doesn't have: it has to be sent back to it. */
	needsWrite: boolean;
}

// Merges `text` (the content of an external source: the disk file that Syncthing may have
// replaced, or the GitHub file) into the in-memory settings. `baseText` = last version COMING
// FROM THIS SOURCE (never our own writes — see core/settings-merge.ts). Returns null if `text`
// is not a settings JSON. Synchronous from end to end: no await between the computation of the
// merge and its application, the local state can't move between the two. `ignore`: keys that
// this source doesn't carry (see omitKeys).
export function mergeForeignText(
	plugin: MTGCollectionPlugin,
	text: string,
	baseText: string | null,
	ignore?: ReadonlySet<string>
): ForeignMergeOutcome | null {
	const remote = parseSettingsText(text);
	if (!remote) return null;
	const local = plugin.settings as unknown as Obj;
	const base = baseText ? parseSettingsText(baseText) : null;
	const { merged, report } = mergeSettings(base, local, remote, ignore, DEFAULT_SETTINGS as unknown as Obj);

	if (report.needsWrite) void saveSyncBackup(plugin, "remote", text);
	if (report.removed >= BIG_REMOVAL_THRESHOLD || report.added >= BIG_ADDITION_THRESHOLD) {
		void saveSyncBackup(plugin, "local", JSON.stringify(local, null, 2));
		const what =
			report.removed >= BIG_REMOVAL_THRESHOLD
				? `removed ${report.removed} items`
				: `added ${report.added} items`;
		new Notice(
			`MTG Collection Tracker: another device ${what}. A copy of this device's previous data was kept in ${SYNC_BACKUP_DIR}.`,
			12000
		);
	}
	if (report.changedLocal) {
		applySettingsInPlace(local, merged);
		plugin.dataVersion++;
		plugin.cachedArtists = null;
		plugin.cachedSets = null;
		plugin.refreshOpenViews();
	}
	if (report.added + report.removed + report.updated > 0) {
		console.debug(
			`MTG Collection Tracker: merged data from another device (+${report.added} −${report.removed} ~${report.updated}).`
		);
	}
	// What has just been merged is NOT a local modification: without this update,
	// the next check would timestamp it as such.
	plugin.knownKeys = snapshotKeys(local);
	plugin.knownScalars = snapshotScalars(local);
	plugin.knownPrints = snapshotEntityPrints(local);
	return { changedLocal: report.changedLocal, needsWrite: report.needsWrite };
}

async function reconcile(plugin: MTGCollectionPlugin, path: string): Promise<{ needsWrite: boolean }> {
	const adapter = plugin.app.vault.adapter;
	const st = await adapter.stat(path);
	if (!st) return { needsWrite: false }; // file deleted: the next write re-creates it
	const sig: DiskSignature = { mtime: st.mtime, size: st.size };
	const known = plugin.diskSig;
	if (known && known.mtime === sig.mtime && known.size === sig.size) return { needsWrite: false };

	const text = await adapter.read(path);
	if (text === plugin.diskText) {
		plugin.diskSig = sig; // mtime touched up, identical content
		return { needsWrite: false };
	}
	const outcome = mergeForeignText(plugin, text, plugin.syncBaseText);
	if (!outcome) {
		// Unreadable (partial copy, another sync tool…): we touch nothing, the
		// next write will replace it with a valid file.
		console.warn("MTG Collection Tracker: data.json on disk is not valid JSON, ignoring it.");
		plugin.diskSig = sig;
		return { needsWrite: false };
	}
	plugin.syncBaseText = text;
	plugin.diskText = text;
	plugin.diskSig = sig;
	// What Syncthing has just brought must also go to GitHub (if enabled).
	if (outcome.changedLocal) plugin.markGithubDirty();
	return { needsWrite: outcome.needsWrite };
}

async function writeToDisk(plugin: MTGCollectionPlugin, path: string): Promise<void> {
	// Without the device-specific settings: a sort change must neither rewrite 6 MB nor go elsewhere.
	const text = JSON.stringify(omitDeviceLocal(plugin.settings), null, 2);
	if (text === plugin.diskText) return; // the disk already has exactly this state
	const adapter = plugin.app.vault.adapter;
	const mtime = Date.now();
	plugin.saveFailed = false;
	try {
		try {
			await adapter.write(path, text, { mtime });
		} catch (e) {
			// Folder chosen by the user, deleted since: we re-create it once rather than lose the
			// save.
			if (!plugin.dataFolderInUse || (await adapter.exists(plugin.dataFolderInUse))) throw e;
			await adapter.mkdir(plugin.dataFolderInUse);
			await adapter.write(path, text, { mtime });
		}
	} catch (e) {
		plugin.saveFailed = true;
		throw e;
	}
	const st = await adapter.stat(path);
	plugin.diskText = text;
	if (st && Math.abs(st.mtime - mtime) <= WRITE_RACE_TOLERANCE_MS) {
		plugin.diskSig = { mtime: st.mtime, size: st.size };
	} else {
		// The file doesn't carry the mtime we just gave it: another process
		// rewrote it in the meantime. We forget the signature so that the next
		// check re-reads and merges.
		plugin.diskSig = null;
		void plugin.checkForExternalChange("write-race");
	}
}

// Safety copy in the plugin's folder (the 3 most recent per type). Never
// blocking: a failure here must neither prevent the merge nor the write.
async function saveSyncBackup(plugin: MTGCollectionPlugin, kind: "remote" | "local", text: string): Promise<void> {
	try {
		const adapter = plugin.app.vault.adapter;
		const dir = normalizePath(`${plugin.manifest.dir}/${SYNC_BACKUP_DIR}`);
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		await adapter.write(`${dir}/data-${kind}-${stamp}.json`, text);
		const listing = await adapter.list(dir);
		const mine = listing.files.filter((f) => f.split("/").pop()!.startsWith(`data-${kind}-`)).sort();
		for (const old of mine.slice(0, Math.max(0, mine.length - SYNC_BACKUP_KEEP))) await adapter.remove(old);
	} catch (e) {
		console.warn("MTG Collection Tracker: could not write a sync backup.", e);
	}
}
