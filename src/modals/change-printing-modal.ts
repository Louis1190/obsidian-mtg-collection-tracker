import { App, Modal, Notice } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { ScryfallCard, searchAllPrintings } from "../api/scryfall";
import type { DeckCardCategory } from "../core/data-model";
import { setupResultsCarousel, renderScryfallResultTile } from "./shared-search-ui";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Change printing modal (pick a different set/number for a card already    */
/*  in the collection)                                                       */
/* -------------------------------------------------------------------------- */

export class ChangePrintingModal extends Modal {
	private plugin: MTGCollectionPlugin;
	// `scry` optionnel reçu par le rappelant — nécessaire pour le flux Deck
	// uniquement (voir AddCardsModal.openChangePrintingForEntry) : contrairement
	// à changeCollectionCardPrinting/changeWantlistCardPrinting (jamais de fusion,
	// mutent toujours la même ligne en place), changeDeckCardPrinting
	// (plugin.ts) peut fusionner avec une ligne déjà présente pour la même
	// impression dans ce deck — la ligne d'origine que l'appelant connaissait
	// peut donc avoir disparu, et seul le NOUVEAU scryfallId (`scry.id`) reste
	// une clé fiable pour la retrouver après coup. Un rappelant qui n'en a pas
	// besoin (Collection/Wantlist, tous deux passés par une fonction ()=>{})
	// reste valide tel quel — une fonction à 0 paramètre est assignable à ce
	// type, TypeScript/JS l'appellent simplement avec un argument ignoré.
	private onChanged: (scry?: ScryfallCard) => void;
	// `id` optionnel : DeckCard n'a pas de champ id propre (voir "Data model
	// notes" dans CLAUDE.md) — inutilisé quand source === "deck", auquel cas
	// deckContext (scryfallId + catégorie) sert de clé à la place, voir
	// changeDeckCardPrinting (plugin.ts).
	private card: { id?: string; name: string; scryfallId: string };
	// Distingue quelle méthode plugin appeler (les trois ne touchent pas le
	// même tableau — collection/wantlist/decks) sans dupliquer toute la modale.
	private source: "collection" | "wantlist" | "deck";
	private deckContext?: { deckId: string; category: DeckCardCategory };
	private allPrintings: ScryfallCard[] = [];
	private resultsEl!: HTMLElement;
	private searchInput!: HTMLInputElement;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		card: { id?: string; name: string; scryfallId: string },
		onChanged: (scry?: ScryfallCard) => void,
		source: "collection" | "wantlist" | "deck" = "collection",
		deckContext?: { deckId: string; category: DeckCardCategory }
	) {
		super(app);
		this.plugin = plugin;
		this.card = card;
		this.onChanged = onChanged;
		this.source = source;
		this.deckContext = deckContext;
	}

	async onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-search-modal");
		this.modalEl.addClass("mtg-search-modal-wide");
		contentEl.createEl("h2", { text: `Change printing of "${this.card.name}"` });
		contentEl.createEl("p", {
			text: "Pick the exact edition this physical card belongs to.",
			cls: "mtg-status",
		});

		this.resultsEl = setupResultsCarousel(contentEl);
		this.resultsEl.createEl("p", { text: "Loading printings…", cls: "mtg-status" });

		const form = contentEl.createDiv({ cls: "mtg-search-form" });
		const searchField = form.createDiv({ cls: "mtg-search-field" });
		searchField.createEl("label", { text: "Search" });
		this.searchInput = searchField.createEl("input", {
			type: "text",
			attr: { placeholder: "Filter by edition name or code…" },
		});
		this.searchInput.addEventListener("input", () => this.renderFiltered());

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		try {
			this.allPrintings = await searchAllPrintings(this.card.name);
		} catch (e) {
			this.resultsEl.empty();
			this.resultsEl.createEl("p", {
				text: `Error while querying Scryfall: ${(e as Error).message}`,
				cls: "mtg-status mtg-error",
			});
			return;
		}
		this.renderFiltered();
	}

	// Filtre côté client (pas une nouvelle requête Scryfall) : this.allPrintings
	// est déjà l'ensemble fermé des impressions de cette carte précise, donc un
	// simple filtre texte sur nom/code d'édition ou numéro suffit — pas besoin
	// de la barre de puces complète de AddCardsModal, faite pour interroger
	// tout Scryfall.
	private renderFiltered() {
		const q = this.searchInput.value.trim().toLowerCase();
		const filtered = q
			? this.allPrintings.filter(
					(s) =>
						s.set_name.toLowerCase().includes(q) ||
						s.set.toLowerCase().includes(q) ||
						s.collector_number.toLowerCase().includes(q)
			  )
			: this.allPrintings;

		this.resultsEl.empty();
		if (filtered.length === 0) {
			this.resultsEl.createEl("p", { text: "No printings found.", cls: "mtg-status" });
			return;
		}
		filtered.forEach((scry) => this.renderPrintingTile(scry));
	}

	private renderPrintingTile(scry: ScryfallCard) {
		const isCurrent = scry.id === this.card.scryfallId;
		const tile = renderScryfallResultTile(
			this.plugin,
			this.resultsEl,
			scry,
			(el) => {
				// Doit passer par ce même conteneur intermédiaire que
				// renderAddControl (add-cards-modal.ts) — .mtg-result-card-add-btn a
				// height:100%, pensé pour se caler sur le height:1.9em fixe de
				// .mtg-result-card-add-control. Sans ce wrapper, le bouton devient
				// lui-même un enfant flex direct de la tuile (flex-direction:
				// column) et son height:100% se résout contre la hauteur de LA
				// TUILE elle-même (étirée par align-items:stretch sur la piste du
				// carrousel) au lieu de 1.9em — bug rapporté avec capture d'écran,
				// bouton "Select"/"Current" démesurément grand.
				const control = el.createDiv({ cls: "mtg-result-card-add-control" });
				const selectBtn = control.createEl("button", {
					cls: "mtg-result-card-add-btn",
					text: isCurrent ? "Current" : "Select",
				});
				selectBtn.disabled = isCurrent;
				selectBtn.addEventListener("click", () => {
					if (this.source === "wantlist") {
						this.plugin.changeWantlistCardPrinting(this.card.id!, scry);
					} else if (this.source === "deck" && this.deckContext) {
						this.plugin.changeDeckCardPrinting(
							this.deckContext.deckId,
							this.card.scryfallId,
							this.deckContext.category,
							scry
						);
					} else {
						this.plugin.changeCollectionCardPrinting(this.card.id!, scry);
					}
					new Notice(`Now: ${scry.set_name}.`);
					this.close();
					this.onChanged(scry);
				});
			},
			scry.set_name
		);
		if (isCurrent) tile.addClass("mtg-result-card-tile-current");
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
