import { Modal, App } from "obsidian";
import { BackupListItem, formatFileSize } from "../core/backup-files";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Restore from a saved backup (the backup folder of the vault)             */
/* -------------------------------------------------------------------------- */
// « Restore backup → Choose a saved backup… » (setting-tab.ts) : la liste des sauvegardes trouvées dans le dossier des
// sauvegardes du coffre (core/backup-files.ts les reconnaît et les ordonne, plugin/backup.ts les lit par l'API Vault). Choisir
// une ligne rend la main à l'appelant, qui lit le fichier et ouvre RestoreBackupConfirmModal (confirm-modals.ts) : le résumé de
// ce que contient la sauvegarde s'affiche là, avant que quoi que ce soit change. Aucun sélecteur de fichier du système :
// fonctionne à l'identique sur ordinateur, iPhone/iPad et Android. Un fichier hors de ce dossier passe par « Load backup file… ».

export class RestoreBackupModal extends Modal {
	constructor(
		app: App,
		private folder: string,
		private backups: BackupListItem[],
		private onPick: (backup: BackupListItem) => void
	) {
		super(app);
	}

	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-list-actions-modal");
		contentEl.createEl("h2", { text: "Choose a saved backup" });

		if (this.backups.length === 0) {
			contentEl.createEl("p", {
				cls: "mtg-status",
				text: `No backup found in "${this.folder}". Automatic backups are written there once they are turned on (Settings → Backup). For a backup file stored somewhere else, use "Load backup file…".`,
			});
		} else {
			contentEl.createEl("p", {
				cls: "mtg-status",
				text: `Backups found in "${this.folder}", newest first. You will see what a backup contains before anything is replaced.`,
			});
			const list = contentEl.createDiv({ cls: "mtg-restore-backup-list" });
			for (const backup of this.backups) {
				const row = list.createEl("button", { cls: "mtg-restore-backup-item" });
				row.createSpan({ cls: "mtg-restore-backup-date", text: backup.date });
				row.createSpan({ cls: "mtg-restore-backup-kind", text: backup.kind === "automatic" ? "Automatic backup" : "Manual export" });
				row.createSpan({ cls: "mtg-restore-backup-size", text: formatFileSize(backup.size) });
				row.addEventListener("click", () => {
					this.close();
					this.onPick(backup);
				});
			}
		}

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
