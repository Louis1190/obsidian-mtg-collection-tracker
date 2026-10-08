import { App, Modal } from "obsidian";
import type { Deck } from "../core/data-model";
import { cardsInDeckStatsScope, computeColorBreakdown, computeManaCurve, computeTypeBreakdown } from "../core/deck-stats";
import { renderColorPieChart, renderManaCurveChart, renderTypeBarChart } from "../ui/deck-stats-fx";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/* "Deck Stats" (2026-09-02) — mana curve/colors/types of ONE open deck. A */
/* modal, not a display mode: a first attempt as a 5th button of the */
/* list/grid/table/card cluster (see CardViewMode, git history) was */
/* explicitly asked to be returned to this form — same */
/* cardsInDeckStatsScope/computeManaCurve/computeColorBreakdown/computeTypeBreakdown */
/* trio (core/deck-stats.ts) and same chart drawing (ui/deck-stats-fx.ts), */
/* both already pure/tested and therefore reused here as is — only the way to */
/* display them changed. No state that changes after opening (unlike the */
/* "Market Trends" block of the Home dashboard, which has period/vendor tabs */
/* — home-render.ts): everything is built only once in onOpen(), no separate */
/* draw() to call again. */
/* -------------------------------------------------------------------------- */

export class DeckStatsModal extends Modal {
	private deck: Deck;

	constructor(app: App, deck: Deck) {
		super(app);
		this.deck = deck;
	}

	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-deck-stats-modal");

		this.contentEl.createEl("h2", { text: `${this.deck.name} — Stats`, cls: "mtg-deck-stats-modal-title" });

		const scoped = cardsInDeckStatsScope(this.deck.cards);
		if (scoped.length === 0) {
			this.contentEl.createEl("p", {
				cls: "mtg-status",
				text: 'This deck is empty. Use "+ Add cards" to see statistics.',
			});
			return;
		}

		const container = this.contentEl.createDiv({ cls: "mtg-deck-stats" });
		renderManaCurveChart(container.createDiv({ cls: "mtg-deck-stats-section" }), computeManaCurve(scoped));
		renderColorPieChart(container.createDiv({ cls: "mtg-deck-stats-section" }), computeColorBreakdown(scoped));
		renderTypeBarChart(container.createDiv({ cls: "mtg-deck-stats-section" }), computeTypeBreakdown(scoped));
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
