import { App, Modal, Notice } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { Deck, CollectionList, Wantlist } from "../core/data-model";
import { LEGALITY_SEARCH_FORMATS } from "../core/card-search";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import { ImportProgressModal, DecklistImportResultModal } from "./import-progress-modal";

/* -------------------------------------------------------------------------- */
/*  New deck modal                                                            */
/* -------------------------------------------------------------------------- */

export class NewDeckModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private onCreated: (deck: Deck) => void;

	constructor(app: App, plugin: MTGCollectionPlugin, onCreated: (deck: Deck) => void) {
		super(app);
		this.plugin = plugin;
		this.onCreated = onCreated;
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-new-deck-modal");
		this.contentEl.createEl("h2", { text: "New deck" });
		const input = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Deck name",
		});
		input.focus();

		// Format — reuses LEGALITY_SEARCH_FORMATS (card-search.ts, already used by
		// the "legal:"/"banned:"/"restricted:" search and by the detail sheets'
		// "Legal Formats" block) rather than a 2nd list: same vocabulary of
		// formats everywhere in the plugin. "None" at the head = no format chosen
		// (Deck.format stays undefined) — then enables neither the display of the
		// format nor the per-card legality badge (see deckLegalityBadge,
		// card-search.ts). Editable afterwards from "Deck settings"
		// (DeckSettingsModal, deck-settings-modal.ts).
		const formatField = this.contentEl.createDiv({ cls: "mtg-search-field" });
		formatField.createEl("label", { text: "Format (optional)" });
		const formatSelect = formatField.createEl("select");
		formatSelect.createEl("option", { text: "None", value: "" });
		LEGALITY_SEARCH_FORMATS.forEach((f) =>
			formatSelect.createEl("option", { text: f.label, value: f.key })
		);

		// Decklist import — see MTGCollectionPlugin.importDecklistToDeck and
		// decklist-import.ts (parseDecklistText) for the detail of the accepted
		// format. Optional: an empty deck is still created normally if this field
		// is left empty.
		const decklistField = this.contentEl.createDiv({ cls: "mtg-search-field" });
		decklistField.createEl("label", { text: "Paste a decklist (optional)" });
		const decklistTextarea = decklistField.createEl("textarea", {
			cls: "mtg-decklist-textarea",
			placeholder:
				'Paste a decklist from Moxfield, Archidekt, or plain text — one card per line ' +
				'(e.g. "1 Sol Ring"). Section headers like "Commander"/"Sideboard" are recognized.',
		});

		const create = () => {
			const name = input.value.trim();
			if (!name) return;
			const format = formatSelect.value || undefined;
			const deck = this.plugin.createDeck(name, format);
			this.close();
			this.onCreated(deck);

			const decklistText = decklistTextarea.value.trim();
			if (decklistText) this.importDecklist(deck, decklistText);
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") create();
		});

		const actions = this.contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const createBtn = actions.createEl("button", {
			text: "Create",
			cls: "mtg-search-add-btn",
		});
		// Disabled as long as no name is entered — avoids a silent click that does
		// nothing (previous behavior: create() just did an early return, with no
		// visual feedback).
		createBtn.disabled = true;
		input.addEventListener("input", () => {
			createBtn.disabled = !input.value.trim();
		});
		createBtn.addEventListener("click", create);
		// mtg-modal-cancel-btn: same template as .mtg-search-add-btn
		// (height/padding) but without its accent fill — explicitly requested so
		// that "Cancel" is the same size as "Create" instead of looking smaller
		// with Obsidian's native button style.
		const cancelBtn = actions.createEl("button", {
			text: "Cancel",
			cls: "mtg-modal-cancel-btn",
		});
		cancelBtn.addEventListener("click", () => this.close());
	}

	// The deck already exists (created by create() just before) — this part is a
	// background enrichment, not a condition for creating the deck itself. Same scheme
	// as triggerImportCollection/triggerImportWantlist (view.ts) for the CSV import:
	// an ImportProgressModal for progress, reused here with a dedicated title rather
	// than a 2nd near-identical progress window (see ImportProgressModal,
	// import-progress-modal.ts).
	private importDecklist(deck: Deck, text: string) {
		const modal = new ImportProgressModal(this.app, `Importing decklist into "${deck.name}"…`);
		modal.open();
		this.plugin
			.importDecklistToDeck(deck.id, text, (msg) => modal.setStatus(msg))
			.then((result) => {
				const unresolvedMsg =
					result.unresolved.length > 0 ? `, ${result.unresolved.length} not found` : "";
				modal.setStatus(`Done: ${result.added} added${unresolvedMsg}.`);
				new Notice(`Decklist import complete: ${result.added} added${unresolvedMsg}.`);
				// Only opens the detailed report if there is really something to examine
				// beyond the Notice above — no need to impose a 2nd window when everything
				// was resolved.
				if (result.unresolved.length > 0) {
					new DecklistImportResultModal(this.app, deck.name, result.added, result.unresolved).open();
				}
			})
			.catch((e) => {
				modal.setStatus(`Error: ${(e as Error).message}`);
			});
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/*  New list modal                                                            */
/* -------------------------------------------------------------------------- */

export class NewListModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private onCreated: (list: CollectionList) => void;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		onCreated: (list: CollectionList) => void
	) {
		super(app);
		this.plugin = plugin;
		this.onCreated = onCreated;
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-new-deck-modal");
		this.contentEl.createEl("h2", { text: "New list" });
		const input = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "List name",
		});
		input.focus();

		const create = () => {
			const name = input.value.trim();
			if (!name) return;
			const list = this.plugin.createList(name);
			this.close();
			this.onCreated(list);
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") create();
		});

		const actions = this.contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const createBtn = actions.createEl("button", {
			text: "Create",
			cls: "mtg-search-add-btn",
		});
		// Disabled as long as no name is entered — avoids a silent click that does
		// nothing (previous behavior: create() just did an early return, with no
		// visual feedback).
		createBtn.disabled = true;
		input.addEventListener("input", () => {
			createBtn.disabled = !input.value.trim();
		});
		createBtn.addEventListener("click", create);
		// mtg-modal-cancel-btn: same template as .mtg-search-add-btn
		// (height/padding) but without its accent fill — explicitly requested so
		// that "Cancel" is the same size as "Create" instead of looking smaller
		// with Obsidian's native button style.
		const cancelBtn = actions.createEl("button", {
			text: "Cancel",
			cls: "mtg-modal-cancel-btn",
		});
		cancelBtn.addEventListener("click", () => this.close());
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class NewWantlistModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private onCreated: (wantlist: Wantlist) => void;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		onCreated: (wantlist: Wantlist) => void
	) {
		super(app);
		this.plugin = plugin;
		this.onCreated = onCreated;
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-new-deck-modal");
		this.contentEl.createEl("h2", { text: "New wantlist" });
		const input = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Wantlist name",
		});
		input.focus();

		const create = () => {
			const name = input.value.trim();
			if (!name) return;
			const wantlist = this.plugin.createWantlist(name);
			this.close();
			this.onCreated(wantlist);
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") create();
		});

		const actions = this.contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const createBtn = actions.createEl("button", {
			text: "Create",
			cls: "mtg-search-add-btn",
		});
		// Disabled as long as no name is entered — avoids a silent click that does
		// nothing (previous behavior: create() just did an early return, with no
		// visual feedback).
		createBtn.disabled = true;
		input.addEventListener("input", () => {
			createBtn.disabled = !input.value.trim();
		});
		createBtn.addEventListener("click", create);
		// mtg-modal-cancel-btn: same template as .mtg-search-add-btn
		// (height/padding) but without its accent fill — explicitly requested so
		// that "Cancel" is the same size as "Create" instead of looking smaller
		// with Obsidian's native button style.
		const cancelBtn = actions.createEl("button", {
			text: "Cancel",
			cls: "mtg-modal-cancel-btn",
		});
		cancelBtn.addEventListener("click", () => this.close());
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
