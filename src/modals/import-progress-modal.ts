import { Modal, App, Notice } from "obsidian";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Import modal (CSV import progress)                                       */
/* -------------------------------------------------------------------------- */

export class ImportProgressModal extends Modal {
	private statusEl!: HTMLElement;
	// Titre configurable — repris tel quel par l'import de decklist (voir
	// NewDeckModal), qui réutilise cette même fenêtre de progression plutôt
	// que d'en construire une 2ᵉ quasi identique. "Importing collection…"
	// reste la valeur par défaut pour ne rien changer aux appelants CSV
	// existants (triggerImportCollection/triggerImportWantlist, view.ts).
	constructor(app: App, private title: string = "Importing collection…") {
		super(app);
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
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
// Résumé affiché après un import de decklist collée dans NewDeckModal (voir
// MTGCollectionPlugin.importDecklistToDeck) — n'ouvre cette fenêtre que
// lorsqu'il y a quelque chose à montrer au-delà du Notice déjà affiché par
// l'appelant (au moins une ligne non résolue), voir ce call site. Même
// gabarit que RestoreBackupConfirmModal (confirm-modals.ts) (titre +
// paragraphe(s) + boutons dans .mtg-card-detail-actions) mais purement
// informatif : l'import a déjà eu lieu au moment où cette fenêtre s'ouvre,
// rien à confirmer.

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
		// navigator.clipboard.writeText : même précédent déjà établi ailleurs
		// dans ce plugin (voir copyListSelectionTxt, view.ts) — un .catch()
		// explicite plutôt qu'une résolution supposée systématique.
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
