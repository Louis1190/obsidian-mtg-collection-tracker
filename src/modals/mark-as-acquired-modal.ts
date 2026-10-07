import { Modal, App, Notice } from "obsidian";
import { CONDITIONS, LANGUAGES } from "../core/card-model";
import type MTGCollectionPlugin from "../plugin";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";
import type { MTGCollectionView } from "../view";

/* -------------------------------------------------------------------------- */
/*  Mark as acquired modal (wantlist -> collection transfer)                 */
/* -------------------------------------------------------------------------- */

export class MarkAsAcquiredModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private wantlistCardIds: string[];

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, wantlistCardIds: string[]) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.wantlistCardIds = wantlistCardIds;
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-list-actions-modal");
		const count = this.wantlistCardIds.length;
		contentEl.createEl("h2", {
			text: count === 1 ? "Mark as acquired" : `Mark ${count} cards as acquired`,
		});
		contentEl.createEl("p", {
			cls: "mtg-status",
			text: "Choose the collection list, condition, and language for the physical card(s) you now have. This removes the card(s) from the wantlist.",
		});

		const listField = contentEl.createDiv({ cls: "mtg-search-field" });
		listField.createEl("label", { text: "Add to list" });
		const listSelect = listField.createEl("select");
		this.plugin.settings.lists.forEach((l) =>
			listSelect.createEl("option", { text: l.name, value: l.id })
		);

		const optionsRow = contentEl.createDiv({ cls: "mtg-search-row" });

		const condField = optionsRow.createDiv({ cls: "mtg-search-field" });
		condField.createEl("label", { text: "Condition" });
		const conditionSelect = condField.createEl("select");
		CONDITIONS.forEach((c) =>
			conditionSelect.createEl("option", { text: c.label, value: c.value })
		);

		const langField = optionsRow.createDiv({ cls: "mtg-search-field" });
		langField.createEl("label", { text: "Language" });
		const languageSelect = langField.createEl("select");
		LANGUAGES.forEach((l) =>
			languageSelect.createEl("option", { text: l.label, value: l.code })
		);

		const confirmBtn = contentEl.createEl("button", {
			text: "✓ Mark as acquired",
			cls: "mtg-search-add-btn",
		});
		confirmBtn.addEventListener("click", () => {
			this.plugin.moveWantlistCardsToCollection(
				this.wantlistCardIds,
				listSelect.value,
				conditionSelect.value,
				languageSelect.value
			);
			new Notice(count === 1 ? "Marked as acquired." : `Marked ${count} card(s) as acquired.`);
			this.close();
			this.view.render();
		});
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
