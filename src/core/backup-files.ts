// The backup files the plugin recognizes in the backups folder ("Restore backup → Choose a saved backup"), and
// how to present them. Pure, no Obsidian: plugin/backup.ts lists the vault's files, the modal
// (modals/restore-backup-modal.ts) displays what comes out of here.
//
// Two families of names, both already produced by the plugin:
// - mtg-collection-backup-auto-YYYY-MM-DD.json: the automatic backups (AUTO_BACKUP_FILE_PREFIX);
// - mtg-collection-backup-YYYY-MM-DD.json: "Export backup" (a manual export that the user drops into this
//   folder, by hand or through their sync, is therefore listed too — pruneAutoBackups, for its part, never
//   touches it).

export interface BackupFileInfo {
	path: string;
	name: string;
	// File modification date (ms): fallback when the name carries no date.
	mtime: number;
	size: number;
}

export type BackupKind = "automatic" | "manual";

export interface BackupListItem extends BackupFileInfo {
	kind: BackupKind;
	// "2026-10-05", read from the file name (more reliable than mtime, which a vault sync rewrites); otherwise, the
	// modification date.
	date: string;
}

const AUTO_PREFIX = "mtg-collection-backup-auto-";
const MANUAL_PREFIX = "mtg-collection-backup-";

export function isBackupFileName(name: string): boolean {
	return name.startsWith(MANUAL_PREFIX) && name.toLowerCase().endsWith(".json");
}

export function backupKind(name: string): BackupKind {
	return name.startsWith(AUTO_PREFIX) ? "automatic" : "manual";
}

function localIsoDate(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function backupDate(file: BackupFileInfo): string {
	const fromName = /(\d{4}-\d{2}-\d{2})/.exec(file.name);
	return fromName ? fromName[1] : localIsoDate(file.mtime);
}

// The recognized backups, most recent first (date, then modification time, then name: two backups from the same
// day, the automatic one and a manual export, stay in a stable order).
export function listBackups(files: BackupFileInfo[]): BackupListItem[] {
	return files
		.filter((f) => isBackupFileName(f.name))
		.map((f) => ({ ...f, kind: backupKind(f.name), date: backupDate(f) }))
		.sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime || a.name.localeCompare(b.name));
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
