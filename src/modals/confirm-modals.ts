import { Modal, App } from "obsidian";
import { BackupSummary } from "../core/data-model";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Restore backup confirmation modal                                        */
/* -------------------------------------------------------------------------- */
// Confirmation before a backup restore (see "Restore backup" in setting-tab.ts
// and MTGCollectionPlugin.restoreBackup) — an operation far more destructive
// than a simple "Clear collection" (replaces collection AND decks AND
// wantlists AND settings all at once), hence a real confirmation window with
// the detail of what will be overwritten, not just an immediate click. Same
// template as AddAllConfirmModal (add-cards-modal.ts): title + paragraph(s) +
// a pair of buttons in .mtg-card-detail-actions — no native window.confirm(),
// never used in this plugin.

export class RestoreBackupConfirmModal extends Modal {
	constructor(app: App, private summary: BackupSummary, private onConfirm: () => void | Promise<void>) {
		super(app);
	}

	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-list-actions-modal");
		contentEl.createEl("h2", { text: "Restore this backup?" });

		const dateText = this.summary.exportedAt
			? ` (exported ${new Date(this.summary.exportedAt).toLocaleString()})`
			: "";
		contentEl.createEl("p", {
			cls: "mtg-status",
			text: `This backup${dateText} contains ${this.summary.cards} card(s) across ${this.summary.lists} list(s), ${this.summary.decks} deck(s), and ${this.summary.wantlistItems} wantlist item(s) across ${this.summary.wantlists} wantlist(s).`,
		});
		contentEl.createEl("p", {
			cls: "mtg-add-all-warning",
			text: "Restoring will completely replace your current collection, decks, wantlists, and settings with what's in this file. This cannot be undone — make sure this is really what you want before continuing.",
		});

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const confirmBtn = actions.createEl("button", { cls: "mtg-search-add-btn", text: "Yes, restore" });
		confirmBtn.addEventListener("click", () => {
			void this.onConfirm();
			this.close();
		});
		// Neutral button, with no particular class — same default style as the
		// "Cancel" of AddAllConfirmModal/ChangePrintingModal.
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
/* -------------------------------------------------------------------------- */
/*  Clear all data confirmation modal                                        */
/* -------------------------------------------------------------------------- */
// Confirmation before "Clear all data" (setting-tab.ts) — bug + request
// reported together: the button acted immediately without any confirmation,
// and did not refresh the already-open views (fixed separately in
// setting-tab.ts, via refreshOpenViews()). Widened the same day from "Clear
// collection" (cards + lists only) to "Clear all data" — explicitly
// requested ("also delete everything that's in wantlist and decks"): also
// erases settings.decks/wantlist/wantlists, not only collection/lists. Same
// template as RestoreBackupConfirmModal above: title + numeric summary +
// warning + pair of buttons — no native window.confirm(), never used in this
// plugin. Red confirmation button (.mtg-modal-danger-btn) rather than
// accent-colored like the other confirmations in this file: unlike "Add
// all"/"Restore a backup" (wanted actions, just to be confirmed),
// irreversibly erasing all the data is a destructive action in its own
// right, which deserves the same "danger" visual language as the Delete
// button of the bulk-actions bar elsewhere in this plugin.

export class ClearAllDataConfirmModal extends Modal {
	constructor(
		app: App,
		private cardCount: number,
		private listCount: number,
		private deckCount: number,
		private wantlistItemCount: number,
		private wantlistCount: number,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-list-actions-modal");
		contentEl.createEl("h2", { text: "Clear all your data?" });
		contentEl.createEl("p", {
			cls: "mtg-status",
			text: `This will permanently delete ${this.cardCount} card(s) across ${this.listCount} list(s), ${this.deckCount} deck(s), and ${this.wantlistItemCount} wantlist item(s) across ${this.wantlistCount} wantlist(s).`,
		});
		contentEl.createEl("p", {
			cls: "mtg-add-all-warning",
			text: "This cannot be undone.",
		});

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const confirmBtn = actions.createEl("button", { cls: "mtg-modal-danger-btn", text: "Yes, clear everything" });
		confirmBtn.addEventListener("click", () => {
			void this.onConfirm();
			this.close();
		});
		// Neutral button, with no particular class — same default style as the
		// "Cancel" of AddAllConfirmModal/RestoreBackupConfirmModal.
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
