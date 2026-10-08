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

// See openCollectionCardDetailById (collection-render.ts)/openWantlistCardDetailById
// (wantlist-render.ts) — same reasoning, on the deck side (harmonization explicitly
// requested: the Deck's "Add cards" window had until now neither a clickable tile
// once added, nor a history panel, unlike My Collection/My Wantlists). Looks up the
// row by (deckId, scryfallId) rather than by an id of its own: DeckCard has none (see
// data-model.ts), scryfallId is already the key that
// changeDeckCardCount/removeDeckCard/undoAddToDeck use to find a row in a given deck.
// Public since 2026-09-08, same reason as those two methods (cross-section "Copies in
// Lists").

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
			// { id, count } — id = scryfallId here (see the comment of
			// openDeckCardDetailById above), same convention that
			// syncFromHistory/onDetailClosed already expect from the 2 other flows.
			onDetailClosed(freshRow ? { id: freshRow.scryfallId, count: freshRow.count } : undefined);
		};
	}
	modal.open();
}


// "Board" tabs (Mainboard/Sideboard/Maybeboard), under the Group by/Sort
// by/display modes bar (renderGroupSortBar) — replaces the old "Category"
// grouping (removed from DECK_GROUP_BY_OPTIONS, card-sorting.ts, on explicit
// request: "Commander is not a category"). Applies in ALL views
// (List/Grid/Table/Card/Stacks, not just Stacks) — filters deck.cards BEFORE
// the usual text filter/Group by/Sort by on the caller's side
// (renderDeckDetail), which keep applying normally INSIDE the active tab
// (explicitly confirmed — the tab doesn't replace the grouping, it just
// filters the displayed subset of cards). Each counter counts the physical
// COPIES (sum of count) over the ENTIRE deck, not the subset already
// filtered by the search — consistent with the fact that the tabs remain a
// stable overview of the deck, independent of what is typed in the search
// bar above. Takes the full width of the window (3 tabs at equal `flex: 1`,
// see .mtg-deck-board-tabs/-tab, styles.css) — explicitly requested in the
// same screenshot as the move above.

export function renderDeckBoardTabs(this: MTGCollectionView, deck: Deck, container: HTMLElement) {
	const tabs = container.createDiv({ cls: "mtg-deck-board-tabs" });
	// Root of the real bug behind "still as abrupt" despite two attempts at different
	// CSS durations/curves: these buttons are recreated from scratch on EVERY render()
	// (see render(), view.ts — this.bodyEl.cloneNode(false), the whole subtree rebuilt
	// then swapped via replaceWith), and the old click handler called this.render()
	// directly — the new active tab was therefore born already with .is-active from its
	// very first paint, never in the process of GOING from gray to accent on an
	// existing DOM node. No CSS transition duration/curve can play in this case: "a
	// class already present at the very first paint of an element triggers no
	// transition, only a class change on an ALREADY existing element does" (same
	// principle already established for legalFormatsShownFor/the Graded block,
	// CardDetailModal). Fixed by toggling .is-active directly on the real nodes already
	// displayed (which, for their part, stay in place for the duration of the
	// transition), then deferring the actual render() (needed to refresh the filtered
	// card list below) until the CSS transition has finished playing — same idiom as
	// the collapse of the Graded/Custom Price block (CardDetailModal.close) or
	// toggleGroupRows (src/view/shared-render-helpers.ts). this.deckActiveBoard remains
	// the single source of truth: a quick double-click between two tabs simply
	// schedules two deferred render() calls that both end up at the same correct state,
	// without ever corrupting anything.
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
			// 350ms = exactly the duration of the CSS transition declared on
			// .mtg-deck-board-tab (styles.css) — lets the color fade play through to
			// the end before render() replaces these nodes.
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
	// Clear included here (like My Collection) to benefit from the same
	// disabled toggle at 0 selection as the rest; Select all is deliberately
	// excluded from it, it is precisely the useful button when nothing is
	// selected yet.
	const actionButtons: HTMLButtonElement[] = [clearBtn];

	// Move/copy to a list, a deck or a wantlist — same CopyCardModal (sourceKind: "deck") as
	// the individual "Deck"/"Copy card to…" button of DeckCardDetailModal, able to take
	// several cards at once exactly like its My Collection counterpart (moveBtn/copyBtn in
	// renderCollectionBulkActionsBar, collection-render.ts). deckContext provides the source
	// deck, necessary here since a DeckCard has no id of its own (see
	// CopyCardModal.deckContext).
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
				// The cards have left this deck (moved elsewhere) — the selection no
				// longer points to valid rows here, same behavior as "Move to" in My
				// Collection.
				this.selectedDeckCardIds.clear();
				this.render();
			},
			"move",
			{ deckId }
		).open();
	});

	// Copying removes nothing from the currently displayed deck, so does NOT
	// clear selectedDeckCardIds — same behavior as "Copy to" in My Collection.
	const copyBtn = bar.createEl("button", { text: "Copy to", cls: "mtg-bulk-action-btn" });
	actionButtons.push(copyBtn);
	copyBtn.addEventListener("click", () => {
		const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
		const cards = (deck?.cards ?? []).filter((c) => this.selectedDeckCardIds.has(c.scryfallId));
		if (cards.length === 0) return;
		new CopyCardModal(this.app, this.plugin, cards, "deck", () => this.render(), "copy", { deckId }).open();
	});

	// "Board" (Mainboard/Sideboard/Maybeboard) — same 3 options as the "Board"
	// picker of DeckCardDetailModal (DECK_BOARD_TABS), applied to the whole
	// selection instead of one card at a time.
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

	// "Function" (Ramp/Removal/Draw/etc., see DECK_FUNCTION_CATEGORIES) — same
	// picker as the "Function" box of DeckCardDetailModal, with "Auto" at the
	// top to go back to automatic detection on the whole selection (no precise
	// "detected" to preview here, unlike the card-by-card picker, since
	// several different cards can be selected at once).
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

	// Change the condition — same idioms as Condition/Language/Finish on the My Collection side
	// (renderCollectionBulkActionsBar, collection-render.ts), on bulkSetDeckCardCondition/Language/Finish
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

	// Set the quantity
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
		// Same mousedown/preventDefault fix as My Collection: without it, the blur
		// (hence commit) fires before the click of Cancel.
		cancelQtyBtn.addEventListener("mousedown", (e) => e.preventDefault());
		cancelQtyBtn.addEventListener("click", () => {
			input.removeEventListener("blur", commit);
			this.render();
		});
	});

	// Export the selection to a file (CSV, same columns as buildDeckCsvString/exportDeckCsv, or
	// TXT) — same "Export" button with a choice of format as My Collection
	// (renderCollectionBulkActionsBar, collection-render.ts).
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

	// Separator before Delete — same treatment as My Collection, to visually
	// isolate the destructive action from the rest.
	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	// Remove from the deck — two-step confirmation (neutral button → red
	// "Delete"/"Cancel" pair), same idiom as My Collection instead of the old
	// "Confirm remove?" text with no possibility of canceling. Label "Delete"
	// (like My Collection/My Wantlists, renamed on 2026-09-08 — see the
	// comment at the head of the function): only deletes the row in this deck
	// (bulkRemoveDeckCards), never the card of the collection/wantlist it
	// comes from.
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

