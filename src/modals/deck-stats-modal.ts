import { App, Modal } from "obsidian";
import type { Deck } from "../core/data-model";
import { cardsInDeckStatsScope, computeColorBreakdown, computeManaCurve, computeTypeBreakdown } from "../core/deck-stats";
import { renderColorPieChart, renderManaCurveChart, renderTypeBarChart } from "../ui/deck-stats-fx";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  "Deck Stats" (2026-09-02) — mana curve/couleurs/types d'UN deck ouvert.   */
/*  Une modale, pas un mode d'affichage : un premier essai en 5e bouton du   */
/*  cluster liste/grille/tableau/carte (voir CardViewMode, git history) a    */
/*  été demandé explicitement en retour à cette forme-ci — même trio         */
/*  cardsInDeckStatsScope/computeManaCurve/computeColorBreakdown/            */
/*  computeTypeBreakdown (core/deck-stats.ts) et même dessin de graphiques   */
/*  (ui/deck-stats-fx.ts), tous les deux déjà purs/testés et donc réutilisés */
/*  ici tels quels — seule la façon de les afficher a changé. Pas d'état qui */
/*  change après ouverture (contrairement au bloc "Market Trends" du        */
/*  dashboard Home, qui a des onglets période/vendeur — home-render.ts) :    */
/*  tout est construit une seule fois dans onOpen(), pas de draw() séparé   */
/*  à rappeler.                                                             */
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
