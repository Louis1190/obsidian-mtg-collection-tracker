import { Modal, App, Notice } from "obsidian";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Import modal (CSV import progress)                                       */
/* -------------------------------------------------------------------------- */

export class ImportProgressModal extends Modal {
	private statusEl!: HTMLElement;
	// Configurable title — taken as is by the decklist import (see
	// NewDeckModal), which reuses this same progress window rather than
	// building a 2nd near-identical one. "Importing collection…" remains the
	// default value so as to change nothing for the existing CSV callers
	// (triggerImportCollection/triggerImportWantlist, view.ts).
	constructor(app: App, private title: string = "Importing collection…") {
		super(app);
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-import-modal");
		this.contentEl.createEl("h2", { text: this.title });
		this.statusEl = this.contentEl.createEl("p", {
			text: "Preparing…",
			cls: "mtg-status",
		});
	}

	setStatus(text: string) {
		this.statusEl.setText(text);
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
/* -------------------------------------------------------------------------- */
/*  Decklist import result modal                                             */
/* -------------------------------------------------------------------------- */
// Summary displayed after an import of a decklist pasted in NewDeckModal
// (see MTGCollectionPlugin.importDecklistToDeck) — only opens this window
// when there is something to show beyond the Notice already displayed by
// the caller (at least one unresolved line), see that call site. Same
// template as RestoreBackupConfirmModal (confirm-modals.ts) (title +
// paragraph(s) + buttons in .mtg-card-detail-actions) but purely
// informational: the import has already taken place by the time this window
// opens, nothing to confirm.

export class DecklistImportResultModal extends Modal {
	constructor(
		app: App,
		private deckName: string,
		private added: number,
		private unresolved: string[]
	) {
		super(app);
	}

	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-list-actions-modal");
		contentEl.createEl("h2", { text: "Decklist import" });
		contentEl.createEl("p", {
			cls: "mtg-status",
			text: `Added ${this.added} card(s) to "${this.deckName}".`,
		});
		contentEl.createEl("p", {
			cls: "mtg-status",
			text:
				this.unresolved.length === 1
					? "1 line could not be matched to a card on Scryfall:"
					: `${this.unresolved.length} lines could not be matched to a card on Scryfall:`,
		});
		const list = contentEl.createEl("ul", { cls: "mtg-decklist-unresolved-list" });
		this.unresolved.forEach((line) => list.createEl("li", { text: line }));

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		// navigator.clipboard.writeText: same precedent already established
		// elsewhere in this plugin (see copyListSelectionTxt, view.ts) — an
		// explicit .catch() rather than a resolution assumed to be systematic.
		const copyBtn = actions.createEl("button", { text: "Copy list" });
		copyBtn.addEventListener("click", () => {
			navigator.clipboard
				.writeText(this.unresolved.join("\n"))
				.then(() => new Notice("Copied to clipboard."))
				.catch(() => new Notice("Couldn't copy to clipboard."));
		});
		const closeBtn = actions.createEl("button", { text: "Close", cls: "mtg-search-add-btn" });
		closeBtn.addEventListener("click", () => this.close());
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
