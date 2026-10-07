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
		// Voir openCollectionCardDetailById/openWantlistCardDetailById pour le
		// raisonnement complet (même idée, côté wantlist).
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

// Voir openCollectionCardDetailById (collection-render.ts) — même raisonnement, côté wantlist ;
// publique depuis le 2026-09-08 pour la même raison ("Copies in Lists"
// cross-section).

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
	// Clear inclus ici (comme My Collection), Select all délibérément exclu
	// — voir le commentaire équivalent dans renderDeckBulkActionsBar.
	const actionButtons: HTMLButtonElement[] = [clearBtn];

	// Ouvre une modale (pas un menu déroulant) : pas de caret, même
	// traitement que "Move to"/"Copy to" dans My Collection.
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
		// Même fix mousedown/preventDefault que My Collection : sans lui, le
		// blur (donc commit) se déclenche avant le click de Cancel.
		cancelQtyBtn.addEventListener("mousedown", (e) => e.preventDefault());
		cancelQtyBtn.addEventListener("click", () => {
			input.removeEventListener("blur", commit);
			this.render();
		});
	});

	// Exporter en fichier (CSV/TXT au choix) — même bouton "Export" que My
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

	// Séparateur avant Delete — même traitement que My Collection.
	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	// Supprimer — confirmation à deux étapes, même idiome que My Collection
	// au lieu de l'ancien texte "Confirm delete?" sans possibilité d'annuler.
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


// Même principe que listSelectionTxtLines (collection-render.ts), côté
// wantlist — partagé entre exportWantlistSelectionTxt et
// copyWantlistSelectionTxt.

