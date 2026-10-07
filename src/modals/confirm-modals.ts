import { Modal, App } from "obsidian";
import { BackupSummary } from "../core/data-model";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Restore backup confirmation modal                                        */
/* -------------------------------------------------------------------------- */
// Confirmation avant une restauration de sauvegarde (voir "Restore backup"
// dans setting-tab.ts et MTGCollectionPlugin.restoreBackup) — une opération
// bien plus destructive qu'un simple "Clear collection" (remplace collection
// ET decks ET wantlists ET réglages d'un coup), donc une vraie fenêtre de
// confirmation avec le détail de ce qui va être écrasé, pas juste un clic
// immédiat. Même gabarit que AddAllConfirmModal (add-cards-modal.ts) : titre +
// paragraphe(s) + une paire de boutons dans .mtg-card-detail-actions — pas
// de window.confirm() natif, jamais utilisé dans ce plugin.

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
		// Bouton neutre, sans classe particulière — même style par défaut que le
		// "Cancel" d'AddAllConfirmModal/ChangePrintingModal.
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
// Confirmation avant "Clear all data" (setting-tab.ts) — bug + demande
// rapportés ensemble : le bouton agissait immédiatement sans aucune
// confirmation, et ne rafraîchissait pas les vues déjà ouvertes (corrigé
// séparément dans setting-tab.ts, via refreshOpenViews()). Élargi le jour
// même de "Clear collection" (cartes + listes seulement) à "Clear all
// data" — demandé explicitement ("supprime également tout ce qui est dans
// wantlist et decks") : efface aussi settings.decks/wantlist/wantlists,
// pas seulement collection/lists. Même gabarit que
// RestoreBackupConfirmModal ci-dessus : titre + récapitulatif chiffré +
// avertissement + paire de boutons — pas de window.confirm() natif, jamais
// utilisé dans ce plugin. Bouton de confirmation en rouge
// (.mtg-modal-danger-btn) plutôt qu'accent-coloré comme les autres
// confirmations de ce fichier : contrairement à "Add all"/"Restore a
// backup" (des actions voulues, juste à confirmer), effacer irréversiblement
// toutes les données est une action destructive à part entière, qui
// mérite le même langage visuel "danger" que le bouton Delete de la barre
// d'actions groupées ailleurs dans ce plugin.

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
		// Bouton neutre, sans classe particulière — même style par défaut que le
		// "Cancel" d'AddAllConfirmModal/RestoreBackupConfirmModal.
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
