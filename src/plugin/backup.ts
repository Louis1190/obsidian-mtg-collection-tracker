import { normalizePath, TFile, TFolder } from "obsidian";
import { MTGCollectionSettings, BackupSummary, DEFAULT_SETTINGS } from "../core/data-model";
import type { BackupFileInfo } from "../core/backup-files";
import type MTGCollectionPlugin from "../plugin";

export const BACKUP_FORMAT_MARKER = "mtg-collection-tracker-backup";
export const BACKUP_SCHEMA_VERSION = 1;
export const AUTO_BACKUP_FILE_PREFIX = "mtg-collection-backup-auto-";

export function exportBackup(this: MTGCollectionPlugin): string {
	// Destructuring rather than `delete` on a copy: guarantees that
	// this.settings itself (and its key, still needed in memory for this
	// session's cardbase.dev calls) is never mutated.
	const { cardbaseApiKey, ...settingsWithoutKey } = this.settings;
	const backup = {
		format: BACKUP_FORMAT_MARKER,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		pluginVersion: this.manifest.version,
		exportedAt: Date.now(),
		settings: settingsWithoutKey,
	};
	return JSON.stringify(backup, null, 2);
}
// Validates and summarizes a backup file without applying anything — used
// by setting-tab.ts to build the summary displayed in
// RestoreBackupConfirmModal before confirmation. `settings` is only a
// Partial<MTGCollectionSettings>: an older file may lack fields added
// since (restoreBackup fills them in via DEFAULT_SETTINGS, same principle
// as loadSettings with data.json).

export function parseBackupFile(this: MTGCollectionPlugin, text: string): { settings: Partial<MTGCollectionSettings>; summary: BackupSummary } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: "This file isn't valid JSON." };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as Record<string, unknown>).format !== BACKUP_FORMAT_MARKER ||
		typeof (parsed as Record<string, unknown>).settings !== "object" ||
		(parsed as Record<string, unknown>).settings === null
	) {
		return { error: "This doesn't look like an MTG Collection Tracker backup file." };
	}
	const envelope = parsed as { settings: Partial<MTGCollectionSettings>; exportedAt?: unknown };
	const settings = envelope.settings;
	const summary: BackupSummary = {
		cards: Array.isArray(settings.collection) ? settings.collection.length : 0,
		lists: Array.isArray(settings.lists) ? settings.lists.length : 0,
		decks: Array.isArray(settings.decks) ? settings.decks.length : 0,
		wantlistItems: Array.isArray(settings.wantlist) ? settings.wantlist.length : 0,
		wantlists: Array.isArray(settings.wantlists) ? settings.wantlists.length : 0,
		exportedAt: typeof envelope.exportedAt === "number" ? envelope.exportedAt : null,
	};
	return { settings, summary };
}

export async function restoreBackup(this: MTGCollectionPlugin, settings: Partial<MTGCollectionSettings>) {
	const currentApiKey = this.settings.cardbaseApiKey;
	this.settings = Object.assign({}, DEFAULT_SETTINGS, settings, { cardbaseApiKey: currentApiKey });
	await this.runSettingsMigrations();
	await this.saveSettings();
	this.refreshAccentColor();
	this.refreshCollectionRibbonIcon();
	this.refreshOpenViews();
}

export async function maybeAutoBackup(this: MTGCollectionPlugin) {
	const hours = this.settings.autoBackupIntervalHours;
	if (hours <= 0) return;
	const elapsedMs = Date.now() - this.settings.lastAutoBackup;
	if (elapsedMs < hours * 60 * 60 * 1000) return;
	await this.runAutoBackup();
}
// Path shared by the automatic trigger above AND the "Back up now" button
// (setting-tab.ts) — a single place that actually writes the file, not two to
// keep in sync. Uses the Vault API (createFolder/create/modify), not
// vault.adapter like the plugin's private Scryfall caches (loadPersistedMapCache
// and the like, now in src/plugin/scryfall-cache.ts): these files must be REAL
// vault files — visible in Obsidian's explorer, movable, and tracked by any
// vault synchronization already in place — not private plugin data. Per-day file
// name (not per-second) like the manual download: a 2nd trigger on the same day
// (e.g. "Back up now" clicked the same day as an already done automatic backup)
// simply overwrites the day's file instead of creating a duplicate — the most
// recent backup of the day wins, which remains the wanted behavior.

