import { Notice, setIcon } from "obsidian";
import {
	FINISH_OPTIONS,
	getFinishLabel,
	finishHasFoilLook,
	WantlistCard,
} from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { getRarityColor, applySvgColor, toCsvField } from "../api/scryfall";
import {
	viewModeClass,
	phoneAwareViewMode,
	TABLE_COLUMNS_WANTLIST,
	LIST_GRID_SORT_OPTIONS,
	GROUP_LABEL_HEX,
	CardGroup,
	RENDER_BATCH_SIZE,
	sliceGroupsForRender,
	groupAndSortCards,
} from "../core/card-sorting";
import {
	cardMatchesTokens,
} from "../core/card-search";
import {
	formatCardPrice,
	cardValue,
	formatMoney,
	pickCoverImage,
	WantlistGroup,
	groupByWantlist,
} from "../core/price";
import {
	ALL_WANTED_ID,
} from "../core/data-model";
import { formatCountTitle } from "../core/count-title";
import { ZipEntry } from "../core/zip";
import {
	renderManaCostIcons,
	setupPanelScrollFade,
} from "../ui/card-detail-fx";
import { renderCardsCountTitle } from "./shared-render-helpers";
import { createBulkActionsBar, replaceInBulkBar } from "./bulk-actions-bar";
import { WantlistSettingsModal } from "../modals/wantlist-settings-modal";
import { AddCardsModal } from "../modals/add-cards-modal";
import { ChangePrintingModal } from "../modals/change-printing-modal";
import { MarkAsAcquiredModal } from "../modals/mark-as-acquired-modal";
import { importCsvFile, importDecklistFile } from "./file-import";
import { MergeWantlistsModal } from "../modals/merge-modals";
import { WantlistCardDetailModal } from "../modals/wantlist-card-detail-modal";
import type { MTGCollectionView } from "../view";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  My Wantlists: section/grid/detail rendering, row + tile building,
    bulk-actions bar, CSV/TXT export/import, wantlist open/close. Split out
    of view.ts on 2026-09-10 ("Phase 5b").  */
/* -------------------------------------------------------------------------- */

export function triggerImportWantlist(this: MTGCollectionView, targetWantlistId?: string) {
	importCsvFile(this, {
		accept: ".csv,text/csv",
		skippedLabel: "not found",
		run: (text, onStatus) => this.plugin.importWantlistCsv(text, onStatus, targetWantlistId),
	});
}


export function openAddWantlistCardsModal(this: MTGCollectionView, wantlistId: string, wantlistName: string) {
	const modal = new AddCardsModal(this.app, this.plugin, {
		onAdd: (card, options) => this.plugin.addCardToWantlist(card, wantlistId, { finish: options.finish }),
		onChangeQuantity: (entryId, delta, onDone) => this.plugin.changeWantlistCardCount(entryId, delta, onDone),
		// See openCollectionCardDetailById/openWantlistCardDetailById for the full
		// reasoning (same idea, on the wantlist side).
		onOpenDetail: (entryId, onDetailClosed) => this.openWantlistCardDetailById(entryId, onDetailClosed),
		onUndoAdd: (card, options, undoListId, delta) =>
			this.plugin.undoAddToWantlist(card.id, undoListId, options.finish, delta),
		destinationName: wantlistName,
		sourceKind: "wantlist",
		titleText: `Add cards to "${wantlistName}"`,
	});
	modal.onClose = () => {
		modal.contentEl.empty();
		this.render();
	};
	modal.open();
}

// See openCollectionCardDetailById (collection-render.ts) — same reasoning, on the wantlist
// side; public since 2026-09-08 for the same reason (cross-section "Copies in Lists").

export function openWantlistCardDetailById(this: MTGCollectionView, 
	entryId: string,
	onDetailClosed?: (row: { id: string; count: number } | undefined) => void
) {
	const card = this.plugin.settings.wantlist.find((c) => c.id === entryId);
	if (!card) return;
	const modal = new WantlistCardDetailModal(this.app, this.plugin, this, card, [card]);
	if (onDetailClosed) {
		const originalOnClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			originalOnClose();
			const freshRow = this.plugin.settings.wantlist.find((c) => c.id === entryId);
			onDetailClosed(freshRow ? { id: freshRow.id, count: freshRow.count } : undefined);
		};
	}
	modal.open();
}

export function openAddWantlistCardsModalWithListPicker(this: MTGCollectionView) {
	const wantlists = this.plugin.settings.wantlists;
	if (wantlists.length === 0) {
		new Notice("Create a wantlist first (Wantlists → + New wantlist).");
		return;
	}
	const summaries = groupByWantlist(
		wantlists,
		this.plugin.settings.wantlist,
		this.plugin.settings.priceCurrency
	);
	const modal = new AddCardsModal(this.app, this.plugin, {
		onAdd: (card, options, wantlistId) => {
			if (!wantlistId) return;
			return this.plugin.addCardToWantlist(card, wantlistId, { finish: options.finish });
		},
		onChangeQuantity: (entryId, delta, onDone) => this.plugin.changeWantlistCardCount(entryId, delta, onDone),
		onOpenDetail: (entryId, onDetailClosed) => this.openWantlistCardDetailById(entryId, onDetailClosed),
		onUndoAdd: (card, options, undoListId, delta) =>
			this.plugin.undoAddToWantlist(card.id, undoListId, options.finish, delta),
		sourceKind: "wantlist",
		titleText: "Add cards",
		listGallery: { summaries, kind: "wantlist" },
	});
	modal.onClose = () => {
		modal.contentEl.empty();
		this.render();
	};
	modal.open();
}



