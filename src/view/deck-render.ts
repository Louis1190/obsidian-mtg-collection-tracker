import { Notice, setIcon } from "obsidian";
import {
	FINISH_OPTIONS,
	getFinishLabel,
	finishHasFoilLook,
	LANGUAGES,
	getLanguage,
	languagePickerOptions,
	CONDITIONS,
	getCondition,
} from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { createConditionIcon, createFlagImg, createLanguageIcon } from "../ui/option-icons";
import { getRarityColor, applySvgColor, toCsvField } from "../api/scryfall";
import {
	viewModeClass,
	phoneAwareViewMode,
	TABLE_COLUMNS_DECK,
	DECK_GRID_SORT_OPTIONS,
	GROUP_LABEL_HEX,
	CardGroup,
	RENDER_BATCH_SIZE,
	sliceGroupsForRender,
	groupAndSortCards,
	deckColorIdentity,
	estimateStackColumnHeight,
	STACK_TRACK_MIN_WIDTH_PX,
	STACK_TRACK_GAP_PX,
} from "../core/card-sorting";
import {
	cardMatchesTokens,
	LEGALITY_SEARCH_FORMATS,
	deckLegalityBadge,
} from "../core/card-search";
import {
	formatCardPrice,
	cardValue,
	formatMoney,
	resolveDeckCoverImage,
	toDeckPricedCard,
} from "../core/price";
import {
	DeckCard,
	isDeckCardOwned,
	getDeckCardCategory,
	isDeckCommander,
	DECK_BOARD_TABS,
	deckBoardTabMatches,
	getDeckCardFinish,
	getDeckCardCondition,
	getDeckCardLanguage,
	getDeckCardFunction,
	Deck,
} from "../core/data-model";
import { DECK_FUNCTION_CATEGORIES } from "../core/deck-function";
import { formatCountTitle } from "../core/count-title";
import { ZipEntry } from "../core/zip";
import {
	renderLoadingDots,
	renderManaCostIcons,
	setupPanelScrollFade,
} from "../ui/card-detail-fx";
import { renderCardsCountTitle } from "./shared-render-helpers";
import { createBulkActionsBar, replaceInBulkBar } from "./bulk-actions-bar";
import { DeckSettingsModal } from "../modals/deck-settings-modal";
import { DeckCardDetailModal } from "../modals/deck-card-detail-modal";
import { DeckStatsModal } from "../modals/deck-stats-modal";
import { AddCardsModal } from "../modals/add-cards-modal";
import { ChangePrintingModal } from "../modals/change-printing-modal";
import { importCsvFile, importDecklistFile } from "./file-import";
import { CopyCardModal } from "../modals/copy-card-modal";
import type { MTGCollectionView } from "../view";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  My Decks: section/grid/detail rendering (incl. Stacks view + board
    tabs), row + tile building, bulk-actions bar, CSV/TXT export/import,
    deck open/close. Split out of view.ts on 2026-09-10 ("Phase 5b").  */
/* -------------------------------------------------------------------------- */

// Voir openCollectionCardDetailById (collection-render.ts)/openWantlistCardDetailById
// (wantlist-render.ts) — même
// raisonnement, côté deck (uniformisation demandée explicitement : la
// fenêtre "Add cards" du Deck n'avait jusqu'ici ni tuile cliquable une
// fois ajoutée, ni panneau d'historique, contrairement à My Collection/
// My Wantlists). Cherche la ligne par (deckId, scryfallId) plutôt que
// par un id de ligne propre : DeckCard n'en a pas (voir data-model.ts),
// scryfallId est déjà la clé qu'utilisent changeDeckCardCount/
// removeDeckCard/undoAddToDeck pour retrouver une ligne dans un deck
// donné. Publique depuis le 2026-09-08, même raison que ces deux
// méthodes ("Copies in Lists" cross-section).

export function openDeckCardDetailById(this: MTGCollectionView,
	deckId: string,
	scryfallId: string,
	onDetailClosed?: (row: { id: string; count: number } | undefined) => void
) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const card = deck.cards.find((c) => c.scryfallId === scryfallId);
	if (!card) return;
	const modal = new DeckCardDetailModal(this.app, this.plugin, this, deck, card, [card]);
	if (onDetailClosed) {
		const originalOnClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			originalOnClose();
			const freshDeck = this.plugin.settings.decks.find((d) => d.id === deckId);
			const freshRow = freshDeck?.cards.find((c) => c.scryfallId === scryfallId);
			// { id, count } — id = scryfallId ici (voir le commentaire de
			// openDeckCardDetailById ci-dessus), même convention que
			// syncFromHistory/onDetailClosed attendent déjà des 2 autres flux.
			onDetailClosed(freshRow ? { id: freshRow.scryfallId, count: freshRow.count } : undefined);
		};
	}
	modal.open();
}


// Onglets "board" (Mainboard/Sideboard/Maybeboard), sous la barre Group
// by/Sort by/modes d'affichage (renderGroupSortBar) — remplace l'ancien
// regroupement "Category" (retiré de DECK_GROUP_BY_OPTIONS, card-sorting.ts,
// sur demande explicite : "Commander n'est pas une catégorie"). S'applique
// dans TOUTES les vues (List/Grid/Table/Card/Stacks, pas juste Stacks) —
// filtre deck.cards AVANT le filtre texte/Group by/Sort by habituels côté
// appelant (renderDeckDetail), qui continuent de s'appliquer normalement
// À L'INTÉRIEUR de l'onglet actif (confirmé explicitement — l'onglet ne
// remplace pas le groupement, il filtre juste le sous-ensemble de cartes
// affiché). Chaque compteur compte les EXEMPLAIRES physiques (somme de
// count) sur l'ENSEMBLE du deck, pas le sous-ensemble déjà filtré par la
// recherche — cohérent avec le fait que les onglets restent une vue
// d'ensemble stable du deck, indépendante de ce qui est tapé dans la barre
// de recherche au-dessus. Prend toute la largeur de la fenêtre (3 onglets
// à `flex: 1` égal, voir .mtg-deck-board-tabs/-tab, styles.css) — demandé
// explicitement dans la même capture d'écran que le déplacement ci-dessus.

export function renderDeckBoardTabs(this: MTGCollectionView, deck: Deck, container: HTMLElement) {
	const tabs = container.createDiv({ cls: "mtg-deck-board-tabs" });
	// Racine du vrai bug derrière "toujours aussi abrupt" malgré deux
	// essais de durée/courbe CSS différentes : ces boutons sont recréés de
	// zéro à CHAQUE render() (voir render(), view.ts — this.bodyEl.
	// cloneNode(false), tout le sous-arbre reconstruit puis échangé via
	// replaceWith), et l'ancien click handler appelait this.render()
	// directement — le nouvel onglet actif naissait donc déjà avec
	// .is-active dès sa toute première peinture, jamais en train de
	// PASSER de gris à accent sur un nœud DOM existant. Aucune durée/
	// courbe de transition CSS ne peut jouer dans ce cas : "une classe
	// déjà présente au tout premier paint d'un élément ne déclenche
	// aucune transition, seul un changement de classe sur un élément
	// DÉJÀ EXISTANT le fait" (même principe déjà établi pour
	// legalFormatsShownFor/le bloc Graded, CardDetailModal). Fixé en
	// basculant .is-active directement sur les vrais nœuds déjà affichés
	// (qui, eux, restent en place le temps de la transition), puis en
	// différant le render() réel (nécessaire pour rafraîchir la liste de
	// cartes filtrée en dessous) jusqu'à ce que la transition CSS ait
	// fini de jouer — même idiome que le repli du bloc Graded/Custom
	// Price (CardDetailModal.close) ou toggleGroupRows (src/view/
	// shared-render-helpers.ts). this.deckActiveBoard reste la seule source de vérité :
	// un double-clic rapide entre deux onglets programme simplement
	// deux render() différés qui aboutissent tous les deux au même état
	// correct, sans jamais rien corrompre.
	const tabEls: HTMLElement[] = [];
	DECK_BOARD_TABS.forEach((tab) => {
		const count = deck.cards
			.filter((c) => deckBoardTabMatches(c, tab.value))
			.reduce((s, c) => s + c.count, 0);
		const btn = tabs.createDiv({ cls: "mtg-deck-board-tab" });
		tabEls.push(btn);
		btn.toggleClass("is-active", this.deckActiveBoard === tab.value);
		btn.createSpan({ cls: "mtg-deck-board-tab-label", text: tab.label });
		btn.createSpan({ cls: "mtg-deck-board-tab-count", text: `(${count})` });
		btn.addEventListener("click", () => {
			if (this.deckActiveBoard === tab.value) return;
			tabEls.forEach((el) => el.removeClass("is-active"));
			btn.addClass("is-active");
			this.deckActiveBoard = tab.value;
			this.persistSortSettings();
			// 350ms = exactement la durée de la transition CSS déclarée sur
			// .mtg-deck-board-tab (styles.css) — laisse le fondu couleur
			// jouer jusqu'au bout avant que render() ne remplace ces nœuds.
			window.setTimeout(() => this.render(), 350);
		});
	});
}


