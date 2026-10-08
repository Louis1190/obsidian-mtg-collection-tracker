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
	// Optional `scry` received by the caller — needed for the Deck flow only (see
	// AddCardsModal.openChangePrintingForEntry): unlike
	// changeCollectionCardPrinting/changeWantlistCardPrinting (never merge, always
	// mutate the same row in place), changeDeckCardPrinting (plugin.ts) can merge
	// with a row already present for the same printing in this deck — the original
	// row the caller knew may therefore have disappeared, and only the NEW
	// scryfallId (`scry.id`) remains a reliable key to find it afterwards. A
	// caller that doesn't need it (Collection/Wantlist, both passing a ()=>{}
	// function) remains valid as is — a function with 0 parameters is assignable
	// to this type, TypeScript/JS simply call it with an ignored argument.
	private onChanged: (scry?: ScryfallCard) => void;
	// Optional `id`: DeckCard has no id field of its own (see "Data model
	// notes" in CLAUDE.md) — unused when source === "deck", in which case
	// deckContext (scryfallId + category) serves as the key instead, see
	// changeDeckCardPrinting (plugin.ts).
	private card: { id?: string; name: string; scryfallId: string };
	// Distinguishes which plugin method to call (the three don't touch the same
	// array — collection/wantlist/decks) without duplicating the whole modal.
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
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
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

	// Client-side filter (not a new Scryfall request): this.allPrintings is
	// already the closed set of printings of this specific card, so a simple
	// text filter on name/set code or number is enough — no need for
	// AddCardsModal's full chip bar, made to query all of Scryfall.
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
				// Must go through this same intermediate container as renderAddControl
				// (add-cards-modal.ts) — .mtg-result-card-add-btn has height:100%,
				// designed to settle on the fixed height:1.9em of
				// .mtg-result-card-add-control. Without this wrapper, the button itself
				// becomes a direct flex child of the tile (flex-direction: column) and its
				// height:100% resolves against the height of THE TILE itself (stretched by
				// align-items:stretch on the carousel track) instead of 1.9em — bug
				// reported with a screenshot, "Select"/"Current" button disproportionately
				// large.
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
