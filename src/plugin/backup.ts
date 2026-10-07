import { normalizePath, TFile, TFolder } from "obsidian";
import { MTGCollectionSettings, BackupSummary, DEFAULT_SETTINGS } from "../core/data-model";
import type { BackupFileInfo } from "../core/backup-files";
import type MTGCollectionPlugin from "../plugin";

export const BACKUP_FORMAT_MARKER = "mtg-collection-tracker-backup";
export const BACKUP_SCHEMA_VERSION = 1;
export const AUTO_BACKUP_FILE_PREFIX = "mtg-collection-backup-auto-";

export function exportBackup(this: MTGCollectionPlugin): string {
	// Déstructuration plutôt que `delete` sur une copie : garantit que
	// this.settings lui-même (et sa clé, toujours nécessaire en mémoire
	// pour les appels cardbase.dev de cette session) n'est jamais muté.
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
// Valide et résume un fichier de sauvegarde sans rien appliquer — utilisé
// par setting-tab.ts pour construire le récapitulatif affiché dans
// RestoreBackupConfirmModal avant confirmation. `settings` n'est qu'un
// Partial<MTGCollectionSettings> : un fichier plus ancien peut manquer des
// champs ajoutés depuis (restoreBackup les complète via DEFAULT_SETTINGS,
// même principe que loadSettings avec data.json).

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
// Chemin partagé par le déclenchement automatique ci-dessus ET le bouton
// "Back up now" (setting-tab.ts) — un seul endroit qui écrit réellement
// le fichier, pas deux à tenir synchronisés. Utilise l'API Vault
// (createFolder/create/modify), pas vault.adapter comme les caches
// Scryfall privés du plugin (loadPersistedMapCache et consorts,
// désormais dans src/plugin/scryfall-cache.ts) : ces fichiers-ci doivent être de
// VRAIS fichiers de la vault — visibles dans l'explorateur d'Obsidian,
// déplaçables, et suivis par n'importe quelle synchronisation de vault
// déjà en place — pas des données privées du plugin. Nom de fichier à la
// journée (pas à la seconde) comme le téléchargement manuel : un 2ème
// déclenchement le même jour (ex. "Back up now" cliqué le jour même
// d'une sauvegarde automatique déjà faite) écrase simplement le fichier
// du jour au lieu d'en créer un doublon — la sauvegarde la plus récente
// du jour l'emporte, ce qui reste le comportement voulu.

// Le dossier des sauvegardes (réglage « Backup folder »), le même pour les écrire (runAutoBackup) et pour les lister
// (listBackupFiles) : un seul calcul, donc jamais deux dossiers différents.
export function backupFolderPath(plugin: MTGCollectionPlugin): string {
	return normalizePath(plugin.settings.autoBackupFolder.trim() || "MTG Backups");
}

export async function runAutoBackup(this: MTGCollectionPlugin): Promise<{ path: string } | { error: string }> {
	try {
		const folderPath = backupFolderPath(this);
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			// Peut légitimement lever si un autre appel a créé le dossier
			// entre-temps (ex. clic sur "Back up now" pendant que le
			// déclenchement automatique tourne déjà) — ignoré volontairement,
			// le create()/modify() ci-dessous fera surface toute vraie erreur.
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
// Les fichiers du dossier des sauvegardes, bruts : core/backup-files.ts (listBackups) garde ceux qui sont des sauvegardes et les
// ordonne. Un dossier absent ou vide donne une liste vide, jamais une erreur. Pas récursif, comme pruneAutoBackups.
export function listBackupFiles(this: MTGCollectionPlugin): BackupFileInfo[] {
	const folder = this.app.vault.getAbstractFileByPath(backupFolderPath(this));
	if (!(folder instanceof TFolder)) return [];
	return folder.children
		.filter((f): f is TFile => f instanceof TFile)
		.map((f) => ({ path: f.path, name: f.name, mtime: f.stat.mtime, size: f.stat.size }));
}

// Le texte d'un fichier de sauvegarde du coffre, par l'API Vault (aucun sélecteur de fichier du système n'intervient).
export async function readBackupFile(this: MTGCollectionPlugin, path: string): Promise<string> {
	const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) throw new Error("This backup file no longer exists in the vault.");
	return this.app.vault.read(file);
}
// Garde au plus settings.autoBackupKeepCount sauvegardes AUTOMATIQUES
// (préfixe AUTO_BACKUP_FILE_PREFIX uniquement) dans le dossier — les plus
// anciennes sont déplacées à la corbeille (vault.trash avec `false`,
// respecte le réglage "corbeille système vs .trash" d'Obsidian plutôt
// qu'une suppression définitive), jamais un fichier qui ne porte pas ce
// préfixe. Le nom de fichier intègre déjà la date au format ISO
// (YYYY-MM-DD), donc un tri alphabétique est aussi un tri chronologique
// — pas besoin de lire `stat.ctime` sur chaque fichier.

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