export function renderWantlistBulkActionsBar(this: MTGCollectionView,
	container: HTMLElement,
	currentWantlistId: string,
	animate: boolean,
	visibleCardIds: string[]
) {
	const bar = createBulkActionsBar(this, "wantlist-cards", container, animate);

	bar.createSpan({
		cls: "mtg-bulk-actions-count",
		text: `${this.selectedWantlistCardIds.size} selected`,
	});

	const selectionUtils = bar.createDiv({ cls: "mtg-bulk-selection-utils" });
	const selectAllBtn = selectionUtils.createEl("button", {
		text: "Select all",
		cls: "mtg-bulk-action-btn",
	});
	selectAllBtn.addEventListener("click", () => {
		visibleCardIds.forEach((id) => this.selectedWantlistCardIds.add(id));
		this.render();
	});
	const clearBtn = selectionUtils.createEl("button", { text: "Clear", cls: "mtg-bulk-action-btn" });
	clearBtn.addEventListener("click", () => {
		this.selectedWantlistCardIds.clear();
		this.render();
	});

	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	const selectedIds = () => Array.from(this.selectedWantlistCardIds);
	// Clear included here (like My Collection), Select all deliberately
	// excluded — see the equivalent comment in renderDeckBulkActionsBar.
	const actionButtons: HTMLButtonElement[] = [clearBtn];

	// Opens a modal (not a dropdown menu): no caret, same treatment as "Move
	// to"/"Copy to" in My Collection.
	const acquiredBtn = bar.createEl("button", {
		text: "Mark as acquired",
		cls: "mtg-bulk-action-btn",
	});
	actionButtons.push(acquiredBtn);
	acquiredBtn.addEventListener("click", () => {
		if (this.plugin.settings.lists.length === 0) {
			new Notice("Create a collection list first (Collection → + New list).");
			return;
		}
		new MarkAsAcquiredModal(this.app, this.plugin, this, selectedIds()).open();
	});

	const moveWantlistBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
	moveWantlistBtn.createSpan({ text: "Move to wantlist" });
	setIcon(moveWantlistBtn.createSpan({ cls: "mtg-bulk-action-btn-caret" }), "chevron-down");
	actionButtons.push(moveWantlistBtn);
	moveWantlistBtn.addEventListener("click", () => {
		const options = this.plugin.settings.wantlists.filter((w) => w.id !== currentWantlistId);
		if (options.length === 0) {
			new Notice("No other wantlist to move to.");
			return;
		}
		openPickerMenu(
			moveWantlistBtn,
			options.map((w) => ({
				render: (el) => el.createSpan({ text: w.name }),
				onSelect: () => {
					const count = this.selectedWantlistCardIds.size;
					this.plugin.bulkMoveWantlistCardsToWantlist(selectedIds(), w.id);
					this.selectedWantlistCardIds.clear();
					new Notice(`Moved ${count} card(s) to "${w.name}".`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

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
					this.plugin.bulkSetWantlistCardFinish(selectedIds(), f.value);
					new Notice(`Finish set to ${f.label}.`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

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
			const count = this.selectedWantlistCardIds.size;
			this.plugin.bulkSetWantlistCardCount(selectedIds(), Number(input.value));
			new Notice(`Quantity set to ${Math.max(1, Math.floor(Number(input.value)) || 1)} for ${count} card(s).`);
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

	// Export to a file (CSV/TXT of your choice) — same "Export" button as My
	// Collection (collection-render.ts)/My Decks (deck-render.ts).
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
					onSelect: () => this.exportWantlistSelectionCsv(),
				},
				{
					render: (el) => el.createSpan({ text: "TXT" }),
					onSelect: () => this.exportWantlistSelectionTxt(),
				},
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	const copyTxtBtn = bar.createEl("button", { text: "Copy to clipboard", cls: "mtg-bulk-action-btn" });
	actionButtons.push(copyTxtBtn);
	copyTxtBtn.addEventListener("click", () => this.copyWantlistSelectionTxt());

	// Separator before Delete — same treatment as My Collection.
	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	// Delete — two-step confirmation, same idiom as My Collection instead of
	// the old "Confirm delete?" text with no possibility of canceling.
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
			const count = this.selectedWantlistCardIds.size;
			this.plugin.bulkRemoveWantlistCards(selectedIds());
			this.selectedWantlistCardIds.clear();
			new Notice(`Deleted ${count} card(s).`);
			this.render();
		});
		cancelBtn.addEventListener("click", () => this.render());
	});

	if (this.selectedWantlistCardIds.size === 0) {
		actionButtons.forEach((btn) => (btn.disabled = true));
	}
}


// Same principle as listSelectionTxtLines (collection-render.ts), on the
// wantlist side — shared between exportWantlistSelectionTxt and
// copyWantlistSelectionTxt.

export function wantlistSelectionTxtLines(this: MTGCollectionView): string {
	const cards = this.plugin.settings.wantlist.filter((c) => this.selectedWantlistCardIds.has(c.id));
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportWantlistSelectionTxt(this: MTGCollectionView) {
	this.downloadTextFile(this.wantlistSelectionTxtLines(), "mtg-wantlist-selection.txt");
}

// Wantlist counterpart of My Collection's "Copy TXT" — see
// copyListSelectionTxt (collection-render.ts) for the reasoning on .catch().

export function copyWantlistSelectionTxt(this: MTGCollectionView) {
	const count = this.selectedWantlistCardIds.size;
	navigator.clipboard
		.writeText(this.wantlistSelectionTxtLines())
		.then(() => new Notice(`Copied ${count} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}

export function exportWantlistCsv(this: MTGCollectionView, wantlistId: string) {
	const wantlist = this.plugin.settings.wantlists.find((w) => w.id === wantlistId);
	const cards = this.plugin.settings.wantlist.filter((c) => c.listId === wantlistId);
	const filename = `mtg-wantlist-${(wantlist?.name ?? "wantlist").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
	this.downloadWantlistCsv(cards, filename);
}

// Same "qty - name" format as listTxtLines (collection-render.ts), but for the
// ENTIRE wantlist (WantlistSettingsModal, "Export"/"Copy to clipboard") rather
// than the current selection — see wantlistSelectionTxtLines above, a different
// subset of settings.wantlist.

export function wantlistTxtLines(this: MTGCollectionView, wantlistId: string): string {
	const cards = this.plugin.settings.wantlist.filter((c) => c.listId === wantlistId);
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportWantlistTxt(this: MTGCollectionView, wantlistId: string) {
	const wantlist = this.plugin.settings.wantlists.find((w) => w.id === wantlistId);
	const filename = `mtg-wantlist-${(wantlist?.name ?? "wantlist").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
	this.downloadTextFile(this.wantlistTxtLines(wantlistId), filename);
}

// navigator.clipboard.writeText: same precedent already established (see
// copyListTxt, collection-render.ts) — explicit .catch() rather than a resolution
// assumed to always happen.

export function copyWantlistTxt(this: MTGCollectionView, wantlistId: string) {
	const cardCount = this.plugin.settings.wantlist.filter((c) => c.listId === wantlistId).length;
	navigator.clipboard
		.writeText(this.wantlistTxtLines(wantlistId))
		.then(() => new Notice(`Copied ${cardCount} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}


export function exportWantlistSelectionCsv(this: MTGCollectionView) {
	const cards = this.plugin.settings.wantlist.filter((c) => this.selectedWantlistCardIds.has(c.id));
	this.downloadWantlistCsv(cards, "mtg-wantlist-selection.csv");
}

export function buildWantlistCsvString(this: MTGCollectionView, cards: WantlistCard[]): string {
	const header = "Name,Set,SetCode,CollectorNumber,Rarity,Count,Finish,PriceUsd,Wantlist\n";
	const rows = cards
		.map((c) =>
			[
				toCsvField(c.name),
				toCsvField(c.setName),
				c.setCode,
				c.collectorNumber,
				c.rarity,
				c.count,
				c.finish,
				c.priceUsd,
				toCsvField(this.plugin.settings.wantlists.find((w) => w.id === c.listId)?.name ?? ""),
			].join(",")
		)
		.join("\n");
	return header + rows;
}


export function downloadWantlistCsv(this: MTGCollectionView, cards: WantlistCard[], filename: string) {
	this.downloadTextFile(this.buildWantlistCsvString(cards), filename, "text/csv");
}

export function wantlistGroupsToTxtLines(this: MTGCollectionView, groups: WantlistGroup[]): string {
	return groups
		.map((g) => `# ${g.name}\n` + g.cards.map((c) => `${c.count} - ${c.name}`).join("\n"))
		.join("\n\n");
}

// Same principle, on the deck side.

export function triggerImportIntoWantlist(this: MTGCollectionView, wantlistId: string) {
	this.triggerImportWantlist(wantlistId);
}

// "Import TXT" of WantlistSettingsModal — same thing as triggerImportTxtIntoList (collection-render.ts),
// on the wantlist side (plugin.importDecklistToWantlist).

export function triggerImportTxtIntoWantlist(this: MTGCollectionView, wantlistId: string) {
	const wantlist = this.plugin.settings.wantlists.find((w) => w.id === wantlistId);
	importDecklistFile(this, {
		noun: "wantlist",
		entityName: () => wantlist?.name,
		run: (text, onStatus) => this.plugin.importDecklistToWantlist(wantlistId, text, onStatus),
	});
}

// Creates a card's thumbnail with the set symbol as a badge, bottom right,
// colored according to rarity (as on real cards / Delver).
// Collapses/expands ONE row at a time via a pure CSS class
// ("grid-template-rows: 0fr / 1fr" technique on the .mtg-card-row-outer
// wrapper) — no measurement nor JS-driven animation, so no state to
// desynchronize on quick clicks (that was the cause of the groups that
// refused to reopen). Far smoother than the old max-height approach, which
// forced a layout recalculation on every frame.
// Table mode excepted: the row is flattened there (display:contents) and
// therefore has no box of its own — neither height nor opacity to animate
// on the wrapper itself. A light fade is applied directly to each CELL
// (name, set, price, etc., which each have their own box) before hiding the
// row — not a true fluid collapse, just a slightly softer disappearance
// than an instant toggle.


export function openWantlist(this: MTGCollectionView, wantlistId: string) {
	this.activeSection = "wantlists";
	this.openWantlistId = wantlistId;
	// See the equivalent comment in openList().
	this.selectedWantlistIds.clear();
	this.wantlistGallerySelectMode = false;
	this.render();
}


export function closeWantlistIfOpen(this: MTGCollectionView, wantlistId: string) {
	if (this.openWantlistId === wantlistId) this.openWantlistId = null;
	this.render();
}

/* ------------------------------- Decks -------------------------------- */


export function renderWantlistsSection(this: MTGCollectionView) {
	const wantlist = this.plugin.settings.wantlist;
	const currency = this.plugin.settings.priceCurrency;
	const totalCards = wantlist.reduce((sum, c) => sum + c.count, 0);
	const totalValue = wantlist.reduce((sum, c) => sum + cardValue(c, currency), 0);

	if (this.openWantlistId) {
		this.headerTitleEl.setText("");
		this.headerStatsEl.setText("");
	} else {
		this.headerTitleEl.setText("Wantlists");
		this.headerStatsEl.setText(
			`${this.plugin.settings.wantlists.length} wantlists · ${totalCards} cards · ${formatMoney(totalValue, currency)}`
		);
	}

	if (this.plugin.settings.wantlists.length === 0) {
		this.bodyEl.createEl("p", {
			text: "No wantlists yet. Use \"+ New wantlist\" to create one.",
			cls: "mtg-status",
		});
		return;
	}

	if (this.openWantlistId) {
		this.renderWantlistDetail(this.openWantlistId);
	} else {
		this.renderWantlistGrid();
	}
}


export function renderWantlistGrid(this: MTGCollectionView) {
	const filter = this.wantlistFilterEl.value.trim().toLowerCase();
	let groups = groupByWantlist(
		this.plugin.settings.wantlists,
		this.plugin.settings.wantlist,
		this.plugin.settings.priceCurrency
	).filter((g) => !filter || g.name.toLowerCase().includes(filter));

	const sortBy = this.plugin.settings.wantlistGridSortBy;
	const sortReverse = this.plugin.settings.wantlistGridSortReverse;
	const wantlistsById = new Map(this.plugin.settings.wantlists.map((w) => [w.id, w]));
	groups = [...groups].sort((a, b) => {
		let cmp = 0;
		switch (sortBy) {
			case "name":
				cmp = a.name.localeCompare(b.name);
				break;
			case "dateCreated":
				cmp = (wantlistsById.get(a.id)?.dateCreated ?? 0) - (wantlistsById.get(b.id)?.dateCreated ?? 0);
				break;
			case "cardCount":
				cmp = a.totalQty - b.totalQty;
				break;
			case "price":
				cmp = a.totalValue - b.totalValue;
				break;
		}
		return sortReverse ? -cmp : cmp;
	});

	const showAllWanted = !filter || "all wanted".includes(filter);

	if (groups.length === 0 && !showAllWanted) {
		this.bodyEl.createEl("p", {
			text: "No wantlist matches your filter.",
			cls: "mtg-status",
		});
		return;
	}

	const sortRow = this.bodyEl.createDiv({ cls: "mtg-groupsort-row" });

	const sortCluster = sortRow.createDiv({ cls: "mtg-groupsort-cluster" });
	const sortBtn = sortCluster.createDiv({ cls: "mtg-groupsort-btn" });
	setIcon(sortBtn.createSpan({ cls: "mtg-groupsort-icon" }), "list-filter");
	sortBtn.createSpan({ text: "Sort by " });
	sortBtn.createSpan({
		cls: "mtg-groupsort-value",
		text: LIST_GRID_SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? "",
	});
	sortBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		openPickerMenu(
			sortBtn,
			LIST_GRID_SORT_OPTIONS.map((opt) => ({
				render: (el) => el.createSpan({ text: opt.label }),
				onSelect: () => {
					this.plugin.settings.wantlistGridSortBy = opt.value;
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
		this.plugin.settings.wantlistGridSortReverse = !this.plugin.settings.wantlistGridSortReverse;
		void this.plugin.saveSettings();
		this.render();
	});

	if (this.wantlistGallerySelectMode) {
		this.renderWantlistGalleryBulkActionsBar(
			this.bodyEl,
			!this.wantlistGalleryBulkBarWasVisible,
			groups.map((g) => g.id)
		);
		this.wantlistGalleryBulkBarWasVisible = true;
	} else {
		this.wantlistGalleryBulkBarWasVisible = false;
	}

	// Small "Wantlists: …" title with the number of wantlists, "x of y
	// wantlists match" during a search — same title (and same class) as "Lists"
	// in renderListGrid, explicitly requested for the 3 galleries. "All Wanted"
	// (virtual tile) is counted in neither number: it is not one of the user's
	// wantlists.
	this.bodyEl.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle(
			"wantlist",
			groups.length,
			this.plugin.settings.wantlists.length,
			filter !== ""
		),
	});

	// Automatic number of columns (1/2/4 depending on the panel's width) — see
	// renderListGrid and .mtg-set-grid-wrap in styles.css.
	const gridWrap = this.bodyEl.createDiv({ cls: "mtg-set-grid-wrap" });
	const grid = gridWrap.createDiv({
		cls: `mtg-set-grid${this.wantlistGallerySelectMode ? " mtg-gallery-selecting" : ""}`,
	});

	if (showAllWanted && this.plugin.settings.wantlists.length > 0) {
		const allCards = this.plugin.settings.wantlist;
		this.renderWantlistTile(grid, {
			id: ALL_WANTED_ID,
			name: "All wanted",
			cards: allCards,
			totalQty: allCards.reduce((s, c) => s + c.count, 0),
			totalValue: allCards.reduce((s, c) => s + cardValue(c, this.plugin.settings.priceCurrency), 0),
			coverImage: pickCoverImage(allCards),
		});
	}

	groups.forEach((group) => this.renderWantlistTile(grid, group));
}


export function renderWantlistTile(this: MTGCollectionView, grid: HTMLElement, group: WantlistGroup) {
	const isVirtual = group.id === ALL_WANTED_ID;
	const tile = grid.createDiv({
		cls: `mtg-set-tile${isVirtual ? " mtg-set-tile-all-wanted" : ""}`,
	});
	// "All Wanted" treated exactly like "All Cards" on the My Collection side
	// (explicitly requested, screenshot in support): no background
	// image/gradient, fixed dark gray instead (.mtg-set-tile-all-wanted,
	// modeled on .mtg-set-tile-all-cards) — see renderListTile for the full
	// reasoning, transposed as is here.
	if (group.coverImage && !isVirtual) {
		const bg = tile.createDiv({ cls: "mtg-set-tile-bg" });
		bg.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.85)), url("${group.coverImage}")`;
	}
	const content = tile.createDiv({ cls: "mtg-set-tile-content" });

	// Virtual aggregate "All Wanted": pictogram (the same heart as "My
	// Wantlists" in the left menu) + text, anchored at the BOTTOM of the tile
	// — not the vertically centered layout of Inbox/"All Cards"
	// (mtg-set-tile-content-pinned) but the same nested row
	// (mtg-set-tile-icon-row) as a normal list with a manually chosen
	// pictogram just below: explicitly requested ("just put the elements at
	// the bottom, as we do for lists") after a first vertically centered
	// attempt — "All Wanted" shares the grid of the normal wantlists
	// (min-height 200px, .mtg-set-tile) rather than the dedicated
	// reduced-height grid of Inbox/"All Cards" (.mtg-pinned-tiles-grid,
	// 100px), where the centering was barely noticeable; here it left a
	// visible gap above the text. content therefore keeps its default
	// flex-direction/justify-content (column, anchored at the bottom) instead
	// of the -pinned modifier, exactly as for the manual icon below.
	let textParent: HTMLElement = content;
	if (isVirtual) {
		const iconRow = content.createDiv({ cls: "mtg-set-tile-icon-row" });
		const iconCircle = iconRow.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
		setIcon(iconCircle, "heart");
		textParent = iconRow.createDiv({ cls: "mtg-set-tile-pinned-text" });
	}

	// Pictogram chosen manually (WantlistSettingsModal, "Choose icon") — same block/same
	// reasoning as renderListTile (collection-render.ts, see its own comment), transposed as
	// is on the wantlist side: never for the virtual aggregate "All Wanted" (no real Wantlist
	// behind it, so no icon to set on it).
	if (group.icon && !isVirtual) {
		const iconRow = content.createDiv({ cls: "mtg-set-tile-icon-row" });
		const iconCircle = iconRow.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
		const fetchIcon =
			group.icon.kind === "mana"
				? this.plugin.getManaSymbolSvg(group.icon.value)
				: this.plugin.getSetIconSvg(group.icon.value);
		void fetchIcon.then((svg) => {
			if (!svg) return;
			setSvgMarkup(iconCircle, svg);
			if (group.icon!.kind === "set") applySvgColor(iconCircle, "#ffffff");
		});
		textParent = iconRow.createDiv({ cls: "mtg-set-tile-pinned-text" });
	}

	textParent.createDiv({ cls: "mtg-set-tile-name", text: group.name });
	textParent.createDiv({
		cls: "mtg-set-tile-meta",
		text: `${group.cards.length} unique · ${group.totalQty} cards`,
	});
	textParent.createDiv({
		cls: "mtg-set-tile-value",
		text: formatMoney(group.totalValue, this.plugin.settings.priceCurrency),
	});

	const isSelected = !isVirtual && this.selectedWantlistIds.has(group.id);
	if (this.wantlistGallerySelectMode && !isVirtual) {
		tile.toggleClass("mtg-set-tile-selected", isSelected);
		const indicator = tile.createDiv({ cls: "mtg-set-tile-select-indicator" });
		setIcon(indicator, isSelected ? "check-circle-2" : "circle");
		if (isSelected) indicator.addClass("is-selected");
	}

	tile.addEventListener("click", () => {
		if (this.wantlistGallerySelectMode) {
			if (isVirtual) return;
			if (this.selectedWantlistIds.has(group.id)) this.selectedWantlistIds.delete(group.id);
			else this.selectedWantlistIds.add(group.id);
			this.render();
			return;
		}
		this.openWantlistId = group.id;
		this.lastFocusedFilterKey = null;
		this.wantlistCardFilterTokens = [];
		this.wantlistCardFilterDraft = "";
		this.selectedWantlistCardIds.clear();
		this.wantlistSelectMode = false;
		this.wantlistBulkBarWasVisible = false;
		this.render();
	});

	if (!isVirtual && !this.wantlistGallerySelectMode) {
		const menuBtn = tile.createDiv({ cls: "mtg-tile-menu-btn" });
		setIcon(menuBtn, "more-vertical");
		menuBtn.setAttribute("title", "Wantlist settings");
		menuBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			new WantlistSettingsModal(this.app, this.plugin, this, group.id).open();
		});
	}
}

// Bulk actions bar of the "My Wantlists" grid — same structure as
// renderListGalleryBulkActionsBar.

export function renderWantlistGalleryBulkActionsBar(this: MTGCollectionView, 
	container: HTMLElement,
	animate: boolean,
	visibleWantlistIds: string[]
) {
	const bar = createBulkActionsBar(this, "wantlist-gallery", container, animate);

	bar.createSpan({
		cls: "mtg-bulk-actions-count",
		text: `${this.selectedWantlistIds.size} selected`,
	});

	const selectionUtils = bar.createDiv({ cls: "mtg-bulk-selection-utils" });
	const selectAllBtn = selectionUtils.createEl("button", {
		text: "Select all",
		cls: "mtg-bulk-action-btn",
	});
	selectAllBtn.addEventListener("click", () => {
		visibleWantlistIds.forEach((id) => this.selectedWantlistIds.add(id));
		this.render();
	});
	const clearBtn = selectionUtils.createEl("button", { text: "Clear", cls: "mtg-bulk-action-btn" });
	clearBtn.addEventListener("click", () => {
		this.selectedWantlistIds.clear();
		this.render();
	});

	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	const actionButtons: HTMLButtonElement[] = [clearBtn];

	const selectedGroups = () =>
		groupByWantlist(
			this.plugin.settings.wantlists,
			this.plugin.settings.wantlist,
			this.plugin.settings.priceCurrency
		).filter((g) => this.selectedWantlistIds.has(g.id));

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
						const cards = selectedGroups().flatMap((g) => g.cards);
						this.downloadWantlistCsv(cards, "mtg-wantlists-selection.csv");
					},
				},
				{
					render: (el) => el.createSpan({ text: "One file per wantlist (.zip)" }),
					onSelect: () => {
						const entries: ZipEntry[] = selectedGroups().map((g) => ({
							name: `${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`,
							content: this.buildWantlistCsvString(g.cards),
						}));
						this.downloadZip(entries, "mtg-wantlists-selection.zip");
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
						const count = this.selectedWantlistIds.size;
						navigator.clipboard
							.writeText(this.wantlistGroupsToTxtLines(selectedGroups()))
							.then(() => new Notice(`Copied ${count} wantlist(s) to clipboard.`))
							.catch(() => new Notice("Could not copy to clipboard."));
					},
				},
				{
					render: (el) => el.createSpan({ text: "Combined file (.txt)" }),
					onSelect: () =>
						this.downloadTextFile(
							this.wantlistGroupsToTxtLines(selectedGroups()),
							"mtg-wantlists-selection.txt"
						),
				},
				{
					render: (el) => el.createSpan({ text: "One file per wantlist (.zip)" }),
					onSelect: () => {
						const entries: ZipEntry[] = selectedGroups().map((g) => ({
							name: `${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`,
							content: this.wantlistGroupsToTxtLines([g]),
						}));
						this.downloadZip(entries, "mtg-wantlists-selection.zip");
					},
				},
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// Merges the selected wantlists into a new one — same reasoning as the
	// "Merge" button of My Collection (see
	// renderListGalleryBulkActionsBar/MergeWantlistsModal).
	const mergeBtn = bar.createEl("button", { text: "Merge", cls: "mtg-bulk-action-btn" });
	actionButtons.push(mergeBtn);
	mergeBtn.disabled = this.selectedWantlistIds.size < 2;
	mergeBtn.addEventListener("click", () => {
		new MergeWantlistsModal(this.app, this.plugin, this, Array.from(this.selectedWantlistIds)).open();
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
			const count = this.selectedWantlistIds.size;
			this.plugin.bulkDeleteWantlists(Array.from(this.selectedWantlistIds));
			this.selectedWantlistIds.clear();
			new Notice(`Deleted ${count} wantlist(s).`);
			this.render();
		});
		cancelBtn.addEventListener("click", () => this.render());
	});

	if (this.selectedWantlistIds.size === 0) {
		actionButtons.forEach((btn) => (btn.disabled = true));
	}
}


export function renderWantlistDetail(this: MTGCollectionView, wantlistId: string) {
	const isVirtual = wantlistId === ALL_WANTED_ID;
	const group = isVirtual
		? {
				id: ALL_WANTED_ID,
				name: "All wanted",
				cards: this.plugin.settings.wantlist,
				totalQty: this.plugin.settings.wantlist.reduce((s, c) => s + c.count, 0),
				totalValue: this.plugin.settings.wantlist.reduce(
					(s, c) => s + cardValue(c, this.plugin.settings.priceCurrency),
					0
				),
				coverImage: pickCoverImage(this.plugin.settings.wantlist),
		  }
		: groupByWantlist(
				this.plugin.settings.wantlists,
				this.plugin.settings.wantlist,
				this.plugin.settings.priceCurrency
		  ).find((g) => g.id === wantlistId);
	if (!group) {
		this.openWantlistId = null;
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

	// See renderListDetail for the full reasoning — group.coverImage already
	// computed above (pickCoverImage/groupByWantlist, core/price.ts).
	const headerBanner = stickyHeader.createDiv({ cls: "mtg-detail-header-banner" });
	if (group.coverImage) {
		const bannerBg = headerBanner.createDiv({ cls: "mtg-detail-banner-bg" });
		bannerBg.style.backgroundImage = `url("${group.coverImage}")`;
		headerBanner.createDiv({ cls: "mtg-detail-banner-scrim" });
	}

	const backBtn = headerBanner.createEl("button", {
		text: "← Back to wantlists",
		cls: "mtg-back-btn",
	});
	backBtn.addEventListener("click", () => {
		this.openWantlistId = null;
		this.lastFocusedFilterKey = null;
		this.wantlistCardFilterTokens = [];
		this.wantlistCardFilterDraft = "";
		this.selectedWantlistCardIds.clear();
		this.wantlistSelectMode = false;
		this.wantlistBulkBarWasVisible = false;
		this.render();
	});

	const titleRow = headerBanner.createDiv({ cls: "mtg-deck-title-row" });
	const titleInfo = titleRow.createDiv({ cls: "mtg-title-info" });
	// Opens the settings (WantlistSettingsModal) on clicking the title,
	// instead of the original inline rename — explicitly requested, renaming
	// remains accessible from this same window. openWantlistSettings is reused
	// further down by menuBtn (the "..." button) to avoid duplicating the
	// construction of the modal. isVirtual ("All Wanted") has no settings at
	// all (no menuBtn either, see further down): title not clickable, as
	// before.
	const openWantlistSettings = () =>
		new WantlistSettingsModal(this.app, this.plugin, this, group.id).open();
	if (!isVirtual) {
		const nameRow = titleInfo.createDiv({ cls: "mtg-detail-title-row" });
		nameRow.createEl("h3", { cls: "mtg-detail-title", text: group.name });
		nameRow.setAttribute("title", "Wantlist settings");
		nameRow.addEventListener("click", openWantlistSettings);
	} else {
		titleInfo.createEl("h3", { cls: "mtg-detail-title", text: group.name });
	}
	titleInfo.createDiv({
		cls: "mtg-detail-title-stats",
		text: `${group.cards.length} unique · ${group.totalQty} cards · ${formatMoney(group.totalValue, this.plugin.settings.priceCurrency)}`,
	});

	// "+ Add cards"/"Select cards"/"..." used to live on the title row, just
	// above — moved here, to the right of the search bar, to gain vertical
	// height (explicitly requested, annotated screenshot in support, same
	// change as My Collection/My Decks).
	const searchActionsRow = stickyHeader.createDiv({ cls: "mtg-detail-search-actions-row" });
	const filterRow = searchActionsRow.createDiv({ cls: "mtg-collection-toolbar mtg-inline-filter-row" });
	const actionsRow = searchActionsRow.createDiv({ cls: "mtg-detail-search-actions" });

	const addBtn = actionsRow.createEl("button", {
		text: "+ Add cards",
		cls: "mtg-search-add-btn",
	});
	addBtn.addEventListener("click", () => {
		if (isVirtual) {
			this.openAddWantlistCardsModalWithListPicker();
			return;
		}
		this.openAddWantlistCardsModal(group.id, group.name);
	});

	const selectModeBtn = actionsRow.createDiv({
		cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
	});
	if (this.wantlistSelectMode) selectModeBtn.addClass("is-active");
	setIcon(selectModeBtn, this.wantlistSelectMode ? "x" : "square-mouse-pointer");
	selectModeBtn.setAttribute("title", this.wantlistSelectMode ? "Exit select mode" : "Select cards");
	selectModeBtn.addEventListener("click", () => {
		this.wantlistSelectMode = !this.wantlistSelectMode;
		if (!this.wantlistSelectMode) {
			this.selectedWantlistCardIds.clear();
			this.wantlistBulkBarWasVisible = false;
		}
		this.render();
	});

	if (!isVirtual) {
		const menuBtn = actionsRow.createDiv({ cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large" });
		setIcon(menuBtn, "more-vertical");
		menuBtn.setAttribute("title", "Wantlist settings");
		menuBtn.addEventListener("click", openWantlistSettings);
	}
	const filteredCards = group.cards.filter((c) =>
		cardMatchesTokens(c, this.wantlistCardFilterTokens, this.wantlistCardFilterDraft)
	);
	this.renderChipFilter(
		filterRow,
		this.wantlistCardFilterTokens,
		this.wantlistCardFilterDraft,
		"Filter by name, rarity, color, type, ability, artist, set, #number, cmc, price, qty, added, foil…",
		"wantlist-card-filter",
		(tokens) => {
			this.wantlistCardFilterTokens = tokens;
		},
		(draft) => {
			this.wantlistCardFilterDraft = draft;
		},
		group.cards
	);

	this.renderGroupSortBar("wantlist", stickyHeader);

	if (this.wantlistSelectMode) {
		this.renderWantlistBulkActionsBar(
			stickyHeader,
			group.id,
			!this.wantlistBulkBarWasVisible,
			filteredCards.map((c) => c.id)
		);
		this.wantlistBulkBarWasVisible = true;
	} else {
		this.wantlistBulkBarWasVisible = false;
	}

	const renderSignature = JSON.stringify([
		wantlistId,
		this.wantlistCardFilterTokens,
		this.wantlistCardFilterDraft,
		this.wantlistGroupBy,
		this.wantlistSortBy,
		this.wantlistSortReverse,
		this.wantlistGroupReverse,
		phoneAwareViewMode(this.wantlistViewMode),
	]);
	if (this.lastWantlistRenderSignature !== renderSignature) {
		this.wantlistRenderLimit = RENDER_BATCH_SIZE;
		this.lastWantlistRenderSignature = renderSignature;
	}

	const dataSignature = `${renderSignature}::${this.plugin.dataVersion}`;
	let cardGroups: CardGroup<WantlistCard>[];
	if (this.lastWantlistDataSignature === dataSignature && this.cachedWantlistCardGroups) {
		cardGroups = this.cachedWantlistCardGroups;
	} else {
		cardGroups = groupAndSortCards(
			filteredCards,
			this.wantlistGroupBy,
			this.wantlistSortBy,
			this.wantlistSortReverse,
			this.wantlistGroupReverse,
			this.plugin.settings.lists
		);
		this.cachedWantlistCardGroups = cardGroups;
		this.lastWantlistDataSignature = dataSignature;
	}
	// Pinned "Recently Added" group — same principle as in renderListDetail
	// (see its own, more detailed comment): recomputed on every render rather
	// than cached with cardGroups, prepended (not excluded from its normal
	// group) so that the existing pagination/navigation/rendering treat it for
	// free, also displayed on "All Wanted" (recentlyAddedWantlistCardIds is a
	// global session Set, not per wantlist), and only when the cards are
	// grouped (wantlistGroupBy !== "none").
	if (this.wantlistGroupBy !== "none") {
		const recentIds = this.plugin.recentlyAddedWantlistCardIds;
		if (recentIds.size > 0) {
			const filteredById = new Map(filteredCards.map((c) => [c.id, c]));
			const recentCards = Array.from(recentIds)
				.reverse()
				.map((id) => filteredById.get(id))
				.filter((c): c is WantlistCard => !!c);
			if (recentCards.length > 0) {
				cardGroups = [
					{ label: "Recently added", isRecentlyAdded: true, cards: recentCards },
					...cardGroups,
				];
			}
		}
	}
	const visibleGroups = sliceGroupsForRender(cardGroups, this.wantlistRenderLimit);
	const fullGroupCardsByLabel = new Map(cardGroups.map((g) => [g.label, g.cards]));
	const navOrder = cardGroups.flatMap((g) => g.cards);
	this.navOrderForWantlistClick = navOrder;

	// See the equivalent comment in renderListDetail.
	const scrollArea = this.bodyEl.createDiv({ cls: "mtg-detail-scroll-area" });
	scrollArea.addEventListener("scroll", () => this.handleScrollAreaScroll(scrollArea));
	setupPanelScrollFade(scrollArea);
	// Titre "Cards: …" — voir renderCardsCountTitle (shared-render-helpers.ts).
	renderCardsCountTitle(
		scrollArea,
		group.cards,
		filteredCards,
		this.wantlistCardFilterTokens.length > 0 || this.wantlistCardFilterDraft.length > 0
	);
	const list = scrollArea.createDiv({
		cls: `mtg-collection-list${viewModeClass(phoneAwareViewMode(this.wantlistViewMode), "wantlist")}${this.wantlistSelectMode ? " mtg-collection-list-selecting" : ""}`,
	});
	if (phoneAwareViewMode(this.wantlistViewMode) === "table" && filteredCards.length > 0) {
		this.renderTableHeader(
			list,
			this.wantlistSelectMode ? ["", ...TABLE_COLUMNS_WANTLIST] : TABLE_COLUMNS_WANTLIST
		);
	}

	if (filteredCards.length === 0) {
		// A search with no results is not an empty wantlist — see the equivalent
		// comment in renderListDetail.
		list.createEl("p", {
			text:
				group.cards.length > 0
					? "No cards match your filters."
					: isVirtual
					  ? "Your wantlists are empty."
					  : "This wantlist is empty. Use \"+ Add cards\" above.",
			cls: "mtg-status",
		});
	}

	this.lastRenderedWantlistGroupLabels = cardGroups.filter((g) => g.label).map((g) => g.label);

	visibleGroups.forEach((cardGroup) => {
		const groupRows: HTMLElement[] = [];
		const isCollapsed = cardGroup.label ? this.wantlistCollapsedGroups.has(cardGroup.label) : false;

		if (cardGroup.label) {
			const headerEl = list.createDiv({ cls: "mtg-group-header" });
			if (isCollapsed) headerEl.addClass("is-group-collapsed");
			if (this.wantlistGroupBy === "color") {
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
				fullGroupCards.every((c) => this.selectedWantlistCardIds.has(c.id));
			const selectGroupBtn = headerEl.createDiv({ cls: "mtg-group-header-select-btn" });
			if (allSelected) selectGroupBtn.addClass("is-checked");
			setIcon(selectGroupBtn, allSelected ? "square-check" : "square");
			selectGroupBtn.setAttribute(
				"title",
				allSelected ? "Deselect all cards in this group" : "Select all cards in this group"
			);
			selectGroupBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.wantlistSelectMode = true;
				if (allSelected) {
					fullGroupCards.forEach((c) => this.selectedWantlistCardIds.delete(c.id));
				} else {
					fullGroupCards.forEach((c) => this.selectedWantlistCardIds.add(c.id));
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
			} else if (cardGroup.isRecentlyAdded) {
				// See the same branch in renderListDetail — local Lucide icon, no network
				// fetch needed.
				const iconEl = centerEl.createSpan({ cls: "mtg-group-header-icon" });
				setIcon(iconEl, "clock");
				centerEl.createSpan({ cls: "mtg-group-header-label", text: cardGroup.label });
			} else {
				centerEl.createSpan({ cls: "mtg-group-header-label", text: cardGroup.label });
			}

			const rightEl = headerEl.createDiv({ cls: "mtg-group-header-right" });
			const totalQty = fullGroupCards.reduce((s, c) => s + c.count, 0);
			rightEl.createSpan({
				cls: "mtg-group-header-count",
				text: `${fullGroupCards.length} unique · ${totalQty} ${totalQty === 1 ? "card" : "cards"}`,
			});
			const chevronEl = rightEl.createDiv({ cls: "mtg-group-header-chevron" });
			setIcon(chevronEl, "chevron-down");

			headerEl.addEventListener("click", (evt) => {
				if ((evt.target as HTMLElement).closest(".mtg-group-header-select-btn")) return;
				const nowCollapsed = !this.wantlistCollapsedGroups.has(cardGroup.label);
				if (nowCollapsed) this.wantlistCollapsedGroups.add(cardGroup.label);
				else this.wantlistCollapsedGroups.delete(cardGroup.label);
				headerEl.toggleClass("is-group-collapsed", nowCollapsed);
				this.toggleGroupRows(list, headerEl, groupRows, nowCollapsed, phoneAwareViewMode(this.wantlistViewMode));
			});
		}

		cardGroup.cards.forEach((card) => {
			const rowOuter = list.createDiv({ cls: "mtg-card-row-outer" });
			groupRows.push(rowOuter);
			if (isCollapsed) {
				rowOuter.addClass("mtg-hidden");
				if (phoneAwareViewMode(this.wantlistViewMode) !== "table") rowOuter.addClass("mtg-row-collapsed");
			}

			const isSelected = this.selectedWantlistCardIds.has(card.id);
			const signature = this.wantlistCardRowSignature(card, isSelected);
			// Same "recent:" key as cachedListRowElements (see its own, more detailed
			// comment): a recently added card appears both in this pinned group and in
			// its normal group, a cache keyed only by card.id would otherwise make the
			// same DOM node shared between the two places.
			const cacheKey = cardGroup.isRecentlyAdded ? `recent:${card.id}` : card.id;
			const cached = this.cachedWantlistRowElements.get(cacheKey);
			const row =
				cached && cached.signature === signature
					? cached.el
					: phoneAwareViewMode(this.wantlistViewMode) === "card"
					  ? this.buildWantlistCardTile(card, isSelected)
					  : this.buildWantlistCardRow(card, isSelected);
			if (!cached || cached.signature !== signature) {
				this.cachedWantlistRowElements.set(cacheKey, { signature, el: row });
			}
			rowOuter.appendChild(row);
		});
	});

	const liveWantlistRowIds = new Set(
		cardGroups.flatMap((g) => g.cards.map((c) => (g.isRecentlyAdded ? `recent:${c.id}` : c.id)))
	);
	for (const id of this.cachedWantlistRowElements.keys()) {
		if (!liveWantlistRowIds.has(id)) this.cachedWantlistRowElements.delete(id);
	}

	// navOrder.length (not filteredCards.length): see the twin comment in
	// collection-render.ts — the pinned "Recently Added" group doubles each
	// recent card, so filteredCards.length undercounts the real number of rows
	// across cardGroups and cut the pagination off too early.
	if (navOrder.length > this.wantlistRenderLimit) {
		this.renderLoadMoreSentinel(list, () => {
			this.wantlistRenderLimit += RENDER_BATCH_SIZE;
			this.render();
		});
	}
}

// See collectionCardRowSignature (My Collection) for the general principle.

export function wantlistCardRowSignature(this: MTGCollectionView, card: WantlistCard, isSelected: boolean): string {
	return [
		card.imageUrl,
		card.setCode,
		card.rarity,
		card.finish,
		card.name,
		card.manaCost,
		card.setName,
		card.collectorNumber,
		card.count,
		card.priceUsd,
		card.priceUsdFoil,
		card.priceEur,
		card.priceEurFoil,
		card.priceUsdEtched,
		card.priceEurEtched,
		this.plugin.settings.priceCurrency,
		isSelected,
		this.wantlistSelectMode,
		// See collectionCardRowSignature — same purpose for wantlistViewMode.
		phoneAwareViewMode(this.wantlistViewMode),
	].join("|");
}

// See buildCollectionCardRow (My Collection) for the general principle — the
// main click references this.navOrderForWantlistClick rather than navOrder.

export function buildWantlistCardRow(this: MTGCollectionView, card: WantlistCard, isSelected: boolean): HTMLElement {
	const row = createDiv();
	row.addClass("mtg-card-row");
	if (isSelected) row.addClass("mtg-card-row-selected");

	if (this.wantlistSelectMode) {
		const indicator = row.createDiv({ cls: "mtg-card-row-select-indicator" });
		setIcon(indicator, isSelected ? "check-circle-2" : "circle");
		if (isSelected) indicator.addClass("is-selected");
	}

	this.renderThumbWithBadge(row, card.imageUrl, card.setCode, card.rarity, finishHasFoilLook(card.finish));

	const body = row.createDiv({ cls: "mtg-card-row-body" });
	const nameLine = body.createDiv({ cls: "mtg-card-row-name-line" });
	const nameSpan = nameLine.createSpan({ cls: "mtg-card-row-name", text: card.name });
	if (card.finish !== "regular") {
		nameLine.createSpan({ cls: "mtg-foil-pill", text: getFinishLabel(card.finish) });
	}
	// See buildCollectionCardRow (My Collection) for the general principle of this
	// column/this preview.
	if (phoneAwareViewMode(this.wantlistViewMode) === "table") {
		const manaValueCell = body.createDiv({ cls: "mtg-table-mana-value-cell" });
		if (card.manaCost) {
			renderManaCostIcons(manaValueCell, card.manaCost, (letter) =>
				this.plugin.getManaSymbolSvg(letter)
			);
		} else {
			manaValueCell.createSpan({ cls: "mtg-table-mana-value-empty", text: "—" });
		}
		nameSpan.addEventListener("mouseenter", () =>
			this.showCardNamePreview(nameSpan, card.imageUrl)
		);
		nameSpan.addEventListener("mouseleave", () => this.hideCardNamePreview());
	}
	const setLine = body.createDiv({ cls: "mtg-card-row-set" });
	const setNameSpan = setLine.createSpan({ cls: "mtg-card-row-set-name", text: card.setName });
	const setNumberSpan = setLine.createSpan({
		cls: "mtg-card-row-set-number",
		text: `${card.setCode.toUpperCase()} #${card.collectorNumber}`,
	});
	const openPrintingPicker = (evt: MouseEvent) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		new ChangePrintingModal(this.app, this.plugin, card, () => this.render(), "wantlist").open();
	};
	[setNameSpan, setNumberSpan].forEach((el) => {
		el.setAttribute("title", "Click to change printing");
		el.addEventListener("click", openPrintingPicker);
	});

	const acquiredBtn = row.createDiv({
		cls: "mtg-tile-menu-btn mtg-tile-menu-btn-inline mtg-wantlist-acquired-btn",
	});
	setIcon(acquiredBtn, "check");
	acquiredBtn.setAttribute("title", "Mark as acquired");
	acquiredBtn.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		if (this.plugin.settings.lists.length === 0) {
			new Notice("Create a collection list first (Collection → + New list).");
			return;
		}
		new MarkAsAcquiredModal(this.app, this.plugin, this, [card.id]).open();
	});

	const stepper = row.createDiv({ cls: "mtg-stepper" });
	stepper.addEventListener("click", (evt) => {
		if (!this.wantlistSelectMode) evt.stopPropagation();
	});
	const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
	const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(upBtn, "chevron-up");
	const valueEl = controls.createDiv({
		cls: "mtg-stepper-value mtg-stepper-value-editable",
		text: String(card.count),
	});
	valueEl.setAttribute("title", "Click to edit");
	valueEl.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		const input = controls.createEl("input", {
			cls: "mtg-stepper-value-input",
			type: "number",
			attr: { min: "1" },
		});
		input.value = String(card.count);
		valueEl.replaceWith(input);
		input.focus();
		input.select();
		const commit = () => {
			this.plugin.setWantlistCardCount(card.id, Number(input.value), () => this.render());
		};
		input.addEventListener("click", (e) => e.stopPropagation());
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") input.blur();
			if (e.key === "Escape") {
				input.removeEventListener("blur", commit);
				this.render();
			}
		});
	});
	const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(downBtn, "chevron-down");
	upBtn.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeWantlistCardCount(card.id, 1, () => this.render());
	});
	downBtn.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeWantlistCardCount(card.id, -1, () => this.render());
	});

	const priceBox = row.createDiv({ cls: "mtg-card-row-price" });
	const currency = this.plugin.settings.priceCurrency;
	const unitPrice = formatCardPrice(card, currency);
	if (unitPrice !== "—") {
		priceBox.createDiv({
			cls: "mtg-card-row-price-unit",
			text: unitPrice,
		});
		priceBox.createDiv({
			cls: "mtg-card-row-price-total",
			text: `total ${formatMoney(cardValue(card, currency), currency)}`,
		});
	}

	row.addEventListener("click", () => {
		if (this.wantlistSelectMode) {
			if (this.selectedWantlistCardIds.has(card.id)) this.selectedWantlistCardIds.delete(card.id);
			else this.selectedWantlistCardIds.add(card.id);
			this.render();
			return;
		}
		new WantlistCardDetailModal(this.app, this.plugin, this, card, this.navOrderForWantlistClick).open();
	});

	return row;
}

