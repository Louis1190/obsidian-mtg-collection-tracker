// Les fichiers de sauvegarde que le plugin reconnaît dans le dossier des sauvegardes (« Restore backup → Choose a saved backup »),
// et comment les présenter. Pur, sans Obsidian : plugin/backup.ts liste les fichiers du coffre, la modale
// (modals/restore-backup-modal.ts) affiche ce qui sort d'ici.
//
// Deux familles de noms, toutes deux déjà produites par le plugin :
//  - mtg-collection-backup-auto-YYYY-MM-DD.json : les sauvegardes automatiques (AUTO_BACKUP_FILE_PREFIX) ;
//  - mtg-collection-backup-YYYY-MM-DD.json : « Export backup » (un export manuel que l'utilisateur dépose dans ce dossier,
//    à la main ou par sa synchronisation, est donc listé aussi — pruneAutoBackups, lui, n'y touche jamais).

export interface BackupFileInfo {
	path: string;
	name: string;
	// Date de modification du fichier (ms) : repli quand le nom ne porte pas de date.
	mtime: number;
	size: number;
}

export type BackupKind = "automatic" | "manual";

export interface BackupListItem extends BackupFileInfo {
	kind: BackupKind;
	// « 2026-10-05 », lue dans le nom du fichier (plus fiable que mtime, que la synchronisation d'un coffre réécrit) ;
	// à défaut, la date de modification.
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

// Les sauvegardes reconnues, la plus récente d'abord (date, puis heure de modification, puis nom : deux sauvegardes du même jour,
// l'automatique et un export manuel, restent dans un ordre stable).
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
