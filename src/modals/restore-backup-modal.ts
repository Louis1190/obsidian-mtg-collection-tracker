import { Modal, App } from "obsidian";
import { BackupListItem, formatFileSize } from "../core/backup-files";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Restore from a saved backup (the backup folder of the vault)             */
/* -------------------------------------------------------------------------- */
// "Restore backup → Choose a saved backup…" (setting-tab.ts): the list of backups found in the vault's backup
// folder (core/backup-files.ts recognizes and orders them, plugin/backup.ts reads them through the Vault API).
// Choosing a row hands control back to the caller, which reads the file and opens RestoreBackupConfirmModal
// (confirm-modals.ts): the summary of what the backup contains is displayed there, before anything changes. No
// system file picker: works identically on computer, iPhone/iPad and Android. A file outside this folder goes
// through "Load backup file…".

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