// Card view (My Wantlists) — see buildCollectionCardTile (My Collection) for the
// general principle. WantlistCard has no language/condition (see CLAUDE.md "Data
// model notes"), so no language/condition row here — only set/number (+ foil
// pill), quantity, "Mark as acquired" and price.

export function buildWantlistCardTile(this: MTGCollectionView, card: WantlistCard, isSelected: boolean): HTMLElement {
	const tile = createDiv();
	tile.addClass("mtg-card-row", "mtg-card-tile");
	if (isSelected) tile.addClass("mtg-card-row-selected");

	if (this.wantlistSelectMode) {
		const indicator = tile.createDiv({ cls: "mtg-card-row-select-indicator" });
		setIcon(indicator, isSelected ? "check-circle-2" : "circle");
		if (isSelected) indicator.addClass("is-selected");
	}

	const thumbWrap = this.renderThumbWithBadge(
		tile,
		card.imageUrl,
		card.setCode,
		card.rarity,
		finishHasFoilLook(card.finish),
		false,
		"tile"
	);
	// "Wanted" marker (top-left corner, white heart on an accent-color
	// background) — explicitly requested, screenshot in support: every
	// wantlist card IS by nature "wanted", unlike the existing "Wanted" ribbon
	// (mtg-thumb-wanted-ribbon) which, for its part, marks in a DECK a card
	// that is not yet owned — two different concepts, so two different badges
	// rather than a reuse. Placed directly on the wrap returned by
	// renderThumbWithBadge rather than adding a parameter to that shared
	// function (Collection/Deck/Wantlist) — this badge only makes sense on the
	// Wantlist side. Direct Lucide icon (setIcon) rather than a shared helper
	// in card-detail-fx.ts — that file deliberately stays free of any obsidian
	// dependency (see its own header).
	const wantBadge = thumbWrap.createDiv({ cls: "mtg-wantlist-heart-badge" });
	setIcon(wantBadge, "heart");

	const info = tile.createDiv({ cls: "mtg-card-tile-info" });

	// Row 1: set icon + code/number on the left; "Mark as acquired" + foil on
	// the right (no language/condition here — WantlistCard has neither, see
	// CLAUDE.md "Data model notes").
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
	setNumberSpan.setAttribute("title", "Click to change printing");
	setNumberSpan.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		new ChangePrintingModal(this.app, this.plugin, card, () => this.render(), "wantlist").open();
	});

	const row1Right = row1.createDiv({ cls: "mtg-card-tile-row1-right" });
	const acquiredBtn = row1Right.createDiv({
		cls: "mtg-tile-menu-btn mtg-tile-menu-btn-inline mtg-wantlist-acquired-btn",
	});
	setIcon(acquiredBtn, "check");
	acquiredBtn.setAttribute("title", "Mark as acquired");
	acquiredBtn.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		if (this.plugin.settings.lists.length === 0) {
			new Notice("Create a collection list first (Collection → + New list).");
			return;
		}
		new MarkAsAcquiredModal(this.app, this.plugin, this, [card.id]).open();
	});
	if (card.finish !== "regular") {
		row1Right.createSpan({ cls: "mtg-foil-pill", text: getFinishLabel(card.finish) });
	}

	// Row 2: quantity, horizontal arrows — see buildCollectionCardTile (My
	// Collection) for the general principle.
	const qtyRow = info.createDiv({ cls: "mtg-card-tile-qty-row" });
	// mtg-card-tile-stepper: enlarged +/- buttons, scoped to the Card view
	// only — the detail window keeps its own buttons at their original size
	// (mtg-stepper-horizontal alone), this modifier only applies here.
	const stepper = qtyRow.createDiv({ cls: "mtg-stepper mtg-stepper-horizontal mtg-card-tile-stepper" });
	stepper.addEventListener("click", (evt) => {
		if (!this.wantlistSelectMode) evt.stopPropagation();
	});
	const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
	const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(downBtn, "minus");
	downBtn.toggleClass("is-disabled", card.count <= 1);
	controls.createDiv({ cls: "mtg-stepper-value", text: String(card.count) });
	const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(upBtn, "plus");
	upBtn.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeWantlistCardCount(card.id, 1, () => this.render());
	});
	downBtn.addEventListener("click", (evt) => {
		if (this.wantlistSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeWantlistCardCount(card.id, -1, () => this.render());
	});

	// Row 3: price, on a single line — see buildCollectionCardTile (My
	// Collection) for why the row is always created, price known or not (keeps
	// a consistent tile height across the whole row).
	const priceLine = info.createDiv({ cls: "mtg-card-tile-price-line" });
	const currency = this.plugin.settings.priceCurrency;
	const unitPrice = formatCardPrice(card, currency);
	if (unitPrice !== "—") {
		priceLine.createSpan({ cls: "mtg-card-row-price-unit", text: unitPrice });
		priceLine.createSpan({
			cls: "mtg-card-tile-price-total-inline",
			text: ` · total ${formatMoney(cardValue(card, currency), currency)}`,
		});
	}

	tile.addEventListener("click", () => {
		if (this.wantlistSelectMode) {
			if (this.selectedWantlistCardIds.has(card.id)) this.selectedWantlistCardIds.delete(card.id);
			else this.selectedWantlistCardIds.add(card.id);
			this.render();
			return;
		}
		new WantlistCardDetailModal(this.app, this.plugin, this, card, this.navOrderForWantlistClick).open();
	});

	return tile;
}