export function wantlistSelectionTxtLines(this: MTGCollectionView): string {
	const cards = this.plugin.settings.wantlist.filter((c) => this.selectedWantlistCardIds.has(c.id));
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportWantlistSelectionTxt(this: MTGCollectionView) {
	this.downloadTextFile(this.wantlistSelectionTxtLines(), "mtg-wantlist-selection.txt");
}

// Pendant wantlist du "Copy TXT" de My Collection — voir copyListSelectionTxt
// (collection-render.ts) pour le raisonnement sur .catch().

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

// Même format "qty - name" que listTxtLines (collection-render.ts), mais pour LA
// wantlist entière (WantlistSettingsModal, "Export"/"Copy to clipboard")
// plutôt que la sélection en cours — voir wantlistSelectionTxtLines
// ci-dessus, un sous-ensemble différent de settings.wantlist.

export function wantlistTxtLines(this: MTGCollectionView, wantlistId: string): string {
	const cards = this.plugin.settings.wantlist.filter((c) => c.listId === wantlistId);
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportWantlistTxt(this: MTGCollectionView, wantlistId: string) {
	const wantlist = this.plugin.settings.wantlists.find((w) => w.id === wantlistId);
	const filename = `mtg-wantlist-${(wantlist?.name ?? "wantlist").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
	this.downloadTextFile(this.wantlistTxtLines(wantlistId), filename);
}

// navigator.clipboard.writeText : même précédent déjà établi (voir
// copyListTxt, collection-render.ts) — .catch() explicite plutôt qu'une résolution
// supposée systématique.

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

// Même principe, côté deck.

export function triggerImportIntoWantlist(this: MTGCollectionView, wantlistId: string) {
	this.triggerImportWantlist(wantlistId);
}

// "Import TXT" de WantlistSettingsModal — même chose que triggerImportTxtIntoList (collection-render.ts),
// côté wantlist (plugin.importDecklistToWantlist).

export function triggerImportTxtIntoWantlist(this: MTGCollectionView, wantlistId: string) {
	const wantlist = this.plugin.settings.wantlists.find((w) => w.id === wantlistId);
	importDecklistFile(this, {
		noun: "wantlist",
		entityName: () => wantlist?.name,
		run: (text, onStatus) => this.plugin.importDecklistToWantlist(wantlistId, text, onStatus),
	});
}

// Crée la vignette d'une carte avec le symbole d'édition en badge, en bas à
// droite, coloré selon la rareté (comme sur les vraies cartes / Delver).
// Replie/déplie UNE ligne à la fois via une classe CSS pure (technique
// "grid-template-rows: 0fr / 1fr" sur l'enveloppe .mtg-card-row-outer) —
// pas de mesure ni d'animation pilotée en JS, donc pas d'état à
// désynchroniser sur des clics rapides (c'était la cause des groupes qui
// refusaient de se rouvrir). Bien plus fluide que l'ancienne approche par
// max-height, qui forçait un recalcul de mise en page à chaque image.
// Mode Tableau excepté : la ligne y est aplatie (display:contents) et n'a
// donc aucune boîte propre — ni hauteur ni opacité à animer sur l'enveloppe
// elle-même. On applique un léger fondu directement sur chaque CELLULE
// (nom, édition, prix, etc., qui ont chacune leur propre boîte) avant de
// masquer la ligne — pas un vrai repliement fluide, juste une disparition
// un peu plus douce qu'un basculement instantané.


export function openWantlist(this: MTGCollectionView, wantlistId: string) {
	this.activeSection = "wantlists";
	this.openWantlistId = wantlistId;
	// Voir le commentaire équivalent dans openList().
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

	// Petit titre « Wantlists: … » avec le nombre de wantlists, « x of y
	// wantlists match » pendant une recherche — même titre (et même classe) que
	// « Lists » dans renderListGrid, demandé explicitement pour les 3 galeries.
	// "All Wanted" (tuile virtuelle) n'est comptée ni dans l'un ni dans l'autre
	// nombre : ce n'est pas une wantlist de l'utilisateur.
	this.bodyEl.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle(
			"wantlist",
			groups.length,
			this.plugin.settings.wantlists.length,
			filter !== ""
		),
	});

	// Nombre de colonnes automatique (1/2/4 selon la largeur du panneau) —
	// voir renderListGrid et .mtg-set-grid-wrap dans styles.css.
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
	// "All Wanted" traité exactement comme "All Cards" côté My Collection
	// (demandé explicitement, capture à l'appui) : pas d'image/dégradé de
	// fond, gris foncé fixe à la place (.mtg-set-tile-all-wanted, calquée
	// sur .mtg-set-tile-all-cards) — voir renderListTile pour le
	// raisonnement complet, transposé tel quel ici.
	if (group.coverImage && !isVirtual) {
		const bg = tile.createDiv({ cls: "mtg-set-tile-bg" });
		bg.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.85)), url("${group.coverImage}")`;
	}
	const content = tile.createDiv({ cls: "mtg-set-tile-content" });

	// Agrégat virtuel "All Wanted" : pictogramme (le même cœur que "My
	// Wantlists" dans le menu de gauche) + texte, ancrés en BAS de la
	// tuile — pas le layout centré verticalement d'Inbox/"All Cards"
	// (mtg-set-tile-content-pinned) mais la même rangée imbriquée
	// (mtg-set-tile-icon-row) qu'une liste normale avec un pictogramme
	// choisi manuellement juste en dessous : demandé explicitement
	// ("place juste les éléments en bas, comme nous le faisons pour les
	// listes") après un premier essai centré verticalement — "All
	// Wanted" partage la grille des wantlists normales (min-height
	// 200px, .mtg-set-tile) plutôt que la grille dédiée à hauteur
	// réduite d'Inbox/"All Cards" (.mtg-pinned-tiles-grid, 100px), où le
	// centrage se voyait à peine ; ici il laissait un vide visible
	// au-dessus du texte. content garde donc son flex-direction/
	// justify-content par défaut (colonne, ancrée en bas) au lieu du
	// modificateur -pinned, exactement comme pour l'icône manuelle
	// ci-dessous.
	let textParent: HTMLElement = content;
	if (isVirtual) {
		const iconRow = content.createDiv({ cls: "mtg-set-tile-icon-row" });
		const iconCircle = iconRow.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
		setIcon(iconCircle, "heart");
		textParent = iconRow.createDiv({ cls: "mtg-set-tile-pinned-text" });
	}

	// Pictogramme choisi manuellement (WantlistSettingsModal, "Choose
	// icon") — même bloc/même raisonnement que renderListTile
	// (collection-render.ts, voir son propre commentaire), transposé tel quel côté wantlist :
	// jamais pour l'agrégat virtuel "All Wanted" (pas de Wantlist
	// réelle derrière, donc pas d'icône à lui poser).
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

// Barre d'actions groupées de la grille "My Wantlists" — même structure
// que renderListGalleryBulkActionsBar.

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

	// Fusionne les wantlists sélectionnées en une nouvelle — même
	// raisonnement que le bouton "Merge" de My Collection (voir
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

	// Voir renderListDetail pour le raisonnement complet — group.coverImage
	// déjà calculé ci-dessus (pickCoverImage/groupByWantlist, core/price.ts).
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
	// Ouvre les settings (WantlistSettingsModal) au clic sur le titre, au
	// lieu du renommage en ligne d'origine — demandé explicitement, le
	// renommage reste accessible depuis cette même fenêtre.
	// openWantlistSettings est réutilisé plus bas par menuBtn (le bouton
	// "...") pour ne pas dupliquer la construction de la modale. isVirtual
	// ("All Wanted") n'a pas de settings du tout (pas de menuBtn non plus,
	// voir plus bas) : titre non cliquable, comme avant.
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

	// "+ Add cards"/"Select cards"/"..." vivaient auparavant sur la
	// rangée du titre, juste au-dessus — déplacés ici, à droite de la
	// barre de recherche, pour gagner de la hauteur verticale (demandé
	// explicitement, capture d'écran annotée à l'appui, même changement
	// que My Collection/My Decks).
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
	// Groupe épinglé "Recently Added" — même principe que dans
	// renderListDetail (voir son propre commentaire, plus détaillé) :
	// recalculé à chaque rendu plutôt que mis en cache avec cardGroups,
	// prépendu (pas exclu de son groupe normal) pour que pagination/
	// navigation/rendu existants le traitent gratuitement, affiché aussi
	// sur "All Wanted" (recentlyAddedWantlistCardIds est un Set global de
	// session, pas par wantlist), et uniquement quand les cartes sont
	// groupées (wantlistGroupBy !== "none").
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

	// Voir le commentaire équivalent dans renderListDetail.
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
		// Une recherche sans résultat n'est pas une wantlist vide — voir le
		// commentaire équivalent dans renderListDetail.
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
				// Voir la même branche dans renderListDetail — icône Lucide
				// locale, pas de fetch réseau nécessaire.
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
			// Même clé "recent:" que cachedListRowElements (voir son propre
			// commentaire, plus détaillé) : une carte récemment ajoutée
			// apparaît à la fois dans ce groupe épinglé et dans son groupe
			// normal, un cache keyé uniquement par card.id ferait sinon
			// partager le même nœud DOM aux deux endroits.
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

	// navOrder.length (pas filteredCards.length) : voir le commentaire
	// jumeau dans collection-render.ts — le groupe épinglé "Recently
	// Added" double chaque carte récente, donc filteredCards.length sous-
	// compte le nombre réel de lignes à travers cardGroups et coupait la
	// pagination trop tôt.
	if (navOrder.length > this.wantlistRenderLimit) {
		this.renderLoadMoreSentinel(list, () => {
			this.wantlistRenderLimit += RENDER_BATCH_SIZE;
			this.render();
		});
	}
}

// Voir collectionCardRowSignature (My Collection) pour le principe général.

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
		// Voir collectionCardRowSignature — même raison d'être pour wantlistViewMode.
		phoneAwareViewMode(this.wantlistViewMode),
	].join("|");
}