// Same principle as listSelectionTxtLines (collection-render.ts), on the deck
// side — shared between exportDeckSelectionTxt and copyDeckSelectionTxt.

export function deckSelectionTxtLines(this: MTGCollectionView, deckId: string): string {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	const cards = (deck?.cards ?? []).filter((c) => this.selectedDeckCardIds.has(c.scryfallId));
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportDeckSelectionTxt(this: MTGCollectionView, deckId: string) {
	this.downloadTextFile(this.deckSelectionTxtLines(deckId), "mtg-deck-selection.txt");
}

// Deck counterpart of My Collection's "Copy TXT" — see
// copyListSelectionTxt (collection-render.ts) for the reasoning on
// .catch().

export function copyDeckSelectionTxt(this: MTGCollectionView, deckId: string) {
	const count = this.selectedDeckCardIds.size;
	navigator.clipboard
		.writeText(this.deckSelectionTxtLines(deckId))
		.then(() => new Notice(`Copied ${count} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}

// Deck counterpart of exportListSelectionCsv (My Collection) — current
// selection (renderDeckBulkActionsBar), not the entire deck (see
// exportDeckCsv further down). Reuses buildDeckCsvString/downloadDeckCsv as
// is — same input shape ({card, deckName}[]) as exportDeckCsv, a lone
// DeckCard doesn't know which deck it comes from once extracted from
// Deck.cards.

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

// Equivalent of buildListCsvString for one or several decks at once. entries
// carries the name of the source deck per row (same reasoning as the
// "List"/"Wantlist" column of the two other exports) rather than a simple
// CollectionCard[], since a lone DeckCard doesn't know which deck it comes
// from once extracted from Deck.cards.
// Columns
// Finish/Language/Condition/GradingCompany/GradingGrade/GradingLabel/CustomPrice
// added during the My Decks/My Collection harmonization (2026-08-25) — same
// order/same names as buildListCsvString (My Collection,
// collection-render.ts), "Deck" in place of "List". PriceUsd column added on
// 2026-09-02 once DeckCard was given a real persisted price (see "Data model
// notes", CLAUDE.md) — same position/same name as buildListCsvString (just
// before the "List"/"Deck" column), `c.priceUsd ?? ""` rather than a fallback
// via toDeckPricedCard: this column wants the RAW price as is (same
// convention as c.priceUsd in buildListCsvString, never formatted/converted),
// not the foil-aware value already resolved according to the finish (what
// toDeckPricedCard/formatCardPrice compute for display).

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

// Same trio Export CSV/Export TXT/Copy to clipboard as
// exportListCsv/exportListTxt/copyListTxt (collection-render.ts), on the deck
// side (DeckSettingsModal, harmonized on ListSettingsModal) — for a SINGLE deck
// this time, not the selection of the bulk actions bar of the "My Decks" grid
// (exportDeckSelectionTxt/copyDeckSelectionTxt a bit higher up, which concern the
// cards ticked inside an already open deck, a different subset).

export function exportDeckCsv(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	if (!deck) return;
	const filename = `mtg-deck-${deck.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
	this.downloadDeckCsv(
		deck.cards.map((card) => ({ card, deckName: deck.name })),
		filename
	);
}

// Same "qty - name" format as listTxtLines
// (collection-render.ts)/wantlistSelectionTxtLines (wantlist-render.ts),
// for a SINGLE whole deck.

export function deckTxtLines(this: MTGCollectionView, deckId: string): string {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	return (deck?.cards ?? []).map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportDeckTxt(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	const filename = `mtg-deck-${(deck?.name ?? "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
	this.downloadTextFile(this.deckTxtLines(deckId), filename);
}

// navigator.clipboard.writeText: same precedent already established (see
// copyListTxt, collection-render.ts) — explicit .catch() rather than a resolution
// assumed to always happen.

export function copyDeckTxt(this: MTGCollectionView, deckId: string) {
	const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
	const cardCount = deck?.cards.length ?? 0;
	navigator.clipboard
		.writeText(this.deckTxtLines(deckId))
		.then(() => new Notice(`Copied ${cardCount} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}

// "Import" → "Import CSV" of DeckSettingsModal — goes through plugin.importDeckCsv (new: until now a deck had no
// CSV import path at all, see its own comment in plugin.ts) rather than importCsv; the file flow is that of
// file-import.ts.

export function triggerImportIntoDeck(this: MTGCollectionView, deckId: string) {
	importCsvFile(this, {
		accept: ".csv",
		progressTitle: "Importing deck…",
		skippedLabel: "skipped",
		run: (text, onStatus) => this.plugin.importDeckCsv(deckId, text, onStatus),
	});
}

// "Import" → "Import TXT" of DeckSettingsModal — reuses plugin.importDecklistToDeck (already existing, see
// NewDeckModal — this method has always been able to target any existing deck, not just a freshly created one)
// rather than writing a 2nd decklist resolution path.

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
		// A search with no results is not "no deck": same message as the
		// Collection/Wantlists galleries in this case.
		this.bodyEl.createEl("p", {
			text:
				filter && this.plugin.settings.decks.length > 0
					? "No deck matches your filter."
					: "No decks yet. Use \"+ New deck\" to create one.",
			cls: "mtg-status",
		});
		return;
	}

	// "Sort by" bar, on the same model as "My Collection".
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

	// Small "Decks: …" title with the number of decks, "x of y decks match"
	// during a search — same title (and same class) as "Lists" in
	// renderListGrid, explicitly requested for the 3 galleries.
	this.bodyEl.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle("deck", decks.length, this.plugin.settings.decks.length, filter !== ""),
	});

	// Automatic number of columns (1/2/4 depending on the panel's width) — see
	// renderListGrid and .mtg-set-grid-wrap in styles.css.
	const gridWrap = this.bodyEl.createDiv({ cls: "mtg-set-grid-wrap" });
	const grid = gridWrap.createDiv({
		cls: `mtg-set-grid${this.deckGallerySelectMode ? " mtg-gallery-selecting" : ""}`,
	});
	decks.forEach((deck) => {
		const tile = grid.createDiv({ cls: "mtg-set-tile" });
		// Manual choice (Deck.coverCardId, "Choose cover image" of
		// DeckSettingsModal harmonized on ListSettingsModal) otherwise automatic
		// fallback (the deck's Commander, otherwise the 1st card — see
		// resolveDeckCoverImage/pickDeckCoverImage, core/price.ts) rather than
		// just the 1st card with an image found in deck.cards.
		const cover = resolveDeckCoverImage(deck.cards, deck.coverCardId);
		if (cover) {
			const bg = tile.createDiv({ cls: "mtg-set-tile-bg" });
			bg.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.85)), url("${cover}")`;
		}
		const content = tile.createDiv({ cls: "mtg-set-tile-content" });

		// Pictogram chosen manually (Deck.deckIcon, "Choose icon" of
		// DeckSettingsModal) — same recipe as renderListTile (see its own comment
		// for the full reasoning, transposed as is: nested row rather than
		// vertical centering of the whole tile, since a deck keeps its background
		// gradient darkened toward the bottom like a normal list).
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
		// Format at the head of the stats line, when chosen (see Deck.format and
		// NewDeckModal/DeckSettingsModal) — same LEGALITY_SEARCH_FORMATS list as
		// everywhere else in the plugin to resolve the label.
		const formatLabel = deck.format
			? LEGALITY_SEARCH_FORMATS.find((f) => f.key === deck.format)?.label
			: undefined;
		textParent.createDiv({
			cls: "mtg-set-tile-meta",
			text: `${formatLabel ? formatLabel + " · " : ""}${deck.cards.length} unique · ${totalQty} cards`,
		});
		// Color pips of the deck (union of the colors of its cards, see
		// deckColorIdentity) — same official Scryfall symbols as everywhere else
		// in the plugin (getManaSymbolSvg), modeled on the pips Moxfield displays
		// on its own deck thumbnails.
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

// Bulk actions bar of the "My Decks" grid — same structure as
// renderListGalleryBulkActionsBar, adapted to Deck/DeckCard.

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

	// Flex-column scaffolding (see .mtg-collection-body-detail, styles.css):
	// stickyHeader (natural height) then .mtg-detail-scroll-area (the rest of
	// the available height, with its own scrollbar — see further down) thus
	// share the whole height of this.bodyEl, which itself takes the whole
	// height of this.mainEl in this mode. Removed on every render() (see
	// higher up in render()) before potentially being added back here — never
	// inherited as is via cloneNode(false).
	this.bodyEl.addClass("mtg-collection-body-detail");
	const stickyHeader = this.bodyEl.createDiv({ cls: "mtg-detail-sticky-header" });

	// See renderListDetail for the full reasoning — the "← Back to X" button
	// and the title row now share a single container
	// (.mtg-detail-header-banner). resolveDeckCoverImage, already used by
	// renderDeckGrid for this deck's tile, reused here to get the same image.
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
	// Opens the settings (DeckSettingsModal) on clicking the title, instead of
	// the original inline rename — explicitly requested, renaming remains
	// accessible from this same window. openDeckSettings is reused further
	// down by menuBtn (the "..." button) to avoid duplicating the construction
	// of the modal.
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

	// "+ Add cards"/"Deck stats"/"Select cards"/"..." used to live on the
	// title row, at the very top — moved here, to the right of the search bar,
	// to gain vertical height (explicitly requested, annotated screenshot in
	// support, same change as My Collection/My Wantlists).
	const searchActionsRow = stickyHeader.createDiv({ cls: "mtg-detail-search-actions-row" });
	const filterRow = searchActionsRow.createDiv({ cls: "mtg-collection-toolbar mtg-inline-filter-row" });
	const actionsRow = searchActionsRow.createDiv({ cls: "mtg-detail-search-actions" });

	const addBtn = actionsRow.createEl("button", {
		text: "+ Add cards",
		cls: "mtg-search-add-btn",
	});
	addBtn.addEventListener("click", () => {
		const modal = new AddCardsModal(this.app, this.plugin, {
			// DeckCard has no id field of its own (see data-model.ts) — scryfallId
			// serves as the key everywhere else for a given deck
			// (changeDeckCardCount/removeDeckCard/undoAddToDeck), reused here to
			// satisfy the { id, count, listId } shape expected by
			// AddCardsModalOptions.onAdd (harmonization with Collection/Wantlist
			// explicitly requested — the Deck flow until now had neither a stepper,
			// nor a clickable tile, nor a history panel).
			onAdd: (card) => {
				const row = this.plugin.addCardToDeck(deck.id, card);
				return row ? { id: row.scryfallId, count: row.count, listId: deck.id } : undefined;
			},
			onChangeQuantity: (entryId, delta, onDone) =>
				this.plugin.changeDeckCardCount(deck.id, entryId, delta, onDone),
			onOpenDetail: (entryId, onDetailClosed) =>
				this.openDeckCardDetailById(deck.id, entryId, onDetailClosed),
			// Same reasoning as undoAddToCollection/undoAddToWantlist (onUndoAdd,
			// shared-search-ui.ts) — reshapes { id, count } from DeckCard (scryfallId,
			// not id) for the same reason as onAdd above.
			onUndoAdd: (card, _options, undoListId, delta) => {
				const row = this.plugin.undoAddToDeck(card.id, undoListId, delta);
				return row ? { id: row.scryfallId, count: row.count } : undefined;
			},
			destinationName: deck.name,
			// "deck": ChangePrintingModal/CopyCardModal accept neither one "deck" as a
			// source (see sourceKind, shared-search-ui.ts) — the "Change
			// printing"/"Move card" links of the "Add history" panel therefore never
			// display here, consistent with the already established absence of any
			// move concept for a deck card.
			sourceKind: "deck",
			// DeckCard still has no finish field (see "Data model notes" in CLAUDE.md
			// — established asymmetry, out of scope of this harmonization): no
			// Finish/Language/Condition selector exists anymore in this modal anyway
			// (the last one, specific to the Wantlist flow, was removed in turn).
			titleText: `Add cards to "${deck.name}"`,
		});
		modal.onClose = () => {
			modal.contentEl.empty();
			this.render();
		};
		modal.open();
	});

	// "Deck Stats" (2026-09-02) — mana curve/colors/types of THIS deck, see
	// DeckStatsModal. A first attempt as a 5th display mode (next to
	// List/Grid/Table/Card) was explicitly asked to be returned to a modal —
	// this header button is the entry point in place of the 5th button of the
	// list/grid/table/card cluster (renderGroupSortBar).
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

	// Deck cards limited to the active tab (see renderDeckBoardTabs higher up)
	// — the usual text filter/Group by/Sort by apply AFTERWARDS, only inside
	// this subset.
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

	// The price of a deck card is now a real persisted field on DeckCard (see
	// "Data model notes", CLAUDE.md, 2026-09-02) rather than a session cache
	// to pre-fill here on every opening — no more network round trip needed at
	// this stage: a card not yet caught up (deck created before this feature)
	// is already caught up once and for all by
	// MTGCollectionPlugin.backfillDeckCardPrices() at plugin startup, which
	// itself redraws the open views once finished.

	// Bulk pre-filling of legalitiesCache for the whole open deck, as soon as
	// a format is chosen (Deck.format) — feeds the small per-card legality
	// badge (see buildDeckCardRow/buildDeckCardTile further down,
	// deckLegalityBadge) without waiting for any "legal:" filter to be typed
	// (unlike renderListDetail, where this same grouped fetch is triggered
	// ONLY by an active filter — here it is the deck's own format that plays
	// this role). bulkFetchLegalities is already generic over any set of ids
	// (not just Collection/Wantlist), and is an instant no-op if everything is
	// already cached/in flight — safe to call again on every render().
	if (deck.format) {
		void this.plugin.bulkFetchLegalities(deck.cards.map((c) => c.scryfallId)).then((fetchedSomething) => {
			if (fetchedSomething) this.plugin.refreshOpenViews();
		});
	}

	this.renderGroupSortBar("deck", stickyHeader);

	// Mainboard/Sideboard/Maybeboard — under the Group by/Sort by/display
	// modes bar rather than above (moved on explicit request, annotated
	// screenshot in support, 2026-09-07); DOM order direct here since this
	// call needs no data computed further down.
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

	// See the equivalent comment in renderListDetail — same reasoning, the
	// Stacks view (renderDeckStacksView) builds its own content inside THIS
	// same `list`, so it inherits it too.
	const scrollArea = this.bodyEl.createDiv({ cls: "mtg-detail-scroll-area" });
	scrollArea.addEventListener("scroll", () => this.handleScrollAreaScroll(scrollArea));
	// See the equivalent comment in renderListDetail.
	setupPanelScrollFade(scrollArea);
	// "Cards: …" title — applies to the active tab
	// (Mainboard/Sideboard/Maybeboard), like the filter itself: see
	// renderCardsCountTitle.
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
		// Distinguishes "the whole deck is empty" from "this tab is empty" (e.g.
		// no Sideboard) and from "the search filter matches nothing" — without
		// which a simple empty search on a well-filled deck, or a
		// Sideboard/Maybeboard tab with no cards, wrongly displayed "This deck is
		// empty" (a message that remained correct only for the very first case
		// before the tabs were added, never a problem as long as filteredCards ===
		// deck.cards.length === 0 were equivalent).
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

	// Stacks view (Archidekt): an entirely separate column structure,
	// unrelated to the vertically stacked rows/tiles (.mtg-card-row-outer) of
	// the 4 other modes — cardGroups (not visibleGroups/deckRenderLimit): a
	// deck stays modest in size (a few dozen to ~200 cards), batch pagination
	// was not judged necessary for this 1st version.
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
			// Like the deck tiles (deck.cards.length unique · totalQty cards):
			// fullGroupCards.length counts the distinct cards, totalQty sums their
			// copies (DeckCard.count).
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
	// Column currently hovered during a drag (updated only on CHANGE in the
	// container-level dragover handler further down, never in per-column
	// dragenter/dragleave — those two events bubble up from the children and
	// otherwise flicker on every card crossed inside a same column).
	let dragHighlightedColumn: HTMLElement | null = null;
	// Card currently "picked up" (see further down, resolveDraggedStackCard) —
	// distinct from dragHighlightedColumn, same purpose: the cleanup in
	// dragend must remove the class from the card actually resolved, not from
	// a card captured by closure at construction time.
	let draggingCardEl: HTMLElement | null = null;
	cardGroups.forEach((cardGroup, groupIndex) => {
		const column = container.createDiv({ cls: "mtg-deck-stack-column" });
		// Read by updateDeckStacksLayout (further down) once this pile is attached
		// to the document — stackOrder preserves the original order of the groups
		// across several successive distributions (the pile is then not
		// necessarily a DIRECT child of `container`, see that function),
		// stackCardCount is cardGroup.cards.length (number of distinct ROWS, not
		// the total quantity — see estimateStackColumnHeight, card-sorting.ts) to
		// estimate its height without having to measure it in the DOM.
		column.dataset.stackOrder = String(groupIndex);
		column.dataset.stackCardCount = String(cardGroup.cards.length);
		if (canDragFunction) column.dataset.stackFunctionLabel = cardGroup.label;
		const header = column.createDiv({ cls: "mtg-deck-stack-header" });
		const titleRow = header.createDiv({ cls: "mtg-deck-stack-header-title" });
		// Group header crown removed (2026-09-07): it depended on "Group by
		// Category", which no longer exists (Commander became a Function, see
		// DeckCardCategory in data-model.ts) — the Commander is now spotted on
		// EACH card via .mtg-thumb-commander-badge (renderThumbWithBadge,
		// isDeckCommander), not via a group header that no longer makes sense for
		// this concept.
		titleRow.createSpan({ cls: "mtg-deck-stack-header-label", text: cardGroup.label || "Cards" });

		// "Qty" (physical copies, DeckCard.count) and "Price" (sum of the column's
		// values) — the same two pieces of information as the group header of the
		// 4 other views (mtg-group-header-count), condensed here into 2 short
		// lines rather than a single sentence, Archidekt style.
		const statsRow = header.createDiv({ cls: "mtg-deck-stack-header-stats" });
		const totalQty = cardGroup.cards.reduce((s, c) => s + c.count, 0);
		statsRow.createSpan({ text: `Qty: ${totalQty}` });
		const priceEl = statsRow.createSpan();
		// Price: real persisted field on DeckCard (see "Data model notes",
		// CLAUDE.md, 2026-09-02) — undefined = not yet caught up by
		// MTGCollectionPlugin.backfillDeckCardPrices(), same loading state as
		// buildDeckCardRow/buildDeckCardTile for an isolated card.
		if (cardGroup.cards.some((c) => c.priceUsd === undefined)) {
			renderLoadingDots(priceEl);
		} else {
			const totalValue = cardGroup.cards.reduce((s, c) => s + cardValue(toDeckPricedCard(c), currency), 0);
			priceEl.setText(`Price: ${formatMoney(totalValue, currency)}`);
		}

		const body = column.createDiv({ cls: "mtg-deck-stack-body" });
		// Parallel to cardGroup.cards (same order, same index) — the only way to
		// go back up from a geometric index (resolveDraggedStackCard further down)
		// to the real DOM element of the targeted card.
		const cardEls: HTMLElement[] = [];
		cardGroup.cards.forEach((card, cardIndex) => {
			const cardWrap = body.createDiv({ cls: "mtg-deck-stack-card" });
			cardEls.push(cardWrap);
			// Marks the pile while a card OTHER than its last one is hovered: that hover pushes the following cards
			// down (the `~` rule in styles.css) and the last one can overflow the pile, which is when the bottom fade
			// applies (.mtg-deck-stack-column-pushing). It used to be pure CSS, `.mtg-deck-stack-column:has(
			// .mtg-deck-stack-card:not(:last-child):hover)`; the directory's scanner warns about every `:has` (broad
			// selector invalidation), so the hover is followed here instead. mouseenter/mouseleave have :hover's
			// semantics (the card's descendants and its ::after hover bridge count as the card), and a move from one
			// card to the next fires the leave before the enter, so the class never shows for a frame in between.
			if (cardIndex < cardGroup.cards.length - 1) {
				cardWrap.addEventListener("mouseenter", () => column.addClass("mtg-deck-stack-column-pushing"));
				cardWrap.addEventListener("mouseleave", () => column.removeClass("mtg-deck-stack-column-pushing"));
			}
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
				// Accent ring around the card itself (see styles.css) — the only other
				// visual cue of selection on a pile card would be this small corner dot,
				// too discreet once the card is covered by its successor.
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
				// setData needed for some browsers to agree to start the drag at all — the
				// value itself isn't read back elsewhere (see draggingDeckStackCardId,
				// view.ts).
				event.dataTransfer?.setData("text/plain", targetCard.scryfallId);
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = "move";
					// Default ghost = the element that received the native mousedown, almost
					// never targetEl once resolved geometrically (see resolveDraggedStackCard)
					// — without this explicit setDragImage, the preview following the cursor
					// would systematically show a different card from the one actually being
					// moved.
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
				// No mouseenter/mouseleave during a native drag: the pile the drag started from may still carry the
				// class although the pointer is elsewhere (the next real hover sets it again).
				container.querySelectorAll(".mtg-deck-stack-column-pushing").forEach((el) => el.removeClass("mtg-deck-stack-column-pushing"));
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

	// clientWidth excludes the border but not the padding, hence the explicit
	// subtraction below — .mtg-collection-list has no horizontal padding
	// today, but better to stay correct if that changes one day than to
	// silently assume zero.
	const style = getComputedStyle(container);
	const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
	const availableWidth = container.clientWidth - paddingX;
	const maxTracksFromWidth = Math.floor(
		(availableWidth + STACK_TRACK_GAP_PX) / (STACK_TRACK_MIN_WIDTH_PX + STACK_TRACK_GAP_PX)
	);
	// Never more tracks than groups — no point creating empty tracks for a
	// sparse grouping (e.g. Group by Rarity with 4 groups on a very wide
	// panel) when one track per group is already enough to fill the whole
	// available width.
	const trackCount = Math.max(1, Math.min(columns.length, maxTracksFromWidth));

	if (trackCount < maxTracksFromWidth) {
		const maxTrackWidthPx = Math.max(STACK_TRACK_MIN_WIDTH_PX, (availableWidth - 3 * STACK_TRACK_GAP_PX) / 4);
		container.setCssProps({ "--mtg-stack-track-max-width": `${maxTrackWidthPx}px` });
	} else {
		// Explicit "none" (not just "don't set the property"): the CSS fallback of
		// var(--mtg-stack-track-max-width, ...) must remain a safety net for the
		// very first call only (see its own comment in styles.css), never a value
		// on which THIS branch would depend to stay correct at a panel width that
		// a future change of the fallback could one day make too small.
		container.setCssProps({ "--mtg-stack-track-max-width": "none" });
	}

	// .remove() never destroys the descendants in memory, only their
	// attachment to the document — the references already captured in
	// `columns` above remain usable right after to attach them elsewhere.
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
		// Re-attaching a hovered pile fires no mouseleave: do not let a stale hover mark outlive the move.
		column.removeClass("mtg-deck-stack-column-pushing");
		trackHeights[shortestIndex] += estimatedHeight;
	});

	// Re-samples the Card view's responsive radius AFTER having distributed
	// these piles into their final tracks — necessary here, not only in
	// render() (see its own comment), because setupCardTileRadiusObserver
	// (shared-render-helpers.ts) and setupDeckStacksLayoutObserver below are
	// two INDEPENDENT ResizeObservers on the same this.mainEl: nothing
	// guarantees the order in which two independent observers deliver their
	// respective callbacks for a same resize, so a lone call on the render()
	// side would suffice for THIS particular case but not for a panel resize
	// alone. updateCardTileRadius samples the FIRST
	// .mtg-card-tile-thumb-shadow-wrap found in the document — including a
	// card of this Stacks view (renderThumbWithBadge is called there in "tile"
	// variant, the same as the Card view) — so without this re-call HERE, a
	// resize could re-measure a pile just before it is put back into its
	// track, not just after.
	this.updateCardTileRadius();
}

// Separate from setupCardTileRadiusObserver
// (src/view/shared-render-helpers.ts) rather than added to its single
// existing callback: an entirely different concern (Stacks/My Decks versus
// the Card view's responsive radius), so a change confined to this file
// without touching an already proven and unrelated mechanism. A 2nd
// independent ResizeObserver on this.mainEl (same persistent element, same
// reasoning as the comment of setupCardTileRadiusObserver) remains
// negligible in cost — the panel only resizes on an explicit user gesture,
// never in a loop.
export function setupDeckStacksLayoutObserver(this: MTGCollectionView) {
	const observer = new ResizeObserver(() => this.updateDeckStacksLayout());
	observer.observe(this.mainEl);
}

// See collectionCardRowSignature (My Collection) for the general principle.

export function deckCardRowSignature(this: MTGCollectionView, deck: Deck, card: DeckCard, isSelected: boolean): string {
	// Legality of the deck's format (badge, see buildDeckCardRow/buildDeckCardTile)
	// — same purpose as the price fields below: is NOT a field of DeckCard, a row
	// built before legalitiesCache is filled (see bulkFetchLegalities,
	// renderDeckDetail) would otherwise stay frozen without a badge forever.
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
		// My Decks/My Collection harmonization (2026-08-25) — same 3 fields as
		// collectionCardRowSignature (collection-render.ts), same purpose.
		getDeckCardFinish(card),
		getDeckCardLanguage(card),
		getDeckCardCondition(card),
		isSelected,
		this.deckSelectMode,
		// See collectionCardRowSignature — same purpose for deckViewMode.
		phoneAwareViewMode(this.deckViewMode),
		// Price: real persisted field on DeckCard since 2026-09-02 (see "Data model notes",
		// CLAUDE.md), included here for the same reason as in collectionCardRowSignature
		// (collection-render.ts) — a row built before backfillDeckCardPrices() caught up this
		// card would otherwise stay frozen on its loading placeholder forever (see
		// buildDeckCardRow/buildDeckCardTile).
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

// Small per-card legality badge (see deckLegalityBadge, card-search.ts) —
// rendered only when deck.format is chosen AND this card's legality is
// already in the cache (bulkFetchLegalities, renderDeckDetail); nothing as
// long as it is not loaded yet, rather than a misleading neutral badge (a
// future render() once the cache is filled will make it appear, see
// deckCardRowSignature). Hidden in Table mode via CSS
// (.mtg-collection-list-table .mtg-deck-legality-badge) rather than omitted
// here — same precedent already established for .mtg-wantlist-acquired-btn
// (see styles.css): a display:none child inside a display:contents ancestor
// does not itself become a grid cell, so has no effect on the alignment of
// the table's columns.

export function renderDeckLegalityBadge(this: MTGCollectionView, container: HTMLElement, deck: Deck, card: DeckCard) {
	if (!deck.format) return;
	const formatLabel = LEGALITY_SEARCH_FORMATS.find((f) => f.key === deck.format)?.label ?? deck.format;
	const status = this.plugin.getCachedLegalities(card.scryfallId)?.[deck.format];
	const badge = deckLegalityBadge(status, formatLabel);
	if (!badge) return;
	const el = container.createSpan({ cls: `mtg-deck-legality-badge ${badge.cls}` });
	el.setAttribute("title", badge.title);
}

// See buildCollectionCardRow (My Collection) for the general principle — the
// main click references this.navOrderForDeckClick rather than navOrder.

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
	// Same structure as buildCollectionCardRow/buildWantlistCardRow (My Decks/My
	// Collection harmonization, 2026-08-25) — nameLine IS the cell (already
	// stretched in Table mode by the grid, see .mtg-collection-list-table),
	// nameTextSpan (the inner <span>, the only one to receive the preview hover
	// listeners — otherwise "the whole cell makes the card appear", a bug already
	// reported once for this same column on the My Collection side) only carries
	// the width of the rendered text, a possible foil-pill is added next to it
	// without stretching it.
	const nameLine = body.createDiv({ cls: "mtg-card-row-name-line" });
	const nameTextSpan = nameLine.createSpan({ cls: "mtg-card-row-name", text: card.name });
	if (finish !== "regular") {
		nameLine.createSpan({ cls: "mtg-foil-pill", text: getFinishLabel(finish) });
	}
	// See buildCollectionCardRow (My Collection) for the general principle of this
	// column/this preview.
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
	// Same click-to-change-printing as buildCollectionCardRow/buildWantlistCardRow — did
	// not exist here until now (DeckCard has no id field of its own, see "Data model
	// notes" in CLAUDE.md); changeDeckCardPrinting (plugin.ts) finds the row by
	// scryfallId + category instead.
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

	// Language/condition — same structure/same classes as
	// buildCollectionCardRow (My Collection), harmonization 2026-08-25. In
	// Table mode, .mtg-card-row-tags already flattens (generic rule, shared
	// with Collection — see .mtg-collection-list-table higher up in
	// styles.css): the 2 corresponding "Language"/"Condition" columns already
	// exist in TABLE_COLUMNS_DECK (card-sorting.ts).
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

	// "Legality" column, Table mode only — explicitly requested to see at a
	// glance the legality of the whole deck, without going through
	// List/Grid/Card. Takes up the same colored dot as renderDeckLegalityBadge
	// (setLine above, hidden in Table mode — see its own comment on the fixed
	// columns of the grid), but in its own dedicated cell rather than added to
	// an existing cell: setLine becomes THREE distinct cells in Table mode
	// (see "mtg-card-row-set { display: contents }" higher up in this file), a
	// badge added there would have ended up as an unexpected 4th cell and
	// shifted all the following columns. Unlike the badge of the 3 other views
	// (which displays NOTHING as long as there is no known format/status — see
	// its own comment), this cell always displays something ("—" by default)
	// so that the column stays correctly aligned with the rest of the table,
	// even on a row with no data. deckCardRowSignature already includes
	// deck.format and the cached status — same reasoning as for the Price
	// column just below.
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

	// "Price" column — displayed in the 4 views since this explicit request
	// ("like when we're in My Collection"), not only in Table mode as originally;
	// the total (.mtg-card-row-price-total) stays hidden in Table mode via the
	// existing shared CSS rule (.mtg-collection-list-table
	// .mtg-card-row-price-total), same principle as buildCollectionCardRow (My
	// Collection). DeckCard now carries a real persisted price (see "Data model
	// notes", CLAUDE.md, 2026-09-02) — same 6 foil-aware fields as
	// CollectionCard, no more forced "regular" fallback: a foil deck card now
	// displays its real foil price, not its non-foil price. `card.priceUsd ===
	// undefined` = not yet caught up (see backfillDeckCardPrices, plugin.ts —
	// loading placeholder, see renderLoadingDots); deckCardRowSignature already
	// includes these 6 fields so that the row is rebuilt once the catch-up
	// resolves (without which the row cache would keep it frozen on the
	// placeholder).
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

// Card view (My Decks) — see buildCollectionCardTile (My Collection) for the general
// principle. DeckCard now carries the same finish/language/condition fields (My
// Decks/My Collection harmonization, 2026-08-25), and a price is now displayed too
// (see priceLine further down) — a real persisted field on DeckCard since 2026-09-02
// (see CLAUDE.md "Data model notes"), foil-aware like CollectionCard, no more separate
// session cache to query.

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

	// Row 1: set icon + code/number on the left; language, condition, foil on the
	// right — same structure as buildCollectionCardTile (My Collection),
	// harmonization 2026-08-25.
	const row1 = info.createDiv({ cls: "mtg-card-tile-row1" });
	const row1Left = row1.createDiv({ cls: "mtg-card-tile-row1-left" });
	const setIconEl = row1Left.createSpan({ cls: "mtg-card-tile-set-icon" });
	void this.plugin.getSetIconSvg(card.setCode).then((svg) => {
		if (!svg) return;
		setSvgMarkup(setIconEl, svg);
		const svgEl = setIconEl.querySelector("svg");
		if (svgEl) {
			// A bit larger than the corner badge it replaces (13px) — here it alone
			// carries the identification of the set, without a redundant logo on the
			// image (see renderThumbWithBadge).
			svgEl.setAttribute("width", "16");
			svgEl.setAttribute("height", "16");
		}
		applySvgColor(setIconEl, getRarityColor(card.rarity));
	});
	const setNumberSpan = row1Left.createSpan({
		cls: "mtg-card-row-set-number",
		text: `${card.setCode.toUpperCase()} #${card.collectorNumber}`,
	});
	// Same click-to-change-printing as the List/Table view (buildDeckCardRow)
	// and as buildWantlistCardTile — see its own comment.
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

	// row1Right: language/condition/foil — same structure/same classes as
	// buildCollectionCardTile (My Collection), harmonization 2026-08-25.
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

	// Row 2: quantity, horizontal arrows — see buildCollectionCardTile (My
	// Collection) for the general principle. No deckSelectMode guard on the
	// clicks here, as in the original buildDeckCardRow: this behavior (unlike
	// Collection/Wantlist) never blocked the stepper in select mode.
	const qtyRow = info.createDiv({ cls: "mtg-card-tile-qty-row" });
	// mtg-card-tile-stepper: enlarged +/- buttons, scoped to the Card view
	// only — the detail window keeps its own buttons at their original size
	// (mtg-stepper-horizontal alone), this modifier only applies here.
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

	// Price row — same class/same layout as buildCollectionCardTile (My
	// Collection, "always created, min-height reserved in CSS" so that the
	// tiles of a same row all keep the same height), explicitly requested the
	// same day ("display the price... on the other presentation styles too,
	// like when we're in My Collection"). See buildDeckCardRow above for the
	// full reasoning on the price source (real persisted field, foil-aware)
	// and the loading state.
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

