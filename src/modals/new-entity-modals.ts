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
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-new-deck-modal");
		this.contentEl.createEl("h2", { text: "New deck" });
		const input = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Deck name",
		});
		input.focus();

		// Format — réutilise LEGALITY_SEARCH_FORMATS (card-search.ts, déjà
		// utilisée par la recherche "legal:"/"banned:"/"restricted:" et par le
		// bloc "Legal Formats" des fiches détail) plutôt qu'une 2ᵉ liste : même
		// vocabulaire de formats partout dans le plugin. "None" en tête = pas de
		// format choisi (Deck.format reste undefined) — n'active alors ni
		// l'affichage du format ni le badge de légalité par carte (voir
		// deckLegalityBadge, card-search.ts). Modifiable après coup depuis
		// "Deck settings" (DeckSettingsModal, deck-settings-modal.ts).
		const formatField = this.contentEl.createDiv({ cls: "mtg-search-field" });
		formatField.createEl("label", { text: "Format (optional)" });
		const formatSelect = formatField.createEl("select");
		formatSelect.createEl("option", { text: "None", value: "" });
		LEGALITY_SEARCH_FORMATS.forEach((f) =>
			formatSelect.createEl("option", { text: f.label, value: f.key })
		);

		// Import de decklist — voir MTGCollectionPlugin.importDecklistToDeck et
		// decklist-import.ts (parseDecklistText) pour le détail du format
		// accepté. Facultatif : un deck vide reste créé normalement si ce champ
		// est laissé vide.
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
		// Désactivé tant qu'aucun nom n'est saisi — évite un clic silencieux qui
		// ne fait rien (comportement précédent : create() faisait juste un early
		// return, sans aucun retour visuel).
		createBtn.disabled = true;
		input.addEventListener("input", () => {
			createBtn.disabled = !input.value.trim();
		});
		createBtn.addEventListener("click", create);
		// mtg-modal-cancel-btn : même gabarit que .mtg-search-add-btn (hauteur/
		// padding) mais sans son remplissage accent — demandé explicitement pour
		// que "Cancel" fasse la même taille que "Create" au lieu de paraître
		// plus petit avec le style de bouton natif d'Obsidian.
		const cancelBtn = actions.createEl("button", {
			text: "Cancel",
			cls: "mtg-modal-cancel-btn",
		});
		cancelBtn.addEventListener("click", () => this.close());
	}

	// Le deck existe déjà (créé par create() juste avant) — cette partie est
	// un enrichissement en arrière-plan, pas une condition à la création du
	// deck lui-même. Même schéma que triggerImportCollection/triggerImportWantlist
	// (view.ts) pour l'import CSV : une ImportProgressModal de progression, réutilisée
	// ici avec un titre dédié plutôt qu'une 2ᵉ fenêtre de progression quasi
	// identique (voir ImportProgressModal, import-progress-modal.ts).
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
				// N'ouvre le rapport détaillé que s'il y a vraiment quelque chose
				// à examiner au-delà du Notice ci-dessus — pas la peine d'imposer
				// une 2ᵉ fenêtre quand tout a été résolu.
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
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
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
		// Désactivé tant qu'aucun nom n'est saisi — évite un clic silencieux qui
		// ne fait rien (comportement précédent : create() faisait juste un early
		// return, sans aucun retour visuel).
		createBtn.disabled = true;
		input.addEventListener("input", () => {
			createBtn.disabled = !input.value.trim();
		});
		createBtn.addEventListener("click", create);
		// mtg-modal-cancel-btn : même gabarit que .mtg-search-add-btn (hauteur/
		// padding) mais sans son remplissage accent — demandé explicitement pour
		// que "Cancel" fasse la même taille que "Create" au lieu de paraître
		// plus petit avec le style de bouton natif d'Obsidian.
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
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
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
		// Désactivé tant qu'aucun nom n'est saisi — évite un clic silencieux qui
		// ne fait rien (comportement précédent : create() faisait juste un early
		// return, sans aucun retour visuel).
		createBtn.disabled = true;
		input.addEventListener("input", () => {
			createBtn.disabled = !input.value.trim();
		});
		createBtn.addEventListener("click", create);
		// mtg-modal-cancel-btn : même gabarit que .mtg-search-add-btn (hauteur/
		// padding) mais sans son remplissage accent — demandé explicitement pour
		// que "Cancel" fasse la même taille que "Create" au lieu de paraître
		// plus petit avec le style de bouton natif d'Obsidian.
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