// Voir buildCollectionCardRow (My Collection) pour le principe général — le clic
// principal référence this.navOrderForWantlistClick plutôt que navOrder.

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
	// Voir buildCollectionCardRow (My Collection) pour le principe général de cette
	// colonne/de cet aperçu.
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

// Vue Carte (My Wantlists) — voir buildCollectionCardTile (My Collection) pour le
// principe général. WantlistCard n'a pas de langue/condition (voir
// CLAUDE.md "Data model notes"), donc pas de ligne langue/condition ici —
// seulement édition/numéro (+ pastille foil), quantité, "Mark as acquired"
// et prix.

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
	// Repère "souhaité" (coin haut-gauche, cœur blanc sur fond couleur
	// d'accent) — demandé explicitement, capture à l'appui : toute carte de
	// wantlist EST par nature "voulue", contrairement au ruban "Wanted"
	// existant (mtg-thumb-wanted-ribbon) qui, lui, marque dans un DECK une
	// carte encore non possédée — deux concepts différents, donc deux
	// badges différents plutôt qu'une réutilisation. Posé directement sur
	// le wrap retourné par renderThumbWithBadge plutôt que d'ajouter un
	// paramètre à cette fonction partagée (Collection/Deck/Wantlist) — ce
	// badge n'a de sens que côté Wantlist. Icône Lucide directe (setIcon)
	// plutôt qu'un helper partagé dans card-detail-fx.ts — ce fichier reste
	// volontairement sans dépendance obsidian (voir son propre en-tête).
	const wantBadge = thumbWrap.createDiv({ cls: "mtg-wantlist-heart-badge" });
	setIcon(wantBadge, "heart");

	const info = tile.createDiv({ cls: "mtg-card-tile-info" });

	// Ligne 1 : icône d'édition + code/numéro à gauche ; "Mark as acquired"
	// + foil à droite (pas de langue/état ici — WantlistCard n'a
	// aucun des deux, voir CLAUDE.md "Data model notes").
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

	// Ligne 2 : quantité, flèches horizontales — voir buildCollectionCardTile (My
	// Collection) pour le principe général.
	const qtyRow = info.createDiv({ cls: "mtg-card-tile-qty-row" });
	// mtg-card-tile-stepper : boutons +/- agrandis, scopés à la vue Carte
	// uniquement — la fenêtre de détail garde ses propres boutons à leur
	// taille d'origine (mtg-stepper-horizontal seul), ce modificateur ne
	// s'applique qu'ici.
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

	// Ligne 3 : prix, sur une seule ligne — voir buildCollectionCardTile (My
	// Collection) pour pourquoi la ligne est toujours créée, prix connu ou
	// non (garde une hauteur de tuile cohérente dans toute la rangée).
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