export function renderDeckBulkActionsBar(this: MTGCollectionView, 
	container: HTMLElement,
	deckId: string,
	animate: boolean,
	visibleScryfallIds: string[]
) {
	const bar = createBulkActionsBar(this, "deck-cards", container, animate);

	bar.createSpan({
		cls: "mtg-bulk-actions-count",
		text: `${this.selectedDeckCardIds.size} selected`,
	});

	const selectionUtils = bar.createDiv({ cls: "mtg-bulk-selection-utils" });
	const selectAllBtn = selectionUtils.createEl("button", {
		text: "Select all",
		cls: "mtg-bulk-action-btn",
	});
	selectAllBtn.addEventListener("click", () => {
		visibleScryfallIds.forEach((id) => this.selectedDeckCardIds.add(id));
		this.render();
	});
	const clearBtn = selectionUtils.createEl("button", { text: "Clear", cls: "mtg-bulk-action-btn" });
	clearBtn.addEventListener("click", () => {
		this.selectedDeckCardIds.clear();
		this.render();
	});

	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	const selectedIds = () => Array.from(this.selectedDeckCardIds);
	// Clear inclus ici (comme My Collection) pour profiter du même bascule
	// disabled à 0 sélection que le reste ; Select all en reste
	// délibérément exclu, c'est justement le bouton utile quand rien n'est
	// encore sélectionné.
	const actionButtons: HTMLButtonElement[] = [clearBtn];

	// Déplacer/copier vers une liste, un deck ou une wantlist — même
	// CopyCardModal (sourceKind: "deck") que le bouton individuel "Deck"/
	// "Copy card to…" de DeckCardDetailModal, capable de prendre plusieurs
	// cartes à la fois exactement comme son homologue My Collection
	// (moveBtn/copyBtn dans renderCollectionBulkActionsBar, collection-render.ts). deckContext
	// fournit le deck de départ, nécessaire ici puisqu'une DeckCard n'a pas
	// d'id propre (voir CopyCardModal.deckContext).
	const moveBtn = bar.createEl("button", { text: "Move to", cls: "mtg-bulk-action-btn" });
	actionButtons.push(moveBtn);
	moveBtn.addEventListener("click", () => {
		const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
		const cards = (deck?.cards ?? []).filter((c) => this.selectedDeckCardIds.has(c.scryfallId));
		if (cards.length === 0) return;
		new CopyCardModal(
			this.app,
			this.plugin,
			cards,
			"deck",
			() => {
				// Les cartes ont quitté ce deck (déplacées ailleurs) — la
				// sélection ne pointe plus vers des lignes valides ici, même
				// comportement que "Move to" dans My Collection.
				this.selectedDeckCardIds.clear();
				this.render();
			},
			"move",
			{ deckId }
		).open();
	});

	// Copier ne retire rien du deck actuellement affiché, donc ne vide PAS
	// selectedDeckCardIds — même comportement que "Copy to" dans My
	// Collection.
	const copyBtn = bar.createEl("button", { text: "Copy to", cls: "mtg-bulk-action-btn" });
	actionButtons.push(copyBtn);
	copyBtn.addEventListener("click", () => {
		const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
		const cards = (deck?.cards ?? []).filter((c) => this.selectedDeckCardIds.has(c.scryfallId));
		if (cards.length === 0) return;
		new CopyCardModal(this.app, this.plugin, cards, "deck", () => this.render(), "copy", { deckId }).open();
	});

	// "Board" (Mainboard/Sideboard/Maybeboard) — même 3 options que le
	// picker "Board" de DeckCardDetailModal (DECK_BOARD_TABS), appliquées
	// à toute la sélection au lieu d'une carte à la fois.
	const boardBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	boardBtn.createSpan({ text: "Board" });
	setIcon(boardBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(boardBtn);
	boardBtn.addEventListener("click", () => {
		openPickerMenu(
			boardBtn,
			DECK_BOARD_TABS.map((tab) => ({
				render: (el) => el.createSpan({ text: tab.label }),
				onSelect: () => {
					this.plugin.bulkSetDeckCardCategory(deckId, selectedIds(), tab.value);
					new Notice(`Board set to ${tab.label}.`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// "Function" (Ramp/Removal/Draw/etc., voir DECK_FUNCTION_CATEGORIES) —
	// même picker que la boîte "Function" de DeckCardDetailModal, avec
	// "Auto" en tête pour revenir à la détection automatique sur toute la
	// sélection (pas de "detected" précis à prévisualiser ici, contrairement
	// au picker carte par carte, puisque plusieurs cartes différentes
	// peuvent être sélectionnées à la fois).
	const functionBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	functionBtn.createSpan({ text: "Function" });
	setIcon(functionBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(functionBtn);
	functionBtn.addEventListener("click", () => {
		openPickerMenu(
			functionBtn,
			[
				{
					render: (el) => el.createSpan({ text: "Auto" }),
					onSelect: () => {
						this.plugin.bulkSetDeckCardFunction(deckId, selectedIds(), undefined);
						new Notice("Function reset to automatic detection.");
						this.render();
					},
				},
				...DECK_FUNCTION_CATEGORIES.map((label) => ({
					render: (el: HTMLElement) => el.createSpan({ text: label }),
					onSelect: () => {
						this.plugin.bulkSetDeckCardFunction(deckId, selectedIds(), label);
						new Notice(`Function set to ${label}.`);
						this.render();
					},
				})),
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// Changer l'état — mêmes idiomes que Condition/Language/Finish côté My
	// Collection (renderCollectionBulkActionsBar, collection-render.ts), sur bulkSetDeckCardCondition/Language/Finish
	// (plugin.ts).
	const conditionBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	conditionBtn.createSpan({ text: "Condition" });
	setIcon(conditionBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(conditionBtn);
	conditionBtn.addEventListener("click", () => {
		openPickerMenu(
			conditionBtn,
			CONDITIONS.map((cond) => ({
				render: (el) => el.createSpan({ text: cond.label }),
				onSelect: () => {
					this.plugin.bulkSetDeckCardCondition(deckId, selectedIds(), cond.value);
					new Notice(`Condition set to "${cond.label}".`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	const languageBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	languageBtn.createSpan({ text: "Language" });
	setIcon(languageBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(languageBtn);
	languageBtn.addEventListener("click", () => {
		openPickerMenu(
			languageBtn,
			LANGUAGES.map((l) => ({
				render: (el) => {
					createFlagImg(el, l.flag, "mtg-flag-img mtg-flag-img-inline");
					el.createSpan({ text: l.label });
				},
				onSelect: () => {
					this.plugin.bulkSetDeckCardLanguage(deckId, selectedIds(), l.code);
					new Notice(`Language set to ${l.label}.`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// Finition (Regular/Foiled/Etched/Surge Foil/Proxy)
	const finishBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	finishBtn.createSpan({ text: "Finish" });
	setIcon(finishBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(finishBtn);
	finishBtn.addEventListener("click", () => {
		openPickerMenu(
			finishBtn,
			FINISH_OPTIONS.map((f) => ({
				render: (el) => el.createSpan({ text: f.label }),
				onSelect: () => {
					this.plugin.bulkSetDeckCardFinish(deckId, selectedIds(), f.value);
					new Notice(`Finish set to ${f.label}.`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// Régler la quantité
	const qtyBtn = bar.createEl("button", { text: "Quantity", cls: "mtg-bulk-action-btn" });
	actionButtons.push(qtyBtn);
	qtyBtn.addEventListener("click", () => {
		const input = bar.createEl("input", {
			cls: "mtg-bulk-qty-input",
			type: "number",
			attr: { min: "1" },
		});
		input.value = "1";

		const cancelQtyBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
		setIcon(cancelQtyBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "x");
		cancelQtyBtn.createSpan({ text: "Cancel" });

		replaceInBulkBar(qtyBtn, input, cancelQtyBtn);
		input.focus();
		input.select();
		const commit = () => {
			const count = this.selectedDeckCardIds.size;
			this.plugin.bulkSetDeckCardCount(deckId, selectedIds(), Number(input.value));
			new Notice(
				`Quantity set to ${Math.max(1, Math.floor(Number(input.value)) || 1)} for ${count} card(s).`
			);
			this.render();
		};
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") input.blur();
			if (e.key === "Escape") {
				input.removeEventListener("blur", commit);
				this.render();
			}
		});
		// Même fix mousedown/preventDefault que My Collection : sans lui, le
		// blur (donc commit) se déclenche avant le click de Cancel.
		cancelQtyBtn.addEventListener("mousedown", (e) => e.preventDefault());
		cancelQtyBtn.addEventListener("click", () => {
			input.removeEventListener("blur", commit);
			this.render();
		});
	});

	// Exporter la sélection en fichier (CSV, même colonnes que
	// buildDeckCsvString/exportDeckCsv, ou TXT) — même bouton "Export" avec
	// choix de format que My Collection (renderCollectionBulkActionsBar, collection-render.ts).
	const exportBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	exportBtn.createSpan({ text: "Export" });
	setIcon(exportBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(exportBtn);
	exportBtn.addEventListener("click", () => {
		openPickerMenu(
			exportBtn,
			[
				{
					render: (el) => el.createSpan({ text: "CSV" }),
					onSelect: () => this.exportDeckSelectionCsv(deckId),
				},
				{
					render: (el) => el.createSpan({ text: "TXT" }),
					onSelect: () => this.exportDeckSelectionTxt(deckId),
				},
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	const copyTxtBtn = bar.createEl("button", { text: "Copy to clipboard", cls: "mtg-bulk-action-btn" });
	actionButtons.push(copyTxtBtn);
	copyTxtBtn.addEventListener("click", () => this.copyDeckSelectionTxt(deckId));

	// Séparateur avant Delete — même traitement que My Collection, pour
	// isoler visuellement l'action destructive du reste.
	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	// Retirer du deck — confirmation à deux étapes (bouton neutre → paire
	// rouge "Delete"/"Cancel"), même idiome que My Collection au lieu de
	// l'ancien texte "Confirm remove?" sans possibilité d'annuler. Libellé
	// "Delete" (comme My Collection/My Wantlists, renommé le 2026-09-08 —
	// voir le commentaire en tête de fonction) : ne supprime QUE la ligne
	// dans ce deck (bulkRemoveDeckCards), jamais la carte de la collection/
	// wantlist dont elle vient.
	const deleteBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	setIcon(deleteBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "trash-2");
	deleteBtn.createSpan({ text: "Delete" });
	actionButtons.push(deleteBtn);
	deleteBtn.addEventListener("click", () => {
		const confirmBtn = bar.createEl("button", {
			cls: "mtg-bulk-action-btn mtg-bulk-action-btn-danger",
		});
		setIcon(confirmBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "trash-2");
		confirmBtn.createSpan({ text: "Delete" });

		const cancelBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
		setIcon(cancelBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "x");
		cancelBtn.createSpan({ text: "Cancel" });

		replaceInBulkBar(deleteBtn, confirmBtn, cancelBtn);

		confirmBtn.addEventListener("click", () => {
			const count = this.selectedDeckCardIds.size;
			this.plugin.bulkRemoveDeckCards(deckId, selectedIds());
			this.selectedDeckCardIds.clear();
			new Notice(`Removed ${count} card(s) from the deck.`);
			this.render();
		});
		cancelBtn.addEventListener("click", () => this.render());
	});

	if (this.selectedDeckCardIds.size === 0) {
		actionButtons.forEach((btn) => (btn.disabled = true));
	}
}

// Même principe que listSelectionTxtLines (collection-render.ts), côté deck —
// partagé entre exportDeckSelectionTxt et copyDeckSelectionTxt.

export function deckSelectionTxtLines(this: MTGCollectionView, deckId: string): string {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	const cards = (deck?.cards ?? []).filter((c) => this.selectedDeckCardIds.has(c.scryfallId));
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportDeckSelectionTxt(this: MTGCollectionView, deckId: string) {
	this.downloadTextFile(this.deckSelectionTxtLines(deckId), "mtg-deck-selection.txt");
}

// Pendant deck du "Copy TXT" de My Collection — voir copyListSelectionTxt
// (collection-render.ts) pour le raisonnement sur .catch().

export function copyDeckSelectionTxt(this: MTGCollectionView, deckId: string) {
	const count = this.selectedDeckCardIds.size;
	navigator.clipboard
		.writeText(this.deckSelectionTxtLines(deckId))
		.then(() => new Notice(`Copied ${count} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}

// Pendant deck de exportListSelectionCsv (My Collection) — sélection en cours
// (renderDeckBulkActionsBar), pas le deck entier (voir exportDeckCsv plus
// bas). Réutilise buildDeckCsvString/downloadDeckCsv tels quels — même
// forme d'entrée ({card, deckName}[]) que exportDeckCsv, un DeckCard seul
// ne sait pas de quel deck il vient une fois extrait de Deck.cards.

export function exportDeckSelectionCsv(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	const cards = (deck?.cards ?? []).filter((c) => this.selectedDeckCardIds.has(c.scryfallId));
	this.downloadDeckCsv(
		cards.map((card) => ({ card, deckName: deck?.name ?? "" })),
		"mtg-deck-selection.csv"
	);
}


export function decksToTxtLines(this: MTGCollectionView, decks: Deck[]): string {
	return decks
		.map((d) => `# ${d.name}\n` + d.cards.map((c) => `${c.count} - ${c.name}`).join("\n"))
		.join("\n\n");
}

// Équivalent buildListCsvString pour un ou plusieurs decks à la fois. entries
// porte le nom du deck d'origine par ligne (même raisonnement que la
// colonne "List"/"Wantlist" des deux autres exports) plutôt qu'un simple
// CollectionCard[], puisqu'un DeckCard seul ne sait pas de quel deck il vient
// une fois extrait de Deck.cards.
// Colonnes Finish/Language/Condition/GradingCompany/GradingGrade/
// GradingLabel/CustomPrice ajoutées lors de l'harmonisation My Decks/My
// Collection (2026-08-25) — même ordre/mêmes noms que buildListCsvString (My
// Collection, collection-render.ts), "Deck" à la place de "List". Colonne
// PriceUsd ajoutée le 2026-09-02 une fois DeckCard doté d'un vrai prix
// persisté (voir "Data model notes", CLAUDE.md) — même position/même nom
// que buildListCsvString (juste avant la colonne "List"/"Deck"), `c.priceUsd
// ?? ""` plutôt qu'un repli via toDeckPricedCard : cette colonne veut le
// prix BRUT tel quel (même convention que c.priceUsd dans buildListCsvString,
// jamais formaté/converti), pas la valeur foil-aware déjà résolue selon
// le finish (ce que toDeckPricedCard/formatCardPrice calculent pour
// l'affichage).

export function buildDeckCsvString(this: MTGCollectionView, entries: { card: DeckCard; deckName: string }[]): string {
	const header =
		"Name,Set,SetCode,CollectorNumber,Rarity,Count,Finish,Language,Condition,PriceUsd,Deck,GradingCompany,GradingGrade,GradingLabel,CustomPrice\n";
	const rows = entries
		.map(({ card: c, deckName }) =>
			[
				toCsvField(c.name),
				toCsvField(c.setName),
				c.setCode,
				c.collectorNumber,
				c.rarity,
				c.count,
				getDeckCardFinish(c),
				getDeckCardLanguage(c),
				getDeckCardCondition(c),
				c.priceUsd ?? "",
				toCsvField(deckName),
				c.gradingCompany ?? "",
				c.gradingGrade ?? "",
				toCsvField(c.gradingLabel ?? ""),
				toCsvField(c.customPrice ?? ""),
			].join(",")
		)
		.join("\n");
	return header + rows;
}


export function downloadDeckCsv(this: MTGCollectionView, entries: { card: DeckCard; deckName: string }[], filename: string) {
	this.downloadTextFile(this.buildDeckCsvString(entries), filename, "text/csv");
}

// Même trio Export CSV/Export TXT/Copy to clipboard que exportListCsv/
// exportListTxt/copyListTxt (collection-render.ts), côté deck (DeckSettingsModal,
// harmonisé sur ListSettingsModal) — pour UN SEUL deck cette fois, pas la
// sélection de la barre d'actions groupées de la grille "My Decks"
// (exportDeckSelectionTxt/copyDeckSelectionTxt un peu plus haut, qui
// portent sur les cartes cochées à l'intérieur d'un deck déjà ouvert, un
// sous-ensemble différent).

export function exportDeckCsv(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const filename = `mtg-deck-${deck.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
	this.downloadDeckCsv(
		deck.cards.map((card) => ({ card, deckName: deck.name })),
		filename
	);
}

// Même format "qty - name" que listTxtLines (collection-render.ts)/
// wantlistSelectionTxtLines (wantlist-render.ts), pour UN SEUL deck entier.

export function deckTxtLines(this: MTGCollectionView, deckId: string): string {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	return (deck?.cards ?? []).map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportDeckTxt(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	const filename = `mtg-deck-${(deck?.name ?? "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
	this.downloadTextFile(this.deckTxtLines(deckId), filename);
}

// navigator.clipboard.writeText : même précédent déjà établi (voir
// copyListTxt, collection-render.ts) — .catch() explicite plutôt qu'une résolution
// supposée systématique.

export function copyDeckTxt(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	const cardCount = deck?.cards.length ?? 0;
	navigator.clipboard
		.writeText(this.deckTxtLines(deckId))
		.then(() => new Notice(`Copied ${cardCount} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}

// "Import" → "Import CSV" de DeckSettingsModal — passe par plugin.importDeckCsv (nouveau : jusqu'ici un deck n'avait
// aucun chemin d'import CSV, voir son propre commentaire dans plugin.ts) plutôt qu'importCsv ; le flux fichier est
// celui de file-import.ts.

export function triggerImportIntoDeck(this: MTGCollectionView, deckId: string) {
	importCsvFile(this, {
		accept: ".csv",
		progressTitle: "Importing deck…",
		skippedLabel: "skipped",
		run: (text, onStatus) => this.plugin.importDeckCsv(deckId, text, onStatus),
	});
}

// "Import" → "Import TXT" de DeckSettingsModal — réutilise plugin.importDecklistToDeck (déjà existante, voir
// NewDeckModal — cette méthode a toujours pu cibler n'importe quel deck existant, pas seulement un deck fraîchement
// créé) plutôt que d'écrire un 2ᵉ chemin de résolution de decklist.

export function triggerImportTxtIntoDeck(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	importDecklistFile(this, {
		noun: "deck",
		entityName: () => deck?.name,
		run: (text, onStatus) => this.plugin.importDecklistToDeck(deckId, text, onStatus),
	});
}


export function openDeck(this: MTGCollectionView, deckId: string) {
	this.activeSection = "decks";
	this.openDeckId = deckId;
	this.render();
}


export function closeDeckIfOpen(this: MTGCollectionView, deckId: string) {
	if (this.openDeckId === deckId) this.openDeckId = null;
	this.render();
}


export function renderDecksSection(this: MTGCollectionView) {
	const decks = this.plugin.settings.decks;
	const totalCards = decks.reduce(
		(sum, d) => sum + d.cards.reduce((s, c) => s + c.count, 0),
		0
	);

	if (this.openDeckId) {
		this.headerTitleEl.setText("");
		this.headerStatsEl.setText("");
	} else {
		this.headerTitleEl.setText("Decks");
		this.headerStatsEl.setText(`${decks.length} decks · ${totalCards} cards`);
	}

	if (this.openDeckId) {
		this.renderDeckDetail(this.openDeckId);
	} else {
		this.renderDeckGrid();
	}
}


export function renderDeckGrid(this: MTGCollectionView) {
	const filter = this.deckFilterEl.value.trim().toLowerCase();
	let decks = this.plugin.settings.decks.filter(
		(d) => !filter || d.name.toLowerCase().includes(filter)
	);

	const sortBy = this.plugin.settings.deckGridSortBy;
	const sortReverse = this.plugin.settings.deckGridSortReverse;
	decks = [...decks].sort((a, b) => {
		let cmp = 0;
		switch (sortBy) {
			case "name":
				cmp = a.name.localeCompare(b.name);
				break;
			case "dateCreated":
				cmp = (a.dateCreated ?? 0) - (b.dateCreated ?? 0);
				break;
			case "cardCount":
				cmp =
					a.cards.reduce((s, c) => s + c.count, 0) - b.cards.reduce((s, c) => s + c.count, 0);
				break;
		}
		return sortReverse ? -cmp : cmp;
	});

	if (decks.length === 0) {
		// Une recherche sans résultat n'est pas « aucun deck » : même message
		// que les galeries Collection/Wantlists dans ce cas.
		this.bodyEl.createEl("p", {
			text:
				filter && this.plugin.settings.decks.length > 0
					? "No deck matches your filter."
					: "No decks yet. Use \"+ New deck\" to create one.",
			cls: "mtg-status",
		});
		return;
	}

	// Barre "Sort by", sur le même modèle que "My Collection".
	const sortRow = this.bodyEl.createDiv({ cls: "mtg-groupsort-row" });

	const sortCluster = sortRow.createDiv({ cls: "mtg-groupsort-cluster" });
	const sortBtn = sortCluster.createDiv({ cls: "mtg-groupsort-btn" });
	setIcon(sortBtn.createSpan({ cls: "mtg-groupsort-icon" }), "list-filter");
	sortBtn.createSpan({ text: "Sort by " });
	sortBtn.createSpan({
		cls: "mtg-groupsort-value",
		text: DECK_GRID_SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? "",
	});
	sortBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		openPickerMenu(
			sortBtn,
			DECK_GRID_SORT_OPTIONS.map((opt) => ({
				render: (el) => el.createSpan({ text: opt.label }),
				onSelect: () => {
					this.plugin.settings.deckGridSortBy = opt.value;
					void this.plugin.saveSettings();
					this.render();
				},
			}))
		);
	});
	const sortReverseBtn = sortCluster.createDiv({ cls: "mtg-groupsort-reverse-btn" });
	setIcon(sortReverseBtn, "arrow-up-down");
	sortReverseBtn.setAttribute("title", "Reverse sort order");
	sortReverseBtn.toggleClass("is-active", sortReverse);
	sortReverseBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		this.plugin.settings.deckGridSortReverse = !this.plugin.settings.deckGridSortReverse;
		void this.plugin.saveSettings();
		this.render();
	});

	if (this.deckGallerySelectMode) {
		this.renderDeckGalleryBulkActionsBar(
			this.bodyEl,
			!this.deckGalleryBulkBarWasVisible,
			decks.map((d) => d.id)
		);
		this.deckGalleryBulkBarWasVisible = true;
	} else {
		this.deckGalleryBulkBarWasVisible = false;
	}

	// Petit titre « Decks: … » avec le nombre de decks, « x of y decks match »
	// pendant une recherche — même titre (et même classe) que « Lists » dans
	// renderListGrid, demandé explicitement pour les 3 galeries.
	this.bodyEl.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle("deck", decks.length, this.plugin.settings.decks.length, filter !== ""),
	});

	// Nombre de colonnes automatique (1/2/4 selon la largeur du panneau) —
	// voir renderListGrid et .mtg-set-grid-wrap dans styles.css.
	const gridWrap = this.bodyEl.createDiv({ cls: "mtg-set-grid-wrap" });
	const grid = gridWrap.createDiv({
		cls: `mtg-set-grid${this.deckGallerySelectMode ? " mtg-gallery-selecting" : ""}`,
	});
	decks.forEach((deck) => {
		const tile = grid.createDiv({ cls: "mtg-set-tile" });
		// Choix manuel (Deck.coverCardId, "Choose cover image" de
		// DeckSettingsModal harmonisé sur ListSettingsModal) sinon repli
		// automatique (Commander du deck, sinon 1ʳᵉ carte — voir
		// resolveDeckCoverImage/pickDeckCoverImage, core/price.ts) plutôt
		// que la simple 1ʳᵉ carte avec une image trouvée dans deck.cards.
		const cover = resolveDeckCoverImage(deck.cards, deck.coverCardId);
		if (cover) {
			const bg = tile.createDiv({ cls: "mtg-set-tile-bg" });
			bg.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.85)), url("${cover}")`;
		}
		const content = tile.createDiv({ cls: "mtg-set-tile-content" });

		// Pictogramme choisi manuellement (Deck.deckIcon, "Choose icon" de
		// DeckSettingsModal) — même recette que renderListTile (voir son
		// propre commentaire pour le raisonnement complet, transposé tel
		// quel : rangée imbriquée plutôt que centrage vertical de toute
		// la tuile, puisqu'un deck garde son dégradé de fond assombri vers
		// le bas comme une liste normale).
		let textParent: HTMLElement = content;
		if (deck.deckIcon) {
			const iconRow = content.createDiv({ cls: "mtg-set-tile-icon-row" });
			const iconCircle = iconRow.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
			const fetchIcon =
				deck.deckIcon.kind === "mana"
					? this.plugin.getManaSymbolSvg(deck.deckIcon.value)
					: this.plugin.getSetIconSvg(deck.deckIcon.value);
			void fetchIcon.then((svg) => {
				if (!svg) return;
				setSvgMarkup(iconCircle, svg);
				if (deck.deckIcon!.kind === "set") applySvgColor(iconCircle, "#ffffff");
			});
			textParent = iconRow.createDiv({ cls: "mtg-set-tile-pinned-text" });
		}

		const totalQty = deck.cards.reduce((s, c) => s + c.count, 0);
		textParent.createDiv({ cls: "mtg-set-tile-name", text: deck.name });
		// Format en tête de la ligne de stats, quand choisi (voir Deck.format
		// et NewDeckModal/DeckSettingsModal) — même liste LEGALITY_SEARCH_FORMATS
		// que partout ailleurs dans le plugin pour résoudre le libellé.
		const formatLabel = deck.format
			? LEGALITY_SEARCH_FORMATS.find((f) => f.key === deck.format)?.label
			: undefined;
		textParent.createDiv({
			cls: "mtg-set-tile-meta",
			text: `${formatLabel ? formatLabel + " · " : ""}${deck.cards.length} unique · ${totalQty} cards`,
		});
		// Pastilles de couleur du deck (union des couleurs de ses cartes, voir
		// deckColorIdentity) — même symboles officiels Scryfall que partout
		// ailleurs dans le plugin (getManaSymbolSvg), sur le modèle des
		// pastilles affichées par Moxfield sur ses propres vignettes de deck.
		const deckColors = deckColorIdentity(deck.cards);
		if (deckColors.length > 0) {
			const colorsEl = textParent.createDiv({ cls: "mtg-deck-tile-colors" });
			deckColors.forEach((letter) => {
				const iconEl = colorsEl.createSpan({ cls: "mtg-deck-tile-colors-icon" });
				void this.plugin.getManaSymbolSvg(letter).then((svg) => {
					if (!svg) return;
					setSvgMarkup(iconEl, svg);
					const svgEl = iconEl.querySelector("svg");
					svgEl?.setAttribute("width", "14");
					svgEl?.setAttribute("height", "14");
				});
			});
		}

		const isSelected = this.selectedDeckIds.has(deck.id);
		if (this.deckGallerySelectMode) {
			tile.toggleClass("mtg-set-tile-selected", isSelected);
			const indicator = tile.createDiv({ cls: "mtg-set-tile-select-indicator" });
			setIcon(indicator, isSelected ? "check-circle-2" : "circle");
			if (isSelected) indicator.addClass("is-selected");
		}

		tile.addEventListener("click", () => {
			if (this.deckGallerySelectMode) {
				if (this.selectedDeckIds.has(deck.id)) this.selectedDeckIds.delete(deck.id);
				else this.selectedDeckIds.add(deck.id);
				this.render();
				return;
			}
			this.openDeckId = deck.id;
			this.lastFocusedFilterKey = null;
			this.deckCardFilterTokens = [];
			this.deckCardFilterDraft = "";
			this.selectedDeckCardIds.clear();
			this.deckSelectMode = false;
			this.deckBulkBarWasVisible = false;
			this.render();
		});

		if (!this.deckGallerySelectMode) {
			const menuBtn = tile.createDiv({ cls: "mtg-tile-menu-btn" });
			setIcon(menuBtn, "more-vertical");
			menuBtn.setAttribute("title", "Deck settings");
			menuBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				new DeckSettingsModal(this.app, this.plugin, this, deck.id).open();
			});
		}
	});
}

// Barre d'actions groupées de la grille "My Decks" — même structure que
// renderListGalleryBulkActionsBar, adaptée à Deck/DeckCard.

export function renderDeckGalleryBulkActionsBar(this: MTGCollectionView, container: HTMLElement, animate: boolean, visibleDeckIds: string[]) {
	const bar = createBulkActionsBar(this, "deck-gallery", container, animate);

	bar.createSpan({
		cls: "mtg-bulk-actions-count",
		text: `${this.selectedDeckIds.size} selected`,
	});

	const selectionUtils = bar.createDiv({ cls: "mtg-bulk-selection-utils" });
	const selectAllBtn = selectionUtils.createEl("button", {
		text: "Select all",
		cls: "mtg-bulk-action-btn",
	});
	selectAllBtn.addEventListener("click", () => {
		visibleDeckIds.forEach((id) => this.selectedDeckIds.add(id));
		this.render();
	});
	const clearBtn = selectionUtils.createEl("button", { text: "Clear", cls: "mtg-bulk-action-btn" });
	clearBtn.addEventListener("click", () => {
		this.selectedDeckIds.clear();
		this.render();
	});

	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	const actionButtons: HTMLButtonElement[] = [clearBtn];

	const selectedDecks = () =>
		this.plugin.settings.decks.filter((d) => this.selectedDeckIds.has(d.id));

	const csvBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	csvBtn.createSpan({ text: "Export CSV" });
	setIcon(csvBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(csvBtn);
	csvBtn.addEventListener("click", () => {
		openPickerMenu(
			csvBtn,
			[
				{
					render: (el) => el.createSpan({ text: "Combined file (.csv)" }),
					onSelect: () => {
						const entries = selectedDecks().flatMap((d) =>
							d.cards.map((c) => ({ card: c, deckName: d.name }))
						);
						this.downloadDeckCsv(entries, "mtg-decks-selection.csv");
					},
				},
				{
					render: (el) => el.createSpan({ text: "One file per deck (.zip)" }),
					onSelect: () => {
						const entries: ZipEntry[] = selectedDecks().map((d) => ({
							name: `${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`,
							content: this.buildDeckCsvString(d.cards.map((c) => ({ card: c, deckName: d.name }))),
						}));
						this.downloadZip(entries, "mtg-decks-selection.zip");
					},
				},
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	const txtBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	txtBtn.createSpan({ text: "TXT" });
	setIcon(txtBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(txtBtn);
	txtBtn.addEventListener("click", () => {
		openPickerMenu(
			txtBtn,
			[
				{
					render: (el) => el.createSpan({ text: "Copy to clipboard" }),
					onSelect: () => {
						const count = this.selectedDeckIds.size;
						navigator.clipboard
							.writeText(this.decksToTxtLines(selectedDecks()))
							.then(() => new Notice(`Copied ${count} deck(s) to clipboard.`))
							.catch(() => new Notice("Could not copy to clipboard."));
					},
				},
				{
					render: (el) => el.createSpan({ text: "Combined file (.txt)" }),
					onSelect: () =>
						this.downloadTextFile(
							this.decksToTxtLines(selectedDecks()),
							"mtg-decks-selection.txt"
						),
				},
				{
					render: (el) => el.createSpan({ text: "One file per deck (.zip)" }),
					onSelect: () => {
						const entries: ZipEntry[] = selectedDecks().map((d) => ({
							name: `${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`,
							content: this.decksToTxtLines([d]),
						}));
						this.downloadZip(entries, "mtg-decks-selection.zip");
					},
				},
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	const deleteBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	setIcon(deleteBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "trash-2");
	deleteBtn.createSpan({ text: "Delete" });
	actionButtons.push(deleteBtn);
	deleteBtn.addEventListener("click", () => {
		const confirmBtn = bar.createEl("button", {
			cls: "mtg-bulk-action-btn mtg-bulk-action-btn-danger",
		});
		setIcon(confirmBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "trash-2");
		confirmBtn.createSpan({ text: "Delete" });

		const cancelBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
		setIcon(cancelBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "x");
		cancelBtn.createSpan({ text: "Cancel" });

		replaceInBulkBar(deleteBtn, confirmBtn, cancelBtn);

		confirmBtn.addEventListener("click", () => {
			const count = this.selectedDeckIds.size;
			this.plugin.bulkDeleteDecks(Array.from(this.selectedDeckIds));
			this.selectedDeckIds.clear();
			new Notice(`Deleted ${count} deck(s).`);
			this.render();
		});
		cancelBtn.addEventListener("click", () => this.render());
	});

	if (this.selectedDeckIds.size === 0) {
		actionButtons.forEach((btn) => (btn.disabled = true));
	}
}


export function renderDeckDetail(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	if (!deck) {
		this.openDeckId = null;
		this.render();
		return;
	}

	// Échafaudage flex-colonne (voir .mtg-collection-body-detail,
	// styles.css) : stickyHeader (hauteur naturelle) puis
	// .mtg-detail-scroll-area (le reste de la hauteur disponible, avec sa
	// propre scrollbar — voir plus bas) se partagent ainsi toute la
	// hauteur de this.bodyEl, qui prend lui-même toute la hauteur de
	// this.mainEl dans ce mode. Retiré à chaque render() (voir plus haut
	// dans render()) avant d'être potentiellement rajouté ici — jamais
	// hérité tel quel via cloneNode(false).
	this.bodyEl.addClass("mtg-collection-body-detail");
	const stickyHeader = this.bodyEl.createDiv({ cls: "mtg-detail-sticky-header" });

	// Voir renderListDetail pour le raisonnement complet — le bouton
	// "← Back to X" et la rangée titre partagent maintenant un seul
	// conteneur (.mtg-detail-header-banner). resolveDeckCoverImage, déjà
	// utilisée par renderDeckGrid pour la tuile de ce deck, réutilisée
	// ici pour obtenir la même image.
	const headerBanner = stickyHeader.createDiv({ cls: "mtg-detail-header-banner" });
	const coverImage = resolveDeckCoverImage(deck.cards, deck.coverCardId);
	if (coverImage) {
		const bannerBg = headerBanner.createDiv({ cls: "mtg-detail-banner-bg" });
		bannerBg.style.backgroundImage = `url("${coverImage}")`;
		headerBanner.createDiv({ cls: "mtg-detail-banner-scrim" });
	}

	const backBtn = headerBanner.createEl("button", {
		text: "← Back to decks",
		cls: "mtg-back-btn",
	});
	backBtn.addEventListener("click", () => {
		this.openDeckId = null;
		this.lastFocusedFilterKey = null;
		this.deckCardFilterTokens = [];
		this.deckCardFilterDraft = "";
		this.selectedDeckCardIds.clear();
		this.deckSelectMode = false;
		this.deckBulkBarWasVisible = false;
		this.render();
	});

	const titleRow = headerBanner.createDiv({ cls: "mtg-deck-title-row" });
	const titleInfo = titleRow.createDiv({ cls: "mtg-title-info" });
	// Ouvre les settings (DeckSettingsModal) au clic sur le titre, au lieu du
	// renommage en ligne d'origine — demandé explicitement, le renommage
	// reste accessible depuis cette même fenêtre. openDeckSettings est
	// réutilisé plus bas par menuBtn (le bouton "...") pour ne pas dupliquer
	// la construction de la modale.
	const openDeckSettings = () => new DeckSettingsModal(this.app, this.plugin, this, deck.id).open();
	const nameRow = titleInfo.createDiv({ cls: "mtg-detail-title-row" });
	nameRow.createEl("h3", { cls: "mtg-detail-title", text: deck.name });
	nameRow.setAttribute("title", "Deck settings");
	nameRow.addEventListener("click", openDeckSettings);
	const totalDeckQty = deck.cards.reduce((s, c) => s + c.count, 0);
	const deckFormatLabel = deck.format
		? LEGALITY_SEARCH_FORMATS.find((f) => f.key === deck.format)?.label
		: undefined;
	titleInfo.createDiv({
		cls: "mtg-detail-title-stats",
		text: `${deckFormatLabel ? deckFormatLabel + " · " : ""}${deck.cards.length} unique · ${totalDeckQty} cards`,
	});

	// "+ Add cards"/"Deck stats"/"Select cards"/"..." vivaient auparavant
	// sur la rangée du titre, tout en haut — déplacés ici, à droite de la
	// barre de recherche, pour gagner de la hauteur verticale (demandé
	// explicitement, capture d'écran annotée à l'appui, même changement
	// que My Collection/My Wantlists).
	const searchActionsRow = stickyHeader.createDiv({ cls: "mtg-detail-search-actions-row" });
	const filterRow = searchActionsRow.createDiv({ cls: "mtg-collection-toolbar mtg-inline-filter-row" });
	const actionsRow = searchActionsRow.createDiv({ cls: "mtg-detail-search-actions" });

	const addBtn = actionsRow.createEl("button", {
		text: "+ Add cards",
		cls: "mtg-search-add-btn",
	});
	addBtn.addEventListener("click", () => {
		const modal = new AddCardsModal(this.app, this.plugin, {
			// DeckCard n'a pas de champ id propre (voir data-model.ts) —
			// scryfallId sert de clé partout ailleurs pour un deck donné
			// (changeDeckCardCount/removeDeckCard/undoAddToDeck), reprise ici
			// pour satisfaire la forme { id, count, listId } attendue par
			// AddCardsModalOptions.onAdd (uniformisation avec Collection/
			// Wantlist demandée explicitement — le flux Deck n'avait jusqu'ici
			// ni stepper, ni tuile cliquable, ni panneau d'historique).
			onAdd: (card) => {
				const row = this.plugin.addCardToDeck(deck.id, card);
				return row ? { id: row.scryfallId, count: row.count, listId: deck.id } : undefined;
			},
			onChangeQuantity: (entryId, delta, onDone) =>
				this.plugin.changeDeckCardCount(deck.id, entryId, delta, onDone),
			onOpenDetail: (entryId, onDetailClosed) =>
				this.openDeckCardDetailById(deck.id, entryId, onDetailClosed),
			// Même raisonnement que undoAddToCollection/undoAddToWantlist
			// (onUndoAdd, shared-search-ui.ts) — reshape { id, count } depuis
			// DeckCard (scryfallId, pas id) pour la même raison que onAdd
			// ci-dessus.
			onUndoAdd: (card, _options, undoListId, delta) => {
				const row = this.plugin.undoAddToDeck(card.id, undoListId, delta);
				return row ? { id: row.scryfallId, count: row.count } : undefined;
			},
			destinationName: deck.name,
			// "deck" : ChangePrintingModal/CopyCardModal n'acceptent ni l'un
			// ni l'autre "deck" comme source (voir sourceKind, shared-
			// search-ui.ts) — les liens "Change printing"/"Move card" du
			// panneau "Add history" ne s'affichent donc jamais ici,
			// cohérent avec l'absence déjà établie de tout concept de
			// déplacement pour une carte de deck.
			sourceKind: "deck",
			// DeckCard n'a toujours pas de champ finish (voir "Data model
			// notes" dans CLAUDE.md — asymétrie établie, hors périmètre de
			// cette harmonisation) : aucun sélecteur Finish/Language/
			// Condition n'existe plus dans cette modale de toute façon (le
			// dernier, propre au flux Wantlist, a été retiré à son tour).
			titleText: `Add cards to "${deck.name}"`,
		});
		modal.onClose = () => {
			modal.contentEl.empty();
			this.render();
		};
		modal.open();
	});

	// "Deck Stats" (2026-09-02) — mana curve/couleurs/types de CE deck, voir
	// DeckStatsModal. Un premier essai en 5e mode d'affichage (à côté de
	// Liste/Grille/Tableau/Carte) a été demandé explicitement en retour à
	// une modale — ce bouton d'en-tête est le point d'entrée à la place du
	// 5e bouton du cluster liste/grille/tableau/carte (renderGroupSortBar).
	const statsBtn = actionsRow.createDiv({
		cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
	});
	setIcon(statsBtn, "bar-chart-3");
	statsBtn.setAttribute("title", "Deck stats");
	statsBtn.addEventListener("click", () => {
		new DeckStatsModal(this.app, deck).open();
	});

	const selectModeBtn = actionsRow.createDiv({
		cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
	});
	if (this.deckSelectMode) selectModeBtn.addClass("is-active");
	setIcon(selectModeBtn, this.deckSelectMode ? "x" : "square-mouse-pointer");
	selectModeBtn.setAttribute("title", this.deckSelectMode ? "Exit select mode" : "Select cards");
	selectModeBtn.addEventListener("click", () => {
		this.deckSelectMode = !this.deckSelectMode;
		if (!this.deckSelectMode) {
			this.selectedDeckCardIds.clear();
			this.deckBulkBarWasVisible = false;
		}
		this.render();
	});

	const menuBtn = actionsRow.createDiv({
		cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
	});
	setIcon(menuBtn, "more-vertical");
	menuBtn.setAttribute("title", "Deck settings");
	menuBtn.addEventListener("click", openDeckSettings);

	// Cartes du deck limitées à l'onglet actif (voir renderDeckBoardTabs
	// plus haut) — le filtre texte/Group by/Sort by habituels s'appliquent
	// ENSUITE, à l'intérieur de ce sous-ensemble seulement.
	const boardCards = deck.cards.filter((c) => deckBoardTabMatches(c, this.deckActiveBoard));
	const filteredCards = boardCards.filter((c) =>
		cardMatchesTokens(c, this.deckCardFilterTokens, this.deckCardFilterDraft)
	);
	this.renderChipFilter(
		filterRow,
		this.deckCardFilterTokens,
		this.deckCardFilterDraft,
		"Filter by name, rarity, color, type, ability, artist, set, #number, cmc, price, qty, added, language, condition, foil…",
		"deck-card-filter",
		(tokens) => {
			this.deckCardFilterTokens = tokens;
		},
		(draft) => {
			this.deckCardFilterDraft = draft;
		},
		boardCards
	);

	// Le prix d'une carte de deck est désormais un vrai champ persisté sur
	// DeckCard (voir "Data model notes", CLAUDE.md, 2026-09-02) plutôt
	// qu'un cache session à pré-remplir ici à chaque ouverture — plus
	// aucun aller-retour réseau nécessaire à ce stade : une carte pas
	// encore rattrapée (deck créé avant cette fonctionnalité) se voit déjà
	// rattrapée une fois pour toutes par MTGCollectionPlugin.
	// backfillDeckCardPrices() au démarrage du plugin, qui redessine
	// lui-même les vues ouvertes une fois terminé.

	// Pré-remplissage en bloc de legalitiesCache pour tout le deck ouvert,
	// dès qu'un format est choisi (Deck.format) — alimente le petit badge de
	// légalité par carte (voir buildDeckCardRow/buildDeckCardTile plus bas,
	// deckLegalityBadge) sans attendre qu'un filtre "legal:" quelconque soit
	// tapé (contrairement à renderListDetail, où ce même fetch groupé
	// n'est déclenché QUE par un filtre actif — ici c'est le format du deck
	// lui-même qui joue ce rôle). bulkFetchLegalities est déjà générique
	// sur n'importe quel ensemble d'ids (pas seulement Collection/
	// Wantlist), et no-op instantanément si tout est déjà en cache/en vol
	// — sûr à rappeler à chaque render().
	if (deck.format) {
		void this.plugin.bulkFetchLegalities(deck.cards.map((c) => c.scryfallId)).then((fetchedSomething) => {
			if (fetchedSomething) this.plugin.refreshOpenViews();
		});
	}

	this.renderGroupSortBar("deck", stickyHeader);

	// Mainboard/Sideboard/Maybeboard — sous la barre Group by/Sort by/
	// modes d'affichage plutôt qu'au-dessus (déplacé sur demande explicite,
	// capture d'écran annotée à l'appui, 2026-09-07) ; ordre DOM ici direct
	// puisque cet appel n'a besoin d'aucune donnée calculée plus bas.
	this.renderDeckBoardTabs(deck, stickyHeader);

	const renderSignature = JSON.stringify([
		deckId,
		this.deckActiveBoard,
		this.deckCardFilterTokens,
		this.deckCardFilterDraft,
		this.deckGroupBy,
		this.deckSortBy,
		this.deckSortReverse,
		this.deckGroupReverse,
		phoneAwareViewMode(this.deckViewMode),
	]);
	if (this.lastDeckRenderSignature !== renderSignature) {
		this.deckRenderLimit = RENDER_BATCH_SIZE;
		this.lastDeckRenderSignature = renderSignature;
	}

	const dataSignature = `${renderSignature}::${this.plugin.dataVersion}`;
	let cardGroups: CardGroup<DeckCard>[];
	if (this.lastDeckDataSignature === dataSignature && this.cachedDeckCardGroups) {
		cardGroups = this.cachedDeckCardGroups;
	} else {
		cardGroups = groupAndSortCards(
			filteredCards,
			this.deckGroupBy,
			this.deckSortBy,
			this.deckSortReverse,
			this.deckGroupReverse,
			this.plugin.settings.lists
		);
		this.cachedDeckCardGroups = cardGroups;
		this.lastDeckDataSignature = dataSignature;
	}
	const visibleGroups = sliceGroupsForRender(cardGroups, this.deckRenderLimit);
	const fullGroupCardsByLabel = new Map(cardGroups.map((g) => [g.label, g.cards]));
	const navOrder = cardGroups.flatMap((g) => g.cards);
	this.navOrderForDeckClick = navOrder;

	// Voir le commentaire équivalent dans renderListDetail — même
	// raisonnement, la vue Stacks (renderDeckStacksView) construit son
	// propre contenu à l'intérieur de CE même `list`, donc en hérite aussi.
	const scrollArea = this.bodyEl.createDiv({ cls: "mtg-detail-scroll-area" });
	scrollArea.addEventListener("scroll", () => this.handleScrollAreaScroll(scrollArea));
	// Voir le commentaire équivalent dans renderListDetail.
	setupPanelScrollFade(scrollArea);
	// Titre "Cards: …" — porte sur l'onglet actif (Mainboard/Sideboard/
	// Maybeboard), comme le filtre lui-même : voir renderCardsCountTitle.
	renderCardsCountTitle(
		scrollArea,
		boardCards,
		filteredCards,
		this.deckCardFilterTokens.length > 0 || this.deckCardFilterDraft.length > 0
	);
	const list = scrollArea.createDiv({
		cls: `mtg-collection-list${viewModeClass(phoneAwareViewMode(this.deckViewMode), "deck")}${this.deckSelectMode ? " mtg-collection-list-selecting" : ""}`,
	});
	if (phoneAwareViewMode(this.deckViewMode) === "table" && filteredCards.length > 0) {
		this.renderTableHeader(
			list,
			this.deckSelectMode ? ["", ...TABLE_COLUMNS_DECK] : TABLE_COLUMNS_DECK
		);
	}

	this.lastRenderedDeckGroupLabels = cardGroups.filter((g) => g.label).map((g) => g.label);

	if (filteredCards.length === 0) {
		// Distingue "le deck entier est vide" de "cet onglet est vide" (ex.
		// pas de Sideboard) et de "le filtre de recherche ne matche rien" —
		// sans quoi une simple recherche vide sur un deck bien rempli, ou un
		// onglet Sideboard/Maybeboard sans carte, affichait à tort "Ce deck
		// est vide" (message resté correct seulement pour le tout premier
		// cas avant l'ajout des onglets, jamais un problème tant que
		// filteredCards === deck.cards.length === 0 étaient équivalents).
		const boardLabel = DECK_BOARD_TABS.find((t) => t.value === this.deckActiveBoard)?.label ?? "";
		list.createEl("p", {
			text:
				deck.cards.length === 0
					? "This deck is empty. Use \"+ Add cards\" above."
					: boardCards.length === 0
					  ? `No cards in ${boardLabel}.`
					  : "No cards match your filters.",
			cls: "mtg-status",
		});
	}

	if (this.deckSelectMode) {
		this.renderDeckBulkActionsBar(
			stickyHeader,
			deck.id,
			!this.deckBulkBarWasVisible,
			filteredCards.map((c) => c.scryfallId)
		);
		this.deckBulkBarWasVisible = true;
	} else {
		this.deckBulkBarWasVisible = false;
	}

	// Vue Stacks (Archidekt) : une structure de colonnes entièrement à
	// part, sans rapport avec les lignes/tuiles empilées verticalement
	// (.mtg-card-row-outer) des 4 autres modes — cardGroups (pas
	// visibleGroups/deckRenderLimit) : un deck reste de taille modeste
	// (quelques dizaines à ~200 cartes), la pagination par lots n'a pas
	// été jugée nécessaire pour cette 1ère version.
	if (phoneAwareViewMode(this.deckViewMode) === "stacks" && filteredCards.length > 0) {
		this.renderDeckStacksView(list, deck, cardGroups);
		return;
	}

	visibleGroups.forEach((cardGroup) => {
		const groupRows: HTMLElement[] = [];
		const isCollapsed = cardGroup.label
			? this.deckCollapsedGroups.has(cardGroup.label)
			: false;

		if (cardGroup.label) {
			const headerEl = list.createDiv({ cls: "mtg-group-header" });
			if (isCollapsed) headerEl.addClass("is-group-collapsed");
			if (this.deckGroupBy === "color") {
				const hex =
					GROUP_LABEL_HEX[cardGroup.label] ??
					(cardGroup.label.includes("/") ? GROUP_LABEL_HEX.Multicolor : undefined);
				if (hex) {
					headerEl.addClass("mtg-group-header-colored");
					headerEl.style.setProperty("--mtg-group-color", hex);
				}
			}

			const fullGroupCards = fullGroupCardsByLabel.get(cardGroup.label) ?? cardGroup.cards;
			const allSelected =
				fullGroupCards.length > 0 &&
				fullGroupCards.every((c) => this.selectedDeckCardIds.has(c.scryfallId));
			const selectGroupBtn = headerEl.createDiv({ cls: "mtg-group-header-select-btn" });
			if (allSelected) selectGroupBtn.addClass("is-checked");
			setIcon(selectGroupBtn, allSelected ? "square-check" : "square");
			selectGroupBtn.setAttribute(
				"title",
				allSelected ? "Deselect all cards in this group" : "Select all cards in this group"
			);
			selectGroupBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.deckSelectMode = true;
				if (allSelected) {
					fullGroupCards.forEach((c) => this.selectedDeckCardIds.delete(c.scryfallId));
				} else {
					fullGroupCards.forEach((c) => this.selectedDeckCardIds.add(c.scryfallId));
				}
				this.render();
			});

			const centerEl = headerEl.createDiv({ cls: "mtg-group-header-center" });
			if (cardGroup.colorKeys) {
				const iconsEl = centerEl.createSpan({ cls: "mtg-group-header-icons" });
				cardGroup.colorKeys.forEach((letter) => {
					const iconEl = iconsEl.createSpan({ cls: "mtg-group-header-icon" });
					void this.plugin.getManaSymbolSvg(letter).then((svg) => {
						if (!svg) return;
						setSvgMarkup(iconEl, svg);
						const svgEl = iconEl.querySelector("svg");
						if (svgEl) {
							svgEl.setAttribute("width", "34");
							svgEl.setAttribute("height", "34");
						}
					});
				});
			} else if (cardGroup.manaValueKey !== undefined) {
				const iconEl = centerEl.createSpan({ cls: "mtg-group-header-icon" });
				const labelEl = centerEl.createSpan({ cls: "mtg-group-header-label" });
				void this.plugin.getManaSymbolSvg(String(Math.round(cardGroup.manaValueKey))).then((svg) => {
					if (!svg) {
						labelEl.setText(cardGroup.label);
						return;
					}
					setSvgMarkup(iconEl, svg);
					const svgEl = iconEl.querySelector("svg");
					if (svgEl) {
						svgEl.setAttribute("width", "34");
						svgEl.setAttribute("height", "34");
					}
				});
			} else if (cardGroup.setCodeKey) {
				const iconEl = centerEl.createSpan({ cls: "mtg-group-header-icon" });
				centerEl.createSpan({ cls: "mtg-group-header-label", text: cardGroup.label });
				void this.plugin.getSetIconSvg(cardGroup.setCodeKey).then((svg) => {
					if (!svg) return;
					setSvgMarkup(iconEl, svg);
					applySvgColor(iconEl, "#ffffff");
					const svgEl = iconEl.querySelector("svg");
					if (svgEl) {
						svgEl.setAttribute("width", "22");
						svgEl.setAttribute("height", "22");
					}
				});
			} else {
				centerEl.createSpan({ cls: "mtg-group-header-label", text: cardGroup.label });
			}

			const rightEl = headerEl.createDiv({ cls: "mtg-group-header-right" });
			// Comme les tuiles de deck (deck.cards.length unique · totalQty cards) :
			// fullGroupCards.length compte les cartes distinctes, totalQty somme
			// leurs exemplaires (DeckCard.count).
			const totalQty = fullGroupCards.reduce((s, c) => s + c.count, 0);
			rightEl.createSpan({
				cls: "mtg-group-header-count",
				text: `${fullGroupCards.length} unique · ${totalQty} ${totalQty === 1 ? "card" : "cards"}`,
			});
			const chevronEl = rightEl.createDiv({ cls: "mtg-group-header-chevron" });
			setIcon(chevronEl, "chevron-down");

			headerEl.addEventListener("click", (evt) => {
				if ((evt.target as HTMLElement).closest(".mtg-group-header-select-btn")) return;
				const nowCollapsed = !this.deckCollapsedGroups.has(cardGroup.label);
				if (nowCollapsed) this.deckCollapsedGroups.add(cardGroup.label);
				else this.deckCollapsedGroups.delete(cardGroup.label);
				headerEl.toggleClass("is-group-collapsed", nowCollapsed);
				this.toggleGroupRows(list, headerEl, groupRows, nowCollapsed, phoneAwareViewMode(this.deckViewMode));
			});
		}

		cardGroup.cards.forEach((card) => {
			const rowOuter = list.createDiv({ cls: "mtg-card-row-outer" });
			groupRows.push(rowOuter);
			if (isCollapsed) {
				rowOuter.addClass("mtg-hidden");
				if (phoneAwareViewMode(this.deckViewMode) !== "table") rowOuter.addClass("mtg-row-collapsed");
			}

			const isSelected = this.selectedDeckCardIds.has(card.scryfallId);
			const cacheKey = `${deck.id}:${card.scryfallId}`;
			const signature = this.deckCardRowSignature(deck, card, isSelected);
			const cached = this.cachedDeckRowElements.get(cacheKey);
			const row =
				cached && cached.signature === signature
					? cached.el
					: phoneAwareViewMode(this.deckViewMode) === "card"
					  ? this.buildDeckCardTile(deck, card, isSelected)
					  : this.buildDeckCardRow(deck, card, isSelected);
			if (!cached || cached.signature !== signature) {
				this.cachedDeckRowElements.set(cacheKey, { signature, el: row });
			}
			rowOuter.appendChild(row);
		});
	});

	const liveDeckRowIds = new Set(
		cardGroups.flatMap((g) => g.cards.map((c) => `${deck.id}:${c.scryfallId}`))
	);
	for (const id of this.cachedDeckRowElements.keys()) {
		if (!liveDeckRowIds.has(id)) this.cachedDeckRowElements.delete(id);
	}

	if (filteredCards.length > this.deckRenderLimit) {
		this.renderLoadMoreSentinel(list, () => {
			this.deckRenderLimit += RENDER_BATCH_SIZE;
			this.render();
		});
	}
}


function resolveDraggedStackCard(
	cardGroup: CardGroup<DeckCard>,
	cardEls: HTMLElement[],
	clientY: number
): { card: DeckCard; el: HTMLElement } {
	const lastIndex = cardGroup.cards.length - 1;
	for (let i = 0; i < lastIndex; i++) {
		if (clientY < cardEls[i + 1].getBoundingClientRect().top) {
			return { card: cardGroup.cards[i], el: cardEls[i] };
		}
	}
	return { card: cardGroup.cards[lastIndex], el: cardEls[lastIndex] };
}

export function renderDeckStacksView(this: MTGCollectionView, container: HTMLElement, deck: Deck, cardGroups: CardGroup<DeckCard>[]) {
	const currency = this.plugin.settings.priceCurrency;
	const canDragFunction = this.deckGroupBy === "function" && !this.deckSelectMode;
	// Colonne actuellement survolée pendant un drag (mise à jour uniquement
	// sur CHANGEMENT dans le handler dragover container-level plus bas,
	// jamais dans dragenter/dragleave par colonne — ces deux événements
	// bullent depuis les enfants et scintillent sinon à chaque carte
	// traversée à l'intérieur d'une même colonne).
	let dragHighlightedColumn: HTMLElement | null = null;
	// Carte actuellement "prise" (voir plus bas, resolveDraggedStackCard) —
	// distincte de dragHighlightedColumn, même raison d'être : le nettoyage
	// dans dragend doit retirer la classe de la carte réellement résolue,
	// pas d'une carte capturée par fermeture au moment de la construction.
	let draggingCardEl: HTMLElement | null = null;
	cardGroups.forEach((cardGroup, groupIndex) => {
		const column = container.createDiv({ cls: "mtg-deck-stack-column" });
		// Lus par updateDeckStacksLayout (plus bas) une fois cette pile
		// attachée au document — stackOrder préserve l'ordre d'origine des
		// groupes à travers plusieurs répartitions successives (la pile n'est
		// alors plus forcément un enfant DIRECT de `container`, voir cette
		// fonction), stackCardCount est cardGroup.cards.length (nombre de
		// LIGNES distinctes, pas la quantité totale — voir
		// estimateStackColumnHeight, card-sorting.ts) pour estimer sa hauteur
		// sans avoir besoin de la mesurer dans le DOM.
		column.dataset.stackOrder = String(groupIndex);
		column.dataset.stackCardCount = String(cardGroup.cards.length);
		if (canDragFunction) column.dataset.stackFunctionLabel = cardGroup.label;
		const header = column.createDiv({ cls: "mtg-deck-stack-header" });
		const titleRow = header.createDiv({ cls: "mtg-deck-stack-header-title" });
		// Couronne d'en-tête de groupe retirée (2026-09-07) : dépendait de
		// "Group by Category", qui n'existe plus (Commander est devenu une
		// Function, voir DeckCardCategory dans data-model.ts) — le Commander
		// est désormais repéré sur CHAQUE carte via .mtg-thumb-commander-
		// badge (renderThumbWithBadge, isDeckCommander), pas via un en-tête
		// de groupe qui n'a plus de sens pour ce concept.
		titleRow.createSpan({ cls: "mtg-deck-stack-header-label", text: cardGroup.label || "Cards" });

		// "Qty" (exemplaires physiques, DeckCard.count) et "Price" (somme des
		// valeurs de la colonne) — même deux informations que l'en-tête de
		// groupe des 4 autres vues (mtg-group-header-count), condensées ici
		// sur 2 lignes courtes plutôt qu'une seule phrase, à la Archidekt.
		const statsRow = header.createDiv({ cls: "mtg-deck-stack-header-stats" });
		const totalQty = cardGroup.cards.reduce((s, c) => s + c.count, 0);
		statsRow.createSpan({ text: `Qty: ${totalQty}` });
		const priceEl = statsRow.createSpan();
		// Prix : vrai champ persisté sur DeckCard (voir "Data model notes",
		// CLAUDE.md, 2026-09-02) — undefined = pas encore rattrapé par
		// MTGCollectionPlugin.backfillDeckCardPrices(), même état de
		// chargement que buildDeckCardRow/buildDeckCardTile pour une carte isolée.
		if (cardGroup.cards.some((c) => c.priceUsd === undefined)) {
			renderLoadingDots(priceEl);
		} else {
			const totalValue = cardGroup.cards.reduce((s, c) => s + cardValue(toDeckPricedCard(c), currency), 0);
			priceEl.setText(`Price: ${formatMoney(totalValue, currency)}`);
		}

		const body = column.createDiv({ cls: "mtg-deck-stack-body" });
		// Parallèle à cardGroup.cards (même ordre, même index) — seul moyen de
		// remonter d'un index géométrique (resolveDraggedStackCard plus bas) à
		// l'élément DOM réel de la carte visée.
		const cardEls: HTMLElement[] = [];
		cardGroup.cards.forEach((card) => {
			const cardWrap = body.createDiv({ cls: "mtg-deck-stack-card" });
			cardEls.push(cardWrap);
			const finish = getDeckCardFinish(card);
			this.renderThumbWithBadge(
				cardWrap,
				card.imageUrl,
				card.setCode,
				card.rarity,
				finishHasFoilLook(finish),
				!isDeckCardOwned(card),
				"tile",
				isDeckCommander(card)
			);
			if (card.count > 1) {
				const qtyBadge = cardWrap.createDiv({ cls: "mtg-deck-stack-card-qty" });
				qtyBadge.createSpan({ cls: "mtg-deck-stack-card-qty-value", text: String(card.count) });
			}
			const isSelected = this.selectedDeckCardIds.has(card.scryfallId);
			if (this.deckSelectMode) {
				const indicator = cardWrap.createDiv({
					cls: "mtg-card-row-select-indicator mtg-deck-stack-card-select-indicator",
				});
				setIcon(indicator, isSelected ? "check-circle-2" : "circle");
				if (isSelected) indicator.addClass("is-selected");
				// Anneau d'accent autour de la carte elle-même (voir styles.css)
				// — le seul autre indice visuel de sélection sur une carte de
				// pile serait cette petite pastille en coin, trop discrète une
				// fois la carte recouverte par sa suivante.
				if (isSelected) cardWrap.addClass("mtg-deck-stack-card-selected");
			}
			cardWrap.addEventListener("click", () => {
				if (this.deckSelectMode) {
					if (isSelected) this.selectedDeckCardIds.delete(card.scryfallId);
					else this.selectedDeckCardIds.add(card.scryfallId);
					this.render();
					return;
				}
				new DeckCardDetailModal(this.app, this.plugin, this, deck, card, this.navOrderForDeckClick).open();
			});
		});

		if (canDragFunction) {
			body.draggable = true;
			body.addClass("mtg-deck-stack-body-draggable");
			body.addEventListener("dragstart", (event) => {
				const { card: targetCard, el: targetEl } = resolveDraggedStackCard(cardGroup, cardEls, event.clientY);
				this.draggingDeckStackCardId = targetCard.scryfallId;
				draggingCardEl = targetEl;
				targetEl.addClass("mtg-deck-stack-card-dragging");
				container.addClass("mtg-deck-stack-dragging-active");
				// setData nécessaire pour que certains navigateurs acceptent de
				// démarrer le drag du tout — la valeur elle-même n'est pas
				// relue ailleurs (voir draggingDeckStackCardId, view.ts).
				event.dataTransfer?.setData("text/plain", targetCard.scryfallId);
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = "move";
					// Ghost par défaut = l'élément qui a reçu le mousedown natif,
					// presque jamais targetEl une fois résolu géométriquement
					// (voir resolveDraggedStackCard) — sans ce setDragImage
					// explicite, l'aperçu suivant le curseur montrerait
					// systématiquement une autre carte que celle réellement
					// déplacée.
					const targetRect = targetEl.getBoundingClientRect();
					event.dataTransfer.setDragImage(targetEl, targetRect.width / 2, targetRect.height / 2);
				}
			});
			body.addEventListener("dragend", () => {
				this.draggingDeckStackCardId = null;
				dragHighlightedColumn?.removeClass("mtg-deck-stack-column-drop-target");
				dragHighlightedColumn = null;
				draggingCardEl?.removeClass("mtg-deck-stack-card-dragging");
				draggingCardEl = null;
				container.removeClass("mtg-deck-stack-dragging-active");
			});
		}
	});

	if (canDragFunction) {
		container.addEventListener("dragover", (event) => {
			if (!this.draggingDeckStackCardId) return;
			const column = (event.target as HTMLElement | null)?.closest<HTMLElement>(".mtg-deck-stack-column") ?? null;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			if (column === dragHighlightedColumn) return;
			dragHighlightedColumn?.removeClass("mtg-deck-stack-column-drop-target");
			dragHighlightedColumn = column;
			dragHighlightedColumn?.addClass("mtg-deck-stack-column-drop-target");
		});
		container.addEventListener("drop", (event) => {
			event.preventDefault();
			const scryfallId = this.draggingDeckStackCardId;
			const targetLabel = dragHighlightedColumn?.dataset.stackFunctionLabel;
			dragHighlightedColumn?.removeClass("mtg-deck-stack-column-drop-target");
			dragHighlightedColumn = null;
			this.draggingDeckStackCardId = null;
			if (!scryfallId || !targetLabel) return;
			const card = deck.cards.find((c) => c.scryfallId === scryfallId);
			if (!card || getDeckCardFunction(card) === targetLabel) return;
			this.plugin.setDeckCardFunction(deck.id, scryfallId, targetLabel);
			this.render();
		});
	}
}

export function updateDeckStacksLayout(this: MTGCollectionView) {
	const container = this.containerEl.querySelector<HTMLElement>(".mtg-collection-list-stacks");
	if (!container) return;
	const columns = Array.from(container.querySelectorAll<HTMLElement>(".mtg-deck-stack-column")).sort(
		(a, b) => Number(a.dataset.stackOrder) - Number(b.dataset.stackOrder)
	);
	if (columns.length === 0) return;

	// clientWidth exclut la bordure mais pas le padding, d'où la soustraction
	// explicite ci-dessous — .mtg-collection-list n'a aucun padding
	// horizontal aujourd'hui, mais mieux vaut rester correct si ça change un
	// jour plutôt que de supposer silencieusement zéro.
	const style = getComputedStyle(container);
	const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
	const availableWidth = container.clientWidth - paddingX;
	const maxTracksFromWidth = Math.floor(
		(availableWidth + STACK_TRACK_GAP_PX) / (STACK_TRACK_MIN_WIDTH_PX + STACK_TRACK_GAP_PX)
	);
	// Jamais plus de pistes que de groupes — inutile de créer des pistes
	// vides pour un regroupement épars (ex. Group by Rarity à 4 groupes sur
	// un panneau très large) alors qu'une piste par groupe suffit déjà à
	// remplir toute la largeur disponible.
	const trackCount = Math.max(1, Math.min(columns.length, maxTracksFromWidth));

	if (trackCount < maxTracksFromWidth) {
		const maxTrackWidthPx = Math.max(STACK_TRACK_MIN_WIDTH_PX, (availableWidth - 3 * STACK_TRACK_GAP_PX) / 4);
		container.setCssProps({ "--mtg-stack-track-max-width": `${maxTrackWidthPx}px` });
	} else {
		// "none" explicite (pas juste "ne pas poser la propriété") : le
		// fallback CSS de var(--mtg-stack-track-max-width, ...) doit rester
		// un filet de sécurité pour l'tout premier appel seulement (voir son
		// propre commentaire dans styles.css), jamais une valeur dont CETTE
		// branche dépendrait pour rester correcte à une largeur de panneau
		// qu'un futur changement du fallback pourrait un jour rendre trop
		// petite.
		container.setCssProps({ "--mtg-stack-track-max-width": "none" });
	}

	// .remove() ne détruit jamais les descendants en mémoire, seulement leur
	// attache au document — les références déjà capturées dans `columns`
	// ci-dessus restent utilisables juste après pour les rattacher ailleurs.
	container.querySelectorAll(".mtg-deck-stack-track").forEach((track) => track.remove());

	const tracks: HTMLElement[] = [];
	const trackHeights: number[] = [];
	for (let i = 0; i < trackCount; i++) {
		tracks.push(container.createDiv({ cls: "mtg-deck-stack-track" }));
		trackHeights.push(0);
	}

	columns.forEach((column) => {
		const estimatedHeight = estimateStackColumnHeight(Number(column.dataset.stackCardCount) || 0);
		let shortestIndex = 0;
		for (let i = 1; i < trackCount; i++) {
			if (trackHeights[i] < trackHeights[shortestIndex]) shortestIndex = i;
		}
		tracks[shortestIndex].appendChild(column);
		trackHeights[shortestIndex] += estimatedHeight;
	});

	// Re-échantillonne le radius responsive de la vue Carte APRÈS avoir
	// réparti ces piles dans leurs pistes définitives — nécessaire ici, pas
	// seulement dans render() (voir son propre commentaire), parce que
	// setupCardTileRadiusObserver (shared-render-helpers.ts) et
	// setupDeckStacksLayoutObserver ci-dessous sont deux ResizeObserver
	// INDÉPENDANTS sur le même this.mainEl : rien ne garantit l'ordre dans
	// lequel deux observers indépendants livrent leurs callbacks respectifs
	// pour un même redimensionnement, donc un appel isolé côté render()
	// suffirait pour CE cas précis mais pas pour un redimensionnement de
	// panneau seul. updateCardTileRadius échantillonne la PREMIÈRE
	// .mtg-card-tile-thumb-shadow-wrap trouvée dans le document — y compris
	// une carte de cette vue Stacks (renderThumbWithBadge y est appelé en
	// variante "tile", la même que la vue Carte) — donc sans ce ré-appel ICI,
	// un redimensionnement pourrait re-mesurer une pile juste avant qu'elle
	// soit replacée dans sa piste, pas juste après.
	this.updateCardTileRadius();
}

// Séparé de setupCardTileRadiusObserver (src/view/shared-render-helpers.ts)
// plutôt qu'ajouté à son unique callback existant : préoccupation
// entièrement différente (Stacks/My Decks contre le radius responsive de la
// vue Carte), donc un changement confiné à ce fichier sans toucher un
// mécanisme déjà éprouvé et sans rapport. Un 2e ResizeObserver indépendant
// sur this.mainEl (même élément persistant, même raisonnement que le
// commentaire de setupCardTileRadiusObserver) reste négligeable en coût —
// le panneau ne se redimensionne que sur un geste utilisateur explicite,
// jamais en boucle.
export function setupDeckStacksLayoutObserver(this: MTGCollectionView) {
	const observer = new ResizeObserver(() => this.updateDeckStacksLayout());
	observer.observe(this.mainEl);
}

// Voir collectionCardRowSignature (My Collection) pour le principe général.

export function deckCardRowSignature(this: MTGCollectionView, deck: Deck, card: DeckCard, isSelected: boolean): string {
	// Légalité du format du deck (badge, voir buildDeckCardRow/buildDeckCardTile)
	// — même raison d'être que les champs de prix ci-dessous : n'est PAS un champ de
	// DeckCard, une ligne construite avant que legalitiesCache soit rempli
	// (voir bulkFetchLegalities, renderDeckDetail) resterait sinon figée sans
	// badge pour toujours.
	const legalityStatus = deck.format
		? this.plugin.getCachedLegalities(card.scryfallId)?.[deck.format]
		: undefined;
	return [
		card.imageUrl,
		card.setCode,
		card.rarity,
		card.name,
		card.manaCost,
		card.setName,
		card.collectorNumber,
		card.count,
		isDeckCardOwned(card),
		// Harmonisation My Decks/My Collection (2026-08-25) — mêmes 3
		// champs que collectionCardRowSignature (collection-render.ts), même raison d'être.
		getDeckCardFinish(card),
		getDeckCardLanguage(card),
		getDeckCardCondition(card),
		isSelected,
		this.deckSelectMode,
		// Voir collectionCardRowSignature — même raison d'être pour deckViewMode.
		phoneAwareViewMode(this.deckViewMode),
		// Prix : vrai champ persisté sur DeckCard depuis 2026-09-02 (voir
		// "Data model notes", CLAUDE.md), inclus ici pour la même raison
		// que sur collectionCardRowSignature (collection-render.ts) — une ligne construite avant
		// que backfillDeckCardPrices() ait rattrapé cette carte
		// resterait sinon figée sur son placeholder de chargement pour
		// toujours (voir buildDeckCardRow/buildDeckCardTile).
		card.priceUsd,
		card.priceUsdFoil,
		card.priceEur,
		card.priceEurFoil,
		card.priceUsdEtched,
		card.priceEurEtched,
		this.plugin.settings.priceCurrency,
		deck.format ?? "",
		legalityStatus ?? "",
	].join("|");
}

// Petit badge de légalité par carte (voir deckLegalityBadge, card-search.ts)
// — rendu seulement quand deck.format est choisi ET que la légalité de
// cette carte est déjà en cache (bulkFetchLegalities, renderDeckDetail) ;
// rien tant que ce n'est pas encore chargé, plutôt qu'un badge neutre
// trompeur (un futur render() une fois le cache rempli le fera apparaître,
// voir deckCardRowSignature). Masqué en mode Tableau via CSS
// (.mtg-collection-list-table .mtg-deck-legality-badge) plutôt qu'omis
// ici — même précédent déjà établi pour .mtg-wantlist-acquired-btn (voir
// styles.css) : un enfant display:none à l'intérieur d'un ancêtre
// display:contents ne devient pas lui-même une cellule de grille, donc
// n'a aucun effet sur l'alignement des colonnes du tableau.

export function renderDeckLegalityBadge(this: MTGCollectionView, container: HTMLElement, deck: Deck, card: DeckCard) {
	if (!deck.format) return;
	const formatLabel = LEGALITY_SEARCH_FORMATS.find((f) => f.key === deck.format)?.label ?? deck.format;
	const status = this.plugin.getCachedLegalities(card.scryfallId)?.[deck.format];
	const badge = deckLegalityBadge(status, formatLabel);
	if (!badge) return;
	const el = container.createSpan({ cls: `mtg-deck-legality-badge ${badge.cls}` });
	el.setAttribute("title", badge.title);
}

// Voir buildCollectionCardRow (My Collection) pour le principe général — le clic
// principal référence this.navOrderForDeckClick plutôt que navOrder.

export function buildDeckCardRow(this: MTGCollectionView, deck: Deck, card: DeckCard, isSelected: boolean): HTMLElement {
	const row = createDiv();
	row.addClass("mtg-card-row");
	if (isSelected) row.addClass("mtg-card-row-selected");

	if (this.deckSelectMode) {
		const indicator = row.createDiv({ cls: "mtg-card-row-select-indicator" });
		setIcon(indicator, isSelected ? "check-circle-2" : "circle");
		if (isSelected) indicator.addClass("is-selected");
	}

	const finish = getDeckCardFinish(card);
	this.renderThumbWithBadge(
		row,
		card.imageUrl,
		card.setCode,
		card.rarity,
		finishHasFoilLook(finish),
		!isDeckCardOwned(card),
		"row",
		isDeckCommander(card)
	);

	const body = row.createDiv({ cls: "mtg-card-row-body" });
	// Même structure que buildCollectionCardRow/buildWantlistCardRow (harmonisation
	// My Decks/My Collection, 2026-08-25) — nameLine EST la cellule (déjà
	// stretchée en mode Tableau par la grille, voir .mtg-collection-list-
	// table), nameTextSpan (le <span> interne, seul à recevoir les
	// écouteurs de survol de l'aperçu — sinon "toute la cellule provoque
	// l'apparition de la carte", bug déjà rapporté une fois pour cette
	// même colonne côté My Collection) ne porte que la largeur du texte
	// rendu, un éventuel foil-pill vient s'ajouter à côté sans l'étirer.
	const nameLine = body.createDiv({ cls: "mtg-card-row-name-line" });
	const nameTextSpan = nameLine.createSpan({ cls: "mtg-card-row-name", text: card.name });
	if (finish !== "regular") {
		nameLine.createSpan({ cls: "mtg-foil-pill", text: getFinishLabel(finish) });
	}
	// Voir buildCollectionCardRow (My Collection) pour le principe général de cette
	// colonne/de cet aperçu.
	if (phoneAwareViewMode(this.deckViewMode) === "table") {
		const manaValueCell = body.createDiv({ cls: "mtg-table-mana-value-cell" });
		if (card.manaCost) {
			renderManaCostIcons(manaValueCell, card.manaCost, (letter) =>
				this.plugin.getManaSymbolSvg(letter)
			);
		} else {
			manaValueCell.createSpan({ cls: "mtg-table-mana-value-empty", text: "—" });
		}
		nameTextSpan.addEventListener("mouseenter", () =>
			this.showCardNamePreview(nameTextSpan, card.imageUrl)
		);
		nameTextSpan.addEventListener("mouseleave", () => this.hideCardNamePreview());
	}
	const setLine = body.createDiv({ cls: "mtg-card-row-set" });
	const setNameSpan = setLine.createSpan({ cls: "mtg-card-row-set-name", text: card.setName });
	const setNumberSpan = setLine.createSpan({
		cls: "mtg-card-row-set-number",
		text: `${card.setCode.toUpperCase()} #${card.collectorNumber}`,
	});
	// Même clic-pour-changer-d'impression que buildCollectionCardRow/buildWantlistCardRow
	// — n'existait pas ici jusqu'ici (DeckCard n'a pas de champ id propre,
	// voir "Data model notes" dans CLAUDE.md) ; changeDeckCardPrinting
	// (plugin.ts) retrouve la ligne par scryfallId + catégorie à la place.
	const openPrintingPicker = (evt: MouseEvent) => {
		if (this.deckSelectMode) return;
		evt.stopPropagation();
		new ChangePrintingModal(
			this.app,
			this.plugin,
			{ name: card.name, scryfallId: card.scryfallId },
			() => this.render(),
			"deck",
			{ deckId: deck.id, category: getDeckCardCategory(card) }
		).open();
	};
	[setNameSpan, setNumberSpan].forEach((el) => {
		el.setAttribute("title", "Click to change printing");
		el.addEventListener("click", openPrintingPicker);
	});
	this.renderDeckLegalityBadge(setLine, deck, card);

	// Langue/état — même structure/mêmes classes que buildCollectionCardRow (My
	// Collection), harmonisation 2026-08-25. En mode Tableau,
	// .mtg-card-row-tags s'aplatit déjà (règle générique, partagée avec
	// Collection — voir .mtg-collection-list-table plus haut dans
	// styles.css) : les 2 colonnes "Language"/"Condition" correspondantes
	// existent déjà dans TABLE_COLUMNS_DECK (card-sorting.ts).
	const tagsLine = body.createDiv({ cls: "mtg-card-row-tags" });

	const langTrigger = tagsLine.createSpan({ cls: "mtg-icon-trigger" });
	createLanguageIcon(langTrigger, getDeckCardLanguage(card));
	langTrigger.setAttribute("title", getLanguage(getDeckCardLanguage(card)).label);
	langTrigger.addEventListener("click", (evt) => {
		if (this.deckSelectMode) return;
		evt.stopPropagation();
		void this.plugin.getAvailableLanguages(card.setCode, card.collectorNumber).then((availableCodes) => {
			const options = languagePickerOptions(availableCodes);
			openPickerMenu(
				langTrigger,
				options.map((l) => ({
					render: (el) => {
						createFlagImg(el, l.flag, "mtg-flag-img mtg-flag-img-inline");
						el.createSpan({ text: l.label });
					},
					onSelect: () => {
						this.plugin.setDeckCardLanguage(deck.id, card.scryfallId, l.code);
						this.render();
					},
				}))
			);
		});
	});

	const condTrigger = tagsLine.createSpan({ cls: "mtg-icon-trigger" });
	createConditionIcon(condTrigger, getDeckCardCondition(card));
	condTrigger.setAttribute("title", getCondition(getDeckCardCondition(card)).label);
	condTrigger.addEventListener("click", (evt) => {
		if (this.deckSelectMode) return;
		evt.stopPropagation();
		openPickerMenu(
			condTrigger,
			CONDITIONS.map((c) => ({
				render: (el) => {
					createConditionIcon(el, c.value, "mtg-picker-condition-glyph");
					el.createSpan({ text: c.label });
				},
				onSelect: () => {
					this.plugin.setDeckCardCondition(deck.id, card.scryfallId, c.value);
					this.render();
				},
			}))
		);
	});

	const stepper = row.createDiv({ cls: "mtg-stepper" });
	stepper.addEventListener("click", (evt) => evt.stopPropagation());
	const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
	const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(upBtn, "chevron-up");
	controls.createDiv({ cls: "mtg-stepper-value", text: String(card.count) });
	const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(downBtn, "chevron-down");
	upBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		this.plugin.changeDeckCardCount(deck.id, card.scryfallId, 1, () => this.render());
	});
	downBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		this.plugin.changeDeckCardCount(deck.id, card.scryfallId, -1, () => this.render());
	});

	// Colonne "Legality", mode Tableau uniquement — demandée explicitement
	// pour voir d'un coup d'œil la légalité de tout le deck, sans passer
	// par List/Grid/Card. Reprend le même point coloré que
	// renderDeckLegalityBadge (setLine ci-dessus, masqué en mode Tableau —
	// voir son propre commentaire sur les colonnes fixes de la grille),
	// mais dans sa propre cellule dédiée plutôt qu'ajouté à une cellule
	// existante : setLine devient TROIS cellules distinctes en mode
	// Tableau (voir "mtg-card-row-set { display: contents }" plus haut
	// dans ce fichier), un badge ajouté là s'y serait retrouvé comme une
	// 4ᵉ cellule imprévue et aurait décalé toutes les colonnes suivantes.
	// Contrairement au badge des 3 autres vues (qui n'affiche RIEN tant
	// qu'il n'y a pas de format/de statut connu — voir son propre
	// commentaire), cette cellule affiche toujours quelque chose ("—" par
	// défaut) pour que la colonne reste correctement alignée avec le
	// reste du tableau, même sur une ligne sans donnée. deckCardRowSignature
	// inclut déjà deck.format et le statut en cache — même raisonnement
	// que pour la colonne Price juste en dessous.
	if (phoneAwareViewMode(this.deckViewMode) === "table") {
		const legalityCell = row.createDiv({ cls: "mtg-card-row-legality" });
		if (!deck.format) {
			legalityCell.setText("—");
		} else {
			const status = this.plugin.getCachedLegalities(card.scryfallId)?.[deck.format];
			if (status === undefined) {
				renderLoadingDots(legalityCell);
			} else {
				const formatLabel =
					LEGALITY_SEARCH_FORMATS.find((f) => f.key === deck.format)?.label ?? deck.format;
				const badge = deckLegalityBadge(status, formatLabel);
				if (badge) {
					const dot = legalityCell.createSpan({ cls: `mtg-deck-legality-badge ${badge.cls}` });
					dot.setAttribute("title", badge.title);
				} else {
					legalityCell.setText("—");
				}
			}
		}
	}

	// Colonne "Price" — affichée dans les 4 vues depuis cette demande
	// explicite ("comme quand nous sommes dans My Collection"), pas
	// seulement en mode Tableau comme à l'origine ; le total
	// (.mtg-card-row-price-total) reste masqué en mode Tableau via la
	// règle CSS partagée existante (.mtg-collection-list-table .mtg-card-
	// row-price-total), même principe que buildCollectionCardRow (My Collection).
	// DeckCard porte désormais un vrai prix persisté (voir "Data model
	// notes", CLAUDE.md, 2026-09-02) — même 6 champs foil-aware que
	// CollectionCard, plus de repli "regular" forcé : une carte de deck foil
	// affiche maintenant son vrai prix foil, pas son prix non-foil.
	// `card.priceUsd === undefined` = pas encore rattrapé (voir
	// backfillDeckCardPrices, plugin.ts — placeholder de chargement, voir
	// renderLoadingDots) ; deckCardRowSignature inclut déjà ces 6 champs pour
	// que la ligne se reconstruise une fois le rattrapage résolu (sans
	// quoi le cache de ligne la garderait figée sur le placeholder).
	const priceBox = row.createDiv({ cls: "mtg-card-row-price" });
	if (card.priceUsd === undefined) {
		const loadingEl = priceBox.createDiv({ cls: "mtg-card-row-price-unit" });
		renderLoadingDots(loadingEl);
	} else {
		const currency = this.plugin.settings.priceCurrency;
		const priced = toDeckPricedCard(card);
		const unitPrice = formatCardPrice(priced, currency);
		priceBox.createDiv({ cls: "mtg-card-row-price-unit", text: unitPrice });
		if (unitPrice !== "—") {
			priceBox.createDiv({
				cls: "mtg-card-row-price-total",
				text: `total ${formatMoney(cardValue(priced, currency), currency)}`,
			});
		}
	}

	row.addEventListener("click", () => {
		if (this.deckSelectMode) {
			if (this.selectedDeckCardIds.has(card.scryfallId)) {
				this.selectedDeckCardIds.delete(card.scryfallId);
			} else {
				this.selectedDeckCardIds.add(card.scryfallId);
			}
			this.render();
			return;
		}
		new DeckCardDetailModal(this.app, this.plugin, this, deck, card, this.navOrderForDeckClick).open();
	});

	return row;
}

// Vue Carte (My Decks) — voir buildCollectionCardTile (My Collection) pour le principe
// général. DeckCard porte maintenant les mêmes champs finish/langue/
// condition (harmonisation My Decks/My Collection, 2026-08-25), et un
// prix s'affiche aussi désormais (voir priceLine plus bas) — un vrai
// champ persisté sur DeckCard depuis le 2026-09-02 (voir CLAUDE.md "Data
// model notes"), foil-aware comme CollectionCard, plus un cache session
// séparé à interroger.

export function buildDeckCardTile(this: MTGCollectionView, deck: Deck, card: DeckCard, isSelected: boolean): HTMLElement {
	const tile = createDiv();
	tile.addClass("mtg-card-row", "mtg-card-tile");
	if (isSelected) tile.addClass("mtg-card-row-selected");

	if (this.deckSelectMode) {
		const indicator = tile.createDiv({ cls: "mtg-card-row-select-indicator" });
		setIcon(indicator, isSelected ? "check-circle-2" : "circle");
		if (isSelected) indicator.addClass("is-selected");
	}

	const finish = getDeckCardFinish(card);
	this.renderThumbWithBadge(
		tile,
		card.imageUrl,
		card.setCode,
		card.rarity,
		finishHasFoilLook(finish),
		!isDeckCardOwned(card),
		"tile",
		isDeckCommander(card)
	);

	const info = tile.createDiv({ cls: "mtg-card-tile-info" });

	// Ligne 1 : icône d'édition + code/numéro à gauche ; langue, état,
	// foil à droite — même structure que buildCollectionCardTile (My Collection),
	// harmonisation 2026-08-25.
	const row1 = info.createDiv({ cls: "mtg-card-tile-row1" });
	const row1Left = row1.createDiv({ cls: "mtg-card-tile-row1-left" });
	const setIconEl = row1Left.createSpan({ cls: "mtg-card-tile-set-icon" });
	void this.plugin.getSetIconSvg(card.setCode).then((svg) => {
		if (!svg) return;
		setSvgMarkup(setIconEl, svg);
		const svgEl = setIconEl.querySelector("svg");
		if (svgEl) {
			// Un peu plus grand que le badge en coin qu'il remplace (13px) —
			// ici il porte seul l'identification de l'édition, sans logo
			// redondant sur l'image (voir renderThumbWithBadge).
			svgEl.setAttribute("width", "16");
			svgEl.setAttribute("height", "16");
		}
		applySvgColor(setIconEl, getRarityColor(card.rarity));
	});
	const setNumberSpan = row1Left.createSpan({
		cls: "mtg-card-row-set-number",
		text: `${card.setCode.toUpperCase()} #${card.collectorNumber}`,
	});
	// Même clic-pour-changer-d'impression que la vue Liste/Tableau
	// (buildDeckCardRow) et que buildWantlistCardTile — voir son propre
	// commentaire.
	setNumberSpan.setAttribute("title", "Click to change printing");
	setNumberSpan.addEventListener("click", (evt) => {
		if (this.deckSelectMode) return;
		evt.stopPropagation();
		new ChangePrintingModal(
			this.app,
			this.plugin,
			{ name: card.name, scryfallId: card.scryfallId },
			() => this.render(),
			"deck",
			{ deckId: deck.id, category: getDeckCardCategory(card) }
		).open();
	});
	this.renderDeckLegalityBadge(row1Left, deck, card);

	// row1Right : langue/état/foil — même structure/mêmes classes que
	// buildCollectionCardTile (My Collection), harmonisation 2026-08-25.
	const row1Right = row1.createDiv({ cls: "mtg-card-tile-row1-right" });

	const langTrigger = row1Right.createSpan({ cls: "mtg-icon-trigger" });
	createLanguageIcon(langTrigger, getDeckCardLanguage(card));
	langTrigger.setAttribute("title", getLanguage(getDeckCardLanguage(card)).label);
	langTrigger.addEventListener("click", (evt) => {
		if (this.deckSelectMode) return;
		evt.stopPropagation();
		void this.plugin.getAvailableLanguages(card.setCode, card.collectorNumber).then((availableCodes) => {
			const options = languagePickerOptions(availableCodes);
			openPickerMenu(
				langTrigger,
				options.map((l) => ({
					render: (el) => {
						createFlagImg(el, l.flag, "mtg-flag-img mtg-flag-img-inline");
						el.createSpan({ text: l.label });
					},
					onSelect: () => {
						this.plugin.setDeckCardLanguage(deck.id, card.scryfallId, l.code);
						this.render();
					},
				}))
			);
		});
	});

	const condTrigger = row1Right.createSpan({ cls: "mtg-icon-trigger" });
	createConditionIcon(condTrigger, getDeckCardCondition(card));
	condTrigger.setAttribute("title", getCondition(getDeckCardCondition(card)).label);
	condTrigger.addEventListener("click", (evt) => {
		if (this.deckSelectMode) return;
		evt.stopPropagation();
		openPickerMenu(
			condTrigger,
			CONDITIONS.map((c) => ({
				render: (el) => {
					createConditionIcon(el, c.value, "mtg-picker-condition-glyph");
					el.createSpan({ text: c.label });
				},
				onSelect: () => {
					this.plugin.setDeckCardCondition(deck.id, card.scryfallId, c.value);
					this.render();
				},
			}))
		);
	});

	if (finish !== "regular") {
		row1Right.createSpan({ cls: "mtg-foil-pill", text: getFinishLabel(finish) });
	}

	// Ligne 2 : quantité, flèches horizontales — voir buildCollectionCardTile (My
	// Collection) pour le principe général. Pas de garde deckSelectMode sur
	// les clics ici, comme dans buildDeckCardRow d'origine : ce comportement
	// (contrairement à Collection/Wantlist) n'a jamais bloqué le stepper en
	// mode sélection.
	const qtyRow = info.createDiv({ cls: "mtg-card-tile-qty-row" });
	// mtg-card-tile-stepper : boutons +/- agrandis, scopés à la vue Carte
	// uniquement — la fenêtre de détail garde ses propres boutons à leur
	// taille d'origine (mtg-stepper-horizontal seul), ce modificateur ne
	// s'applique qu'ici.
	const stepper = qtyRow.createDiv({ cls: "mtg-stepper mtg-stepper-horizontal mtg-card-tile-stepper" });
	stepper.addEventListener("click", (evt) => evt.stopPropagation());
	const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
	const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(downBtn, "minus");
	downBtn.toggleClass("is-disabled", card.count <= 1);
	controls.createDiv({ cls: "mtg-stepper-value", text: String(card.count) });
	const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(upBtn, "plus");
	upBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		this.plugin.changeDeckCardCount(deck.id, card.scryfallId, 1, () => this.render());
	});
	downBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		this.plugin.changeDeckCardCount(deck.id, card.scryfallId, -1, () => this.render());
	});

	// Ligne prix — même classe/mise en page que buildCollectionCardTile (My
	// Collection, "toujours créée, min-height réservé en CSS" pour que les
	// tuiles d'une même rangée gardent toutes la même hauteur), demandé
	// explicitement le même jour ("affiche le prix... sur les autres
	// styles de présentation également, comme quand nous sommes dans My
	// Collection"). Voir buildDeckCardRow ci-dessus pour le raisonnement
	// complet sur la source du prix (vrai champ persisté, foil-aware) et
	// l'état de chargement.
	const priceLine = info.createDiv({ cls: "mtg-card-tile-price-line" });
	if (card.priceUsd === undefined) {
		renderLoadingDots(priceLine);
	} else {
		const currency = this.plugin.settings.priceCurrency;
		const priced = toDeckPricedCard(card);
		const unitPrice = formatCardPrice(priced, currency);
		if (unitPrice !== "—") {
			priceLine.createSpan({ cls: "mtg-card-row-price-unit", text: unitPrice });
			priceLine.createSpan({
				cls: "mtg-card-tile-price-total-inline",
				text: ` · total ${formatMoney(cardValue(priced, currency), currency)}`,
			});
		}
	}

	tile.addEventListener("click", () => {
		if (this.deckSelectMode) {
			if (this.selectedDeckCardIds.has(card.scryfallId)) {
				this.selectedDeckCardIds.delete(card.scryfallId);
			} else {
				this.selectedDeckCardIds.add(card.scryfallId);
			}
			this.render();
			return;
		}
		new DeckCardDetailModal(this.app, this.plugin, this, deck, card, this.navOrderForDeckClick).open();
	});

	return tile;
}

/* ----------------------------- Wantlists ------------------------------ */