// The backups folder ("Backup folder" setting), the same one to write them (runAutoBackup) and to list them
// (listBackupFiles): a single computation, hence never two different folders.
export function backupFolderPath(plugin: MTGCollectionPlugin): string {
	return normalizePath(plugin.settings.autoBackupFolder.trim() || "MTG Backups");
}

export async function runAutoBackup(this: MTGCollectionPlugin): Promise<{ path: string } | { error: string }> {
	try {
		const folderPath = backupFolderPath(this);
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			// May legitimately throw if another call created the folder in the
			// meantime (e.g. a click on "Back up now" while the automatic trigger is
			// already running) — deliberately ignored, the create()/modify() below
			// will surface any real error.
			try {
				await this.app.vault.createFolder(folderPath);
			} catch {
				/* voir commentaire ci-dessus */
			}
		}
		const stamp = new Date().toISOString().slice(0, 10);
		const filePath = normalizePath(
			`${folderPath}/${AUTO_BACKUP_FILE_PREFIX}${stamp}.json`
		);
		const content = this.exportBackup();
		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
		this.settings.lastAutoBackup = Date.now();
		await this.saveSettings();
		await this.pruneAutoBackups(folderPath);
		return { path: filePath };
	} catch (e) {
		console.error("MTG Collection Tracker: automatic backup failed.", e);
		return { error: e instanceof Error ? e.message : String(e) };
	}
}
// The files of the backups folder, raw: core/backup-files.ts (listBackups) keeps those that are backups and
// orders them. A missing or empty folder gives an empty list, never an error. Not recursive, like
// pruneAutoBackups.
export function listBackupFiles(this: MTGCollectionPlugin): BackupFileInfo[] {
	const folder = this.app.vault.getAbstractFileByPath(backupFolderPath(this));
	if (!(folder instanceof TFolder)) return [];
	return folder.children
		.filter((f): f is TFile => f instanceof TFile)
		.map((f) => ({ path: f.path, name: f.name, mtime: f.stat.mtime, size: f.stat.size }));
}

// The text of a vault backup file, via the Vault API (no system file picker is involved).
export async function readBackupFile(this: MTGCollectionPlugin, path: string): Promise<string> {
	const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) throw new Error("This backup file no longer exists in the vault.");
	return this.app.vault.read(file);
}
// Keeps at most settings.autoBackupKeepCount AUTOMATIC backups
// (AUTO_BACKUP_FILE_PREFIX prefix only) in the folder — the oldest ones
// are moved to the trash (vault.trash with `false`, respects Obsidian's
// "system trash vs .trash" setting rather than a permanent deletion),
// never a file that doesn't carry this prefix. The file name already
// embeds the date in ISO format (YYYY-MM-DD), so an alphabetical sort is
// also a chronological sort — no need to read `stat.ctime` on each file.

export async function pruneAutoBackups(this: MTGCollectionPlugin, folderPath: string) {
	const keep = Math.max(1, Math.floor(this.settings.autoBackupKeepCount) || 7);
	const folder = this.app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return;
	const backups = folder.children
		.filter(
			(f): f is TFile => f instanceof TFile && f.name.startsWith(AUTO_BACKUP_FILE_PREFIX)
		)
		.sort((a, b) => a.name.localeCompare(b.name));
	const toDelete = backups.slice(0, Math.max(0, backups.length - keep));
	for (const file of toDelete) {
		await this.app.fileManager.trashFile(file);
	}
}
