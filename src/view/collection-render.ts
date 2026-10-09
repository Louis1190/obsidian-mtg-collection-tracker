import { Notice, setIcon } from "obsidian";
import {
	FINISH_OPTIONS,
	getFinishLabel,
	finishHasFoilLook,
	CollectionCard,
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
	TABLE_COLUMNS_COLLECTION,
	LIST_GRID_SORT_OPTIONS,
	GROUP_LABEL_HEX,
	CardGroup,
	RENDER_BATCH_SIZE,
	sliceGroupsForRender,
	groupAndSortCards,
} from "../core/card-sorting";
import {
	cardMatchesTokens,
	tokensNeedLegalityData,
} from "../core/card-search";
import {
	ListGroup,
	formatCardPrice,
	getCardPriceNumber,
	cardValue,
	formatMoney,
	pickCoverImage,
	groupByList,
} from "../core/price";
import {
	ALL_CARDS_ID,
} from "../core/data-model";
import { formatCountTitle } from "../core/count-title";
import { ZipEntry } from "../core/zip";
import {
	renderManaCostIcons,
	setupPanelScrollFade,
} from "../ui/card-detail-fx";
import { renderCardsCountTitle } from "./shared-render-helpers";
import { createBulkActionsBar, replaceInBulkBar } from "./bulk-actions-bar";
import {
	ListSettingsModal,
} from "../modals/list-settings-modal";
import { InboxSettingsModal } from "../modals/inbox-settings-modal";
import { AddCardsModal } from "../modals/add-cards-modal";
import { ChangePrintingModal } from "../modals/change-printing-modal";
import { importCsvFile, importDecklistFile } from "./file-import";
import { MergeListsModal } from "../modals/merge-modals";
import { CardDetailModal } from "../modals/card-detail-modal";
import { CopyCardModal } from "../modals/copy-card-modal";
import type { MTGCollectionView } from "../view";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  My Collection: section/grid/detail rendering, row + tile building,
    bulk-actions bar, CSV/TXT export/import, list open/close. Split out of
    view.ts on 2026-09-10 ("Phase 5b").  */
/* -------------------------------------------------------------------------- */

export function triggerImportCollection(this: MTGCollectionView, targetListId?: string) {
	importCsvFile(this, {
		accept: ".csv,text/csv",
		skippedLabel: "not found",
		run: (text, onStatus) => this.plugin.importCsv(text, onStatus, targetListId),
	});
}


export function openAddCollectionCardsModal(this: MTGCollectionView, listId: string, listName: string) {
	const modal = new AddCardsModal(this.app, this.plugin, {
		onAdd: (card, options) => this.plugin.addCardToCollection(card, listId, options),
		onChangeQuantity: (entryId, delta, onDone) => this.plugin.changeCollectionCardCount(entryId, delta, onDone),
		// Once added (stepper displayed), the tile becomes clickable and opens its
		// detail window — explicitly requested. navCards is only the card itself
		// (not the full list): this context has no equivalent "displayed search
		// results list" to navigate in Cover Flow, so no previous/next arrows here
		// (canNavigate requires navCards.length > 1).
		onOpenDetail: (entryId, onDetailClosed) => this.openCollectionCardDetailById(entryId, onDetailClosed),
		// "Add history" panel — undoes/replays an addition by its deduplication
		// key (scryfallId+listId+options), not by a row id which could become
		// invalid between a disable and a re-enable — see onUndoAdd,
		// shared-search-ui.ts.
		onUndoAdd: (card, options, undoListId, delta) =>
			this.plugin.undoAddToCollection(card.id, undoListId, options, delta),
		destinationName: listName,
		// Drives the "Change printing"/"Move card" links of the "Add history"
		// panel — see sourceKind, shared-search-ui.ts.
		sourceKind: "collection",
		titleText: `Add cards to "${listName}"`,
	});
	modal.onClose = () => {
		modal.contentEl.empty();
		this.render();
	};
	modal.open();
}

// Shared by the 2 Collection add flows (with/without a list picker) — see
// onOpenDetail above/below. Looks up the entry by id rather than passing
// the CollectionCard object itself back up from AddCardsModal (which only
// knows { id, count }, see AddCardsModalOptions.onAdd) — one more lookup,
// but keeps AddCardsModal generic, without a dependency on the Collection
// data model. `onDetailClosed` (optional — bug fixed: without it, the
// original carousel tile stayed displayed with its stale value after a
// quantity change/a deletion from this detail window) is wrapped around
// the EXISTING onClose of CardDetailModal rather than overwriting it —
// captured/bound BEFORE being replaced, then explicitly called first, so
// as not to lose any cleanup that CardDetailModal already does on its side
// (today just contentEl.empty(), but not guaranteed to stay so). Re-reads
// the row AFTER this cleanup rather than reusing `card` (captured before
// opening, hence stale if the quantity changed or if the row was deleted
// in the meantime) — undefined if it no longer exists.
// Public (not just called from AddCardsModalOptions.onOpenDetail above)
// since 2026-09-08: the cross-section "Copies in Lists" block
// (CardDetailModal/DeckCardDetailModal/WantlistCardDetailModal) also calls
// it directly to open the right window on a My Collection tile clicked
// from another modal — without an onDetailClosed callback in this case
// (the original window closes, nothing to resynchronize once the target is
// closed).

export function openCollectionCardDetailById(this: MTGCollectionView, 
	entryId: string,
	onDetailClosed?: (row: { id: string; count: number } | undefined) => void
) {
	const card = this.plugin.settings.collection.find((c) => c.id === entryId);
	if (!card) return;
	const modal = new CardDetailModal(this.app, this.plugin, this, card, [card]);
	if (onDetailClosed) {
		const originalOnClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			originalOnClose();
			const freshRow = this.plugin.settings.collection.find((c) => c.id === entryId);
			onDetailClosed(freshRow ? { id: freshRow.id, count: freshRow.count } : undefined);
		};
	}
	modal.open();
}

// From "All Cards", there is no implicit target list: the modal itself
// displays a gallery of lists (background image + name) to choose from
// before/during the search, rather than a separate text menu.

export function openAddCollectionCardsModalWithListPicker(this: MTGCollectionView) {
	const lists = this.plugin.settings.lists;
	if (lists.length === 0) {
		new Notice("Create a list first (Collection → + New list).");
		return;
	}
	const summaries = groupByList(
		lists,
		this.plugin.settings.collection,
		this.plugin.settings.priceCurrency
	);
	const modal = new AddCardsModal(this.app, this.plugin, {
		onAdd: (card, options, listId) => {
			if (!listId) return;
			return this.plugin.addCardToCollection(card, listId, options);
		},
		onChangeQuantity: (entryId, delta, onDone) => this.plugin.changeCollectionCardCount(entryId, delta, onDone),
		onOpenDetail: (entryId, onDetailClosed) => this.openCollectionCardDetailById(entryId, onDetailClosed),
		// No destinationName here — see onUndoAdd, shared-search-ui.ts: the
		// listGallery flow instead resolves the name by listId from
		// listGallery.summaries, the destination varying tile by tile.
		onUndoAdd: (card, options, undoListId, delta) =>
			this.plugin.undoAddToCollection(card.id, undoListId, options, delta),
		sourceKind: "collection",
		titleText: "Add cards",
		// defaultListId (Inbox): "Add"/"Add all" add directly to Inbox without
		// opening SelectListModal — explicitly requested ("without explicitly
		// choosing a list, it lands in Inbox"), see
		// AddCardsModalOptions.listGallery.defaultListId. To choose ANOTHER
		// destination anyway: the "Add history" panel of this same modal already
		// knows how to move a card just added to another list ("Move" link on the
		// destination) — no need for a 2nd picker at add time, which would
		// reintroduce exactly the forced choice that this removes.
		listGallery: { summaries, kind: "list", defaultListId: this.plugin.settings.lists.find((l) => l.isInbox)?.id },
	});
	modal.onClose = () => {
		modal.contentEl.empty();
		this.render();
	};
	modal.open();
}


export function renderCollectionSection(this: MTGCollectionView) {
	const collection = this.plugin.settings.collection;
	const currency = this.plugin.settings.priceCurrency;
	const totalCards = collection.reduce((sum, c) => sum + c.count, 0);
	const totalValue = collection.reduce((sum, c) => sum + cardValue(c, currency), 0);

	if (this.openListId) {
		this.headerTitleEl.setText("");
		this.headerStatsEl.setText("");
	} else {
		this.headerTitleEl.setText("Collection");
		// Inbox (system list, pinned apart from the grid) is not counted as a list
		// — explicitly requested, to stay consistent with the "Lists: N lists"
		// title of the grid, which doesn't count it either. Its cards, for their
		// part, remain in totalCards/totalValue.
		const realListCount = this.plugin.settings.lists.filter((l) => !l.isInbox).length;
		this.headerStatsEl.setText(
			`${realListCount} lists · ${totalCards} cards · ${formatMoney(totalValue, currency)}`
		);
	}

	// No more "0 lists" guard here: Inbox (see
	// CollectionList.isInbox/ensureInboxList) is now guaranteed to be present
	// from the loading of the settings, so this.plugin.settings.lists.length
	// === 0 can no longer ever happen once the plugin is loaded.
	if (this.openListId) {
		this.renderListDetail(this.openListId);
	} else {
		this.renderListGrid();
	}
}


export function renderListGrid(this: MTGCollectionView) {
	const filter = this.filterEl.value.trim().toLowerCase();
	// Inbox (system list, see CollectionList.isInbox/ensureInboxList) is
	// removed from the array sorted/filtered by the user then reinjected
	// separately, in the pinned row with "All Cards" (further down), so that
	// it always stays at the top whatever sort/search is chosen.
	const inboxList = this.plugin.settings.lists.find((l) => l.isInbox);
	const allGroups = groupByList(
		this.plugin.settings.lists,
		this.plugin.settings.collection,
		this.plugin.settings.priceCurrency
	);
	const inboxGroup = inboxList ? allGroups.find((g) => g.id === inboxList.id) : undefined;
	// The real lists, Inbox excluded: this is exactly what the grid displays
	// under the "Lists: …" title (see further down), hence its "total".
	const realGroups = allGroups.filter((g) => g.id !== inboxList?.id);
	let groups = realGroups.filter((g) => !filter || g.name.toLowerCase().includes(filter));

	const sortBy = this.plugin.settings.listGridSortBy;
	const sortReverse = this.plugin.settings.listGridSortReverse;
	const listsById = new Map(this.plugin.settings.lists.map((l) => [l.id, l]));
	groups = [...groups].sort((a, b) => {
		let cmp = 0;
		switch (sortBy) {
			case "name":
				cmp = a.name.localeCompare(b.name);
				break;
			case "dateCreated":
				cmp = (listsById.get(a.id)?.dateCreated ?? 0) - (listsById.get(b.id)?.dateCreated ?? 0);
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

	// Pinned "Inbox"/"All Cards" row — at most 2 columns between the two, never
	// 4 like the grid of real lists further down (explicitly requested), but
	// just one (the two tiles one under the other) as long as the panel is
	// narrow, i.e. a phone in portrait: side by side they were only ~135px each
	// there (~90px at a 300px panel), their text squashed over several lines
	// (also explicitly requested). A separate .mtg-set-grid rather than these 2
	// tiles at the head of the main grid: in the latter their width would have
	// followed the current number of columns (up to 4) instead of capping at 2.
	// In its OWN .mtg-set-grid-wrap — same query container, so same thresholds
	// as the main grid: it goes from 1 to 2 columns at the same panel width, by
	// construction, and .mtg-pinned-tiles-grid neutralizes the 4-column step
	// (see styles.css). Inbox before "All Cards" — explicitly requested ("Put
	// 'Inbox' in first position").
	//
	// Built in this.collectionPinnedEl (persistent element of the skeleton, see
	// onOpen) and not in this.bodyEl: the row is ABOVE the filter bar, which is
	// itself persistent and therefore outside this.bodyEl — explicitly
	// requested (search and sort come after these two tiles). Intended
	// consequence: the search no longer filters them (before, "inbox"/"all
	// cards" hid them when the input didn't match them). Under the row, a tile
	// that disappeared as you type would make the search bar itself jump upward
	// while you write in it; the sort, for its part, never concerned them.
	const hasAllCardsTile = this.plugin.settings.lists.length > 0;
	if (inboxGroup || hasAllCardsTile) {
		const pinnedWrap = this.collectionPinnedEl.createDiv({ cls: "mtg-set-grid-wrap" });
		const pinnedGrid = pinnedWrap.createDiv({
			cls: `mtg-set-grid mtg-pinned-tiles-grid${
				this.listGallerySelectMode ? " mtg-gallery-selecting" : ""
			}`,
		});
		if (inboxGroup) {
			this.renderListTile(pinnedGrid, inboxGroup, true);
		}
		if (hasAllCardsTile) {
			const allCards = this.plugin.settings.collection;
			this.renderListTile(pinnedGrid, {
				id: ALL_CARDS_ID,
				name: "All cards",
				cards: allCards,
				totalQty: allCards.reduce((s, c) => s + c.count, 0),
				totalValue: allCards.reduce((s, c) => s + cardValue(c, this.plugin.settings.priceCurrency), 0),
				coverImage: pickCoverImage(allCards),
			});
		}
	}

	// The search only applies to the real lists (the pinned row above stays
	// displayed no matter what): with no input, a gallery that only has its
	// two pinned tiles displays normally, with its empty grid below.
	if (filter && groups.length === 0) {
		this.bodyEl.createEl("p", {
			text: "No list matches your filter.",
			cls: "mtg-status",
		});
		return;
	}

	// "Sort by" bar (as inside a list).
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
					this.plugin.settings.listGridSortBy = opt.value;
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
		this.plugin.settings.listGridSortReverse = !this.plugin.settings.listGridSortReverse;
		void this.plugin.saveSettings();
		this.render();
	});

	if (this.listGallerySelectMode) {
		this.renderListGalleryBulkActionsBar(
			this.bodyEl,
			!this.listGalleryBulkBarWasVisible,
			groups.map((g) => g.id)
		);
		this.listGalleryBulkBarWasVisible = true;
	} else {
		this.listGalleryBulkBarWasVisible = false;
	}

	// Small "Lists" title above the grid of real lists just below — explicitly
	// requested, originally to separate it from the pinned row that
	// immediately preceded it; now under the sort bar, the pinned row having
	// moved above the search bar (see above). Also carries the number of
	// lists, which becomes "x of y lists match" during a search (explicitly
	// requested).
	this.bodyEl.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle("list", groups.length, realGroups.length, filter !== ""),
	});

	// Automatic number of columns (1/2/4 depending on the panel's width, no
	// more user choice): .mtg-set-grid-wrap is the query container that
	// .mtg-set-grid depends on — see its comment in styles.css.
	const gridWrap = this.bodyEl.createDiv({ cls: "mtg-set-grid-wrap" });
	const grid = gridWrap.createDiv({
		cls: `mtg-set-grid${this.listGallerySelectMode ? " mtg-gallery-selecting" : ""}`,
	});

	groups.forEach((group) => this.renderListTile(grid, group));
}

// isInbox: tile of the "Inbox" system list (see
// CollectionList.isInbox/ensureInboxList) — rendered in full accent color,
// without a background image/gradient, with a small "inbox" pictogram
// (explicitly requested), and never selectable in gallery selection mode
// (same treatment as isVirtual/"All Cards" below: nothing to delete/merge
// corresponds to it, see also the safeguards on the
// MTGCollectionPlugin.deleteList/renameList/bulkDeleteLists/mergeLists
// side). Unlike "All Cards", the "..." menu stays displayed — but opens
// InboxSettingsModal (Move + Export/Import CSV) rather than
// ListActionsModal, which would wrongly expose a rename/a deletion — see
// the isInbox routing further down.

export function renderListTile(this: MTGCollectionView, grid: HTMLElement, group: ListGroup, isInbox = false) {
	const isVirtual = group.id === ALL_CARDS_ID;
	const nonSelectable = isVirtual || isInbox;
	const tile = grid.createDiv({
		cls: `mtg-set-tile${isInbox ? " mtg-set-tile-inbox" : ""}${isVirtual ? " mtg-set-tile-all-cards" : ""}`,
	});
	// "All Cards" no longer has a background image either (explicitly
	// requested, "Remove the background image of 'All cards'") — fixed dark
	// gray instead, see .mtg-set-tile-all-cards, styles.css.
	if (group.coverImage && !isInbox && !isVirtual) {
		const bg = tile.createDiv({ cls: "mtg-set-tile-bg" });
		bg.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.85)), url("${group.coverImage}")`;
	}
	const content = tile.createDiv({ cls: "mtg-set-tile-content" });

	// Pinned row (Inbox/"All Cards"): horizontal layout — a pictogram in a
	// circle on the left (darker/slightly opaque background, size designed for
	// the 3 lines of text), the text on the right — instead of the vertical
	// layout/anchored at the bottom of normal list tiles. Explicitly requested
	// with a sketch; a modifier class on .mtg-set-tile-content
	// (mtg-set-tile-content-pinned) rather than changing .mtg-set-tile-content
	// itself, which otherwise remains the default layout of any other tile.
	let textParent = content;
	if (isInbox || isVirtual) {
		content.addClass("mtg-set-tile-content-pinned");
		const iconCircle = content.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
		setIcon(iconCircle, isInbox ? "inbox" : "gallery-horizontal-end");
		textParent = content.createDiv({ cls: "mtg-set-tile-pinned-text" });
	}

	// Pictogram chosen manually (ListSettingsModal, "Choose icon") for a
	// normal list — same slightly translucent circle as above
	// (.mtg-set-tile-pictogram-circle, reused as is), but placed in a simple
	// nested row (mtg-set-tile-icon-row) rather than on .mtg-set-tile-content
	// itself as for Inbox/"All Cards": those two have no background image, so
	// vertically centering all the content in the tile costs nothing; a normal
	// list, on the other hand, has its background gradient specifically
	// darkened toward the BOTTOM for the legibility of the text anchored there
	// (see above) — applying the same vertical centering to it would have
	// moved the text away from the darkest area of the gradient. The nested
	// row therefore keeps .mtg-set-tile-content anchored at the bottom as
	// before, with just this new block (circle + text) as its only child.
	if (group.icon && !isInbox && !isVirtual) {
		const iconRow = textParent.createDiv({ cls: "mtg-set-tile-icon-row" });
		const iconCircle = iconRow.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
		// Mana (already colored by Scryfall, never altered) vs set (monochrome,
		// recolored white to stay legible in this dark circle — same treatment as
		// the group header icons elsewhere in this file, applySvgColor(...,
		// "#ffffff")).
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

	// Gallery selection mode: "All Cards" (virtual aggregate) and "Inbox"
	// (system list) are never selectable — see nonSelectable above.
	const isSelected = !nonSelectable && this.selectedListIds.has(group.id);
	if (this.listGallerySelectMode && !nonSelectable) {
		tile.toggleClass("mtg-set-tile-selected", isSelected);
		const indicator = tile.createDiv({ cls: "mtg-set-tile-select-indicator" });
		setIcon(indicator, isSelected ? "check-circle-2" : "circle");
		if (isSelected) indicator.addClass("is-selected");
	}

	tile.addEventListener("click", () => {
		if (this.listGallerySelectMode) {
			if (nonSelectable) return;
			if (this.selectedListIds.has(group.id)) this.selectedListIds.delete(group.id);
			else this.selectedListIds.add(group.id);
			this.render();
			return;
		}
		this.openListId = group.id;
		this.lastFocusedFilterKey = null;
		this.listCardFilterTokens = [];
		this.listCardFilterDraft = "";
		this.selectedListCardIds.clear();
		this.listSelectMode = false;
		this.listBulkBarWasVisible = false;
		this.render();
	});

	// "..." menu hidden in gallery selection mode: opening a list's settings
	// in the middle of a multiple selection would be confusing (same reasoning
	// as hiding the "+ Add cards" button on the card side in select mode).
	if (!isVirtual && !this.listGallerySelectMode) {
		const menuBtn = tile.createDiv({ cls: "mtg-tile-menu-btn" });
		setIcon(menuBtn, "more-vertical");
		menuBtn.setAttribute("title", isInbox ? "Inbox settings" : "List settings");
		menuBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (isInbox) new InboxSettingsModal(this.app, this.plugin, this, group.id).open();
			else new ListSettingsModal(this.app, this.plugin, this, group.id).open();
		});
	}
}

// Bulk actions bar of the "My Collection" grid (selection of whole lists, not
// cards) — same look/structure as renderCollectionBulkActionsBar (cards),
// deliberately shorter: only the 3 requested actions make sense here (nothing to
// move/copy/regroup between lists themselves). visibleListIds serves "Select all",
// like visibleCardIds for renderCollectionBulkActionsBar.

export function renderListGalleryBulkActionsBar(this: MTGCollectionView, container: HTMLElement, animate: boolean, visibleListIds: string[]) {
	const bar = createBulkActionsBar(this, "list-gallery", container, animate);

	bar.createSpan({
		cls: "mtg-bulk-actions-count",
		text: `${this.selectedListIds.size} selected`,
	});

	const selectionUtils = bar.createDiv({ cls: "mtg-bulk-selection-utils" });
	const selectAllBtn = selectionUtils.createEl("button", {
		text: "Select all",
		cls: "mtg-bulk-action-btn",
	});
	selectAllBtn.addEventListener("click", () => {
		visibleListIds.forEach((id) => this.selectedListIds.add(id));
		this.render();
	});
	const clearBtn = selectionUtils.createEl("button", { text: "Clear", cls: "mtg-bulk-action-btn" });
	clearBtn.addEventListener("click", () => {
		this.selectedListIds.clear();
		this.render();
	});

	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	const actionButtons: HTMLButtonElement[] = [clearBtn];

	const selectedGroups = () =>
		groupByList(
			this.plugin.settings.lists,
			this.plugin.settings.collection,
			this.plugin.settings.priceCurrency
		).filter((g) => this.selectedListIds.has(g.id));

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
						this.downloadListCsv(cards, "mtg-lists-selection.csv");
					},
				},
				{
					render: (el) => el.createSpan({ text: "One file per list (.zip)" }),
					onSelect: () => {
						const entries: ZipEntry[] = selectedGroups().map((g) => ({
							name: `${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`,
							content: this.buildListCsvString(g.cards),
						}));
						this.downloadZip(entries, "mtg-lists-selection.zip");
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
						const count = this.selectedListIds.size;
						navigator.clipboard
							.writeText(this.listGroupsToTxtLines(selectedGroups()))
							.then(() => new Notice(`Copied ${count} list(s) to clipboard.`))
							.catch(() => new Notice("Could not copy to clipboard."));
					},
				},
				{
					render: (el) => el.createSpan({ text: "Combined file (.txt)" }),
					onSelect: () =>
						this.downloadTextFile(
							this.listGroupsToTxtLines(selectedGroups()),
							"mtg-lists-selection.txt"
						),
				},
				{
					render: (el) => el.createSpan({ text: "One file per list (.zip)" }),
					onSelect: () => {
						const entries: ZipEntry[] = selectedGroups().map((g) => ({
							name: `${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`,
							content: this.listGroupsToTxtLines([g]),
						}));
						this.downloadZip(entries, "mtg-lists-selection.zip");
					},
				},
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// Merges the selected lists into a new one — only makes sense from 2 lists
	// (merging "1 list" would change nothing), so explicitly disabled below
	// this threshold, independently of the generic "0 selected → disable
	// everything" toggle at the bottom of the function (which only covers the
	// 0 case). The modal itself serves as confirmation (pre-filled name to
	// review, source lists listed) — see MergeListsModal. My Collection only —
	// no equivalent for Decks/Wantlists, not requested.
	const mergeBtn = bar.createEl("button", { text: "Merge", cls: "mtg-bulk-action-btn" });
	actionButtons.push(mergeBtn);
	mergeBtn.disabled = this.selectedListIds.size < 2;
	mergeBtn.addEventListener("click", () => {
		new MergeListsModal(this.app, this.plugin, this, Array.from(this.selectedListIds)).open();
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
			const count = this.selectedListIds.size;
			this.plugin.bulkDeleteLists(Array.from(this.selectedListIds));
			this.selectedListIds.clear();
			new Notice(`Deleted ${count} list(s).`);
			this.render();
		});
		cancelBtn.addEventListener("click", () => this.render());
	});

	if (this.selectedListIds.size === 0) {
		actionButtons.forEach((btn) => (btn.disabled = true));
	}
}


export function renderListDetail(this: MTGCollectionView, listId: string) {
	const isVirtual = listId === ALL_CARDS_ID;
	// "Inbox" system list (see CollectionList.isInbox/ensureInboxList) — opens
	// InboxSettingsModal instead of ListSettingsModal from the "..." menu of
	// this sticky header, same reasoning as renderListTile.
	const isInbox = !isVirtual && !!this.plugin.settings.lists.find((l) => l.id === listId)?.isInbox;
	const group = isVirtual
		? {
				id: ALL_CARDS_ID,
				name: "All cards",
				cards: this.plugin.settings.collection,
				totalQty: this.plugin.settings.collection.reduce((s, c) => s + c.count, 0),
				totalValue: this.plugin.settings.collection.reduce(
					(s, c) => s + cardValue(c, this.plugin.settings.priceCurrency),
					0
				),
				coverImage: pickCoverImage(this.plugin.settings.collection),
		  }
		: groupByList(
				this.plugin.settings.lists,
				this.plugin.settings.collection,
				this.plugin.settings.priceCurrency
		  ).find((g) => g.id === listId);
	if (!group) {
		this.openListId = null;
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

	// The "← Back to X" button and the title row now share ONE SINGLE
	// container (.mtg-detail-header-banner, see styles.css for the full
	// reasoning) — rebuilt here on every render() like the rest of this
	// header, no second persistent sticky element to synchronize anymore (see
	// the old collectionBackRow, removed). That is what allows a cover image
	// (same source as the grid tile — groupByList/pickCoverImage,
	// core/price.ts) that is truly SINGLE behind the button AND the title at
	// once — one layer, not two to join together — when the list has an
	// illustration.
	const headerBanner = stickyHeader.createDiv({ cls: "mtg-detail-header-banner" });
	if (group.coverImage) {
		const bannerBg = headerBanner.createDiv({ cls: "mtg-detail-banner-bg" });
		bannerBg.style.backgroundImage = `url("${group.coverImage}")`;
		headerBanner.createDiv({ cls: "mtg-detail-banner-scrim" });
	}

	const backBtn = headerBanner.createEl("button", {
		text: "← Back to lists",
		cls: "mtg-back-btn",
	});
	backBtn.addEventListener("click", () => {
		this.openListId = null;
		this.lastFocusedFilterKey = null;
		this.listCardFilterTokens = [];
		this.listCardFilterDraft = "";
		this.selectedListCardIds.clear();
		this.listSelectMode = false;
		this.listBulkBarWasVisible = false;
		this.render();
	});

	const titleRow = headerBanner.createDiv({ cls: "mtg-deck-title-row" });
	const titleInfo = titleRow.createDiv({ cls: "mtg-title-info" });
	// Opens the settings (ListSettingsModal/InboxSettingsModal) on clicking
	// the title, instead of the original inline rename — explicitly requested,
	// renaming remains accessible from this same window. openListSettings is
	// reused further down by menuBtn (the "..." button) to avoid duplicating
	// the construction of the modal. isVirtual ("All Cards") has no settings
	// at all (no menuBtn either, see further down): title not clickable, as
	// before.
	const openListSettings = () => {
		if (isInbox) new InboxSettingsModal(this.app, this.plugin, this, group.id).open();
		else new ListSettingsModal(this.app, this.plugin, this, group.id).open();
	};
	if (!isVirtual) {
		const nameRow = titleInfo.createDiv({ cls: "mtg-detail-title-row" });
		nameRow.createEl("h3", { cls: "mtg-detail-title", text: group.name });
		nameRow.setAttribute("title", isInbox ? "Inbox settings" : "List settings");
		nameRow.addEventListener("click", openListSettings);
	} else {
		titleInfo.createEl("h3", { cls: "mtg-detail-title", text: group.name });
	}
	titleInfo.createDiv({
		cls: "mtg-detail-title-stats",
		text: `${group.cards.length} unique · ${group.totalQty} cards · ${formatMoney(group.totalValue, this.plugin.settings.priceCurrency)}`,
	});

	// "+ Add cards"/"Select cards"/"..." used to live on the title row, just
	// above — moved here, to the right of the search bar, to gain vertical
	// height (explicitly requested, annotated screenshot in support).
	// searchActionsRow (see styles.css) is the enclosing flex row; filterRow
	// grows to take the remaining space, actionsRow keeps its own width.
	const searchActionsRow = stickyHeader.createDiv({ cls: "mtg-detail-search-actions-row" });
	const filterRow = searchActionsRow.createDiv({ cls: "mtg-collection-toolbar mtg-inline-filter-row" });
	const actionsRow = searchActionsRow.createDiv({ cls: "mtg-detail-search-actions" });

	const addBtn = actionsRow.createEl("button", {
		text: "+ Add cards",
		cls: "mtg-search-add-btn",
	});
	addBtn.addEventListener("click", () => {
		if (isVirtual) {
			this.openAddCollectionCardsModalWithListPicker();
			return;
		}
		this.openAddCollectionCardsModal(group.id, group.name);
	});

	const selectModeBtn = actionsRow.createDiv({
		cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
	});
	if (this.listSelectMode) selectModeBtn.addClass("is-active");
	setIcon(selectModeBtn, this.listSelectMode ? "x" : "square-mouse-pointer");
	selectModeBtn.setAttribute("title", this.listSelectMode ? "Exit select mode" : "Select cards");
	selectModeBtn.addEventListener("click", () => {
		this.listSelectMode = !this.listSelectMode;
		if (!this.listSelectMode) {
			this.selectedListCardIds.clear();
			this.listBulkBarWasVisible = false;
		}
		this.render();
	});

	if (!isVirtual) {
		const menuBtn = actionsRow.createDiv({ cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large" });
		setIcon(menuBtn, "more-vertical");
		menuBtn.setAttribute("title", isInbox ? "Inbox settings" : "List settings");
		menuBtn.addEventListener("click", openListSettings);
	}
	// Snapshot of the in-session Map (see
	// MTGCollectionPlugin.getLegalitiesCache) — My Collection only, see
	// renderChipFilter for why Decks/Wantlists don't pass this argument.
	const legalitiesByScryfallId = this.plugin.getLegalitiesCache();
	const filteredCards = group.cards.filter((c) =>
		cardMatchesTokens(
			c,
			this.listCardFilterTokens,
			this.listCardFilterDraft,
			this.plugin.recentlyAddedCollectionCardIds,
			legalitiesByScryfallId
		)
	);
	this.renderChipFilter(
		filterRow,
		this.listCardFilterTokens,
		this.listCardFilterDraft,
		"Filter by name, rarity, color, type, ability, artist, set, #number, cmc, price, qty, added, language, condition, foil, recent, legal:format…",
		"list-card-filter",
		(tokens) => {
			this.listCardFilterTokens = tokens;
		},
		(draft) => {
			this.listCardFilterDraft = draft;
		},
		group.cards,
		this.plugin.recentlyAddedCollectionCardIds,
		legalitiesByScryfallId
	);

	// Background pre-fetch of the legalities of the ENTIRE open list (not just
	// the cards already rendered/paginated) as soon as a "legal:" token is
	// active — see MTGCollectionPlugin.bulkFetchLegalities. Just returns
	// `false` without doing anything if everything is already cached/in flight
	// (see that method): safe to call again on every render() without causing
	// a loop or network duplicates.
	if (tokensNeedLegalityData(this.listCardFilterTokens, this.listCardFilterDraft)) {
		void this.plugin.bulkFetchLegalities(group.cards.map((c) => c.scryfallId)).then((fetchedSomething) => {
			if (fetchedSomething) this.plugin.refreshOpenViews();
		});
	}

	this.renderGroupSortBar("list", stickyHeader);

	if (this.listSelectMode) {
		this.renderCollectionBulkActionsBar(
			stickyHeader,
			!this.listBulkBarWasVisible,
			filteredCards.map((c) => c.id)
		);
		this.listBulkBarWasVisible = true;
	} else {
		this.listBulkBarWasVisible = false;
	}

	const renderSignature = JSON.stringify([
		listId,
		this.listCardFilterTokens,
		this.listCardFilterDraft,
		this.listGroupBy,
		this.listSortBy,
		this.sortReverse,
		this.groupReverse,
		phoneAwareViewMode(this.listViewMode),
	]);
	if (this.lastListRenderSignature !== renderSignature) {
		this.listRenderLimit = RENDER_BATCH_SIZE;
		this.lastListRenderSignature = renderSignature;
	}

	const dataSignature = `${renderSignature}::${this.plugin.dataVersion}`;
	let cardGroups: CardGroup<CollectionCard>[];
	if (this.lastListDataSignature === dataSignature && this.cachedListCardGroups) {
		cardGroups = this.cachedListCardGroups;
	} else {
		cardGroups = groupAndSortCards(
			filteredCards,
			this.listGroupBy,
			this.listSortBy,
			this.sortReverse,
			this.groupReverse,
			this.plugin.settings.lists,
			// The price the row shows (finish + currency), not the USD field: the cache
			// is rebuilt on a currency change since saveSettings() bumps dataVersion.
			(c) => getCardPriceNumber(c, this.plugin.settings.priceCurrency)
		);
		this.cachedListCardGroups = cardGroups;
		this.lastListDataSignature = dataSignature;
	}
	if (this.listGroupBy !== "none") {
		const recentIds = this.plugin.recentlyAddedCollectionCardIds;
		if (recentIds.size > 0) {
			const filteredById = new Map(filteredCards.map((c) => [c.id, c]));
			// Array.from(...).reverse(): a JS Set keeps insertion order, so reversing
			// gives "most recently added first" without needing to compare timestamps.
			const recentCards = Array.from(recentIds)
				.reverse()
				.map((id) => filteredById.get(id))
				.filter((c): c is CollectionCard => !!c);
			if (recentCards.length > 0) {
				cardGroups = [
					{ label: "Recently added", isRecentlyAdded: true, cards: recentCards },
					...cardGroups,
				];
			}
		}
	}
	const visibleGroups = sliceGroupsForRender(cardGroups, this.listRenderLimit);
	// A group truncated by pagination (see sliceGroupsForRender) has a
	// cardGroup.cards shorter than its real content: the header counter and
	// "select all in this group" must stay accurate on the COMPLETE group, not
	// just on its currently rendered portion.
	const fullGroupCardsByLabel = new Map(cardGroups.map((g) => [g.label, g.cards]));
	// Complete "visual" order (all the groups, not only the portion already
	// rendered): serves as the basis for the previous/next navigation of
	// CardDetailModal, independently of what is actually displayed in the DOM
	// at the moment of the click.
	const navOrder = cardGroups.flatMap((g) => g.cards);
	this.navOrderForListClick = navOrder;

	// .mtg-detail-scroll-area (see styles.css): it is THIS element that
	// actually scrolls for this list, not this.mainEl (see
	// isDetailViewOpen/getActiveScrollEl/handleScrollAreaScroll,
	// src/view/shared-render-helpers.ts) — its own scrollbar therefore starts
	// exactly where the scrollable content begins, just under stickyHeader,
	// rather than at the top of the whole window as before. A new scroll
	// listener on every render() (non-persistent element, unlike this.mainEl)
	// — see the comment of handleScrollAreaScroll for why.
	const scrollArea = this.bodyEl.createDiv({ cls: "mtg-detail-scroll-area" });
	scrollArea.addEventListener("scroll", () => this.handleScrollAreaScroll(scrollArea));
	// Top/bottom fade (see setupPanelScrollFade, card-detail-fx.ts, already
	// used by the 3 card detail windows): without it, a row scrolling under
	// stickyHeader disappears abruptly at its lower border rather than fading
	// out — explicitly requested (screenshot in support). Same mechanism here
	// as there, just applied to a second scrolling element: mask-image reveals
	// the flat background of .mtg-detail-scroll-area (--background-primary,
	// identical to that of stickyHeader just above, no cover photo comes down
	// this far — see .mtg-detail-header-banner, confined to its own overflow:
	// hidden), so the join stays clean without any background color needing to
	// be redeclared here.
	setupPanelScrollFade(scrollArea);
	// "Cards: …" title (number of cards, "x of y cards match" during a search)
	// — see renderCardsCountTitle. An active "legal:" token whose legalities
	// are not all in the cache yet adds "Fetching legality data" next to it
	// (see bulkFetchLegalities above).
	renderCardsCountTitle(
		scrollArea,
		group.cards,
		filteredCards,
		this.listCardFilterTokens.length > 0 || this.listCardFilterDraft.length > 0,
		tokensNeedLegalityData(this.listCardFilterTokens, this.listCardFilterDraft) &&
			group.cards.some((c) => c.scryfallId && !legalitiesByScryfallId.has(c.scryfallId))
	);
	const list = scrollArea.createDiv({
		cls: `mtg-collection-list${viewModeClass(phoneAwareViewMode(this.listViewMode), "list")}${this.listSelectMode ? " mtg-collection-list-selecting" : ""}`,
	});
	if (phoneAwareViewMode(this.listViewMode) === "table" && filteredCards.length > 0) {
		this.renderTableHeader(
			list,
			this.listSelectMode ? ["", ...TABLE_COLUMNS_COLLECTION] : TABLE_COLUMNS_COLLECTION
		);
	}

	if (filteredCards.length === 0) {
		// A search with no results is not an empty list (same distinction as
		// renderDeckDetail): without this, the "empty" message contradicted the
		// "Cards: 0 of N cards match" title just above.
		list.createEl("p", {
			text:
				group.cards.length > 0
					? "No cards match your filters."
					: isVirtual
					  ? "Your collection is empty."
					  : "This list is empty. Use \"+ Search & add cards\" above.",
			cls: "mtg-status",
		});
	}

	this.lastRenderedListGroupLabels = cardGroups.filter((g) => g.label).map((g) => g.label);

	visibleGroups.forEach((cardGroup) => {
		const groupRows: HTMLElement[] = [];
		const isCollapsed = cardGroup.label ? this.listCollapsedGroups.has(cardGroup.label) : false;

		if (cardGroup.label) {
			const headerEl = list.createDiv({ cls: "mtg-group-header" });
			if (isCollapsed) headerEl.addClass("is-group-collapsed");
			if (this.listGroupBy === "color") {
				const hex =
					GROUP_LABEL_HEX[cardGroup.label] ??
					(cardGroup.label.includes("/") ? GROUP_LABEL_HEX.Multicolor : undefined);
				if (hex) {
					headerEl.addClass("mtg-group-header-colored");
					headerEl.style.setProperty("--mtg-group-color", hex);
				}
			}

			// Real checkbox: empty by default, gets checked and takes the accent color
			// once ALL the cards of the group are selected; otherwise (none or only
			// some), stays empty. Clicking toggles between "select all" and "deselect
			// all" for this precise group. Applies to the complete group
			// (fullGroupCards), not only its already rendered portion.
			const fullGroupCards = fullGroupCardsByLabel.get(cardGroup.label) ?? cardGroup.cards;
			const allSelected =
				fullGroupCards.length > 0 &&
				fullGroupCards.every((c) => this.selectedListCardIds.has(c.id));
			const selectGroupBtn = headerEl.createDiv({ cls: "mtg-group-header-select-btn" });
			if (allSelected) selectGroupBtn.addClass("is-checked");
			setIcon(selectGroupBtn, allSelected ? "square-check" : "square");
			selectGroupBtn.setAttribute(
				"title",
				allSelected ? "Deselect all cards in this group" : "Select all cards in this group"
			);
			selectGroupBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.listSelectMode = true;
				if (allSelected) {
					fullGroupCards.forEach((c) => this.selectedListCardIds.delete(c.id));
				} else {
					fullGroupCards.forEach((c) => this.selectedListCardIds.add(c.id));
				}
				this.render();
			});

			const centerEl = headerEl.createDiv({ cls: "mtg-group-header-center" });
			if (cardGroup.colorKeys) {
				// Grouping by color: the symbols replace the name (e.g. "Blue",
				// "Red/Green"), larger and centered.
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
				// Grouping by mana value: the generic Scryfall symbol (gray circle with
				// the number) replaces the text "Mana Value N".
				const iconEl = centerEl.createSpan({ cls: "mtg-group-header-icon" });
				const labelEl = centerEl.createSpan({ cls: "mtg-group-header-label" });
				void this.plugin.getManaSymbolSvg(String(Math.round(cardGroup.manaValueKey))).then((svg) => {
					if (!svg) {
						// Falls back to the text if Scryfall doesn't have this precise symbol
						// (e.g. very large values).
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
				// Grouping by set: the set's official symbol, in white, just before its
				// name.
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
				// No network fetch needed here (unlike the mana/set symbols above):
				// setIcon() renders a Lucide icon already available locally in Obsidian.
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
				const nowCollapsed = !this.listCollapsedGroups.has(cardGroup.label);
				if (nowCollapsed) this.listCollapsedGroups.add(cardGroup.label);
				else this.listCollapsedGroups.delete(cardGroup.label);
				headerEl.toggleClass("is-group-collapsed", nowCollapsed);
				this.toggleGroupRows(list, headerEl, groupRows, nowCollapsed, phoneAwareViewMode(this.listViewMode));
			});
		}

		cardGroup.cards.forEach((card) => {
			const rowOuter = list.createDiv({ cls: "mtg-card-row-outer" });
			groupRows.push(rowOuter);
			if (isCollapsed) {
				rowOuter.addClass("mtg-hidden");
				if (phoneAwareViewMode(this.listViewMode) !== "table") rowOuter.addClass("mtg-row-collapsed");
			}

			const isSelected = this.selectedListCardIds.has(card.id);
			const signature = this.collectionCardRowSignature(card, isSelected);
			// A recently added card deliberately appears both in the pinned "Recently
			// Added" group and in its normal group (see above) — so, for this render
			// ONLY, the same card.id is processed twice in this loop. A cache keyed
			// only by card.id would then make the SAME DOM node shared between the two
			// places: since a node can only have one parent, the second appendChild()
			// would silently remove it from the first (observed bug: the pinned
			// section displayed "1 card" in its header but stayed visually empty, the
			// row having been moved into the normal group rendered right after). A
			// dedicated key prefix for the pinned copy therefore gives two distinct
			// DOM nodes.
			const cacheKey = cardGroup.isRecentlyAdded ? `recent:${card.id}` : card.id;
			const cached = this.cachedListRowElements.get(cacheKey);
			const row =
				cached && cached.signature === signature
					? cached.el
					: phoneAwareViewMode(this.listViewMode) === "card"
					  ? this.buildCollectionCardTile(card, isSelected)
					  : this.buildCollectionCardRow(card, isSelected);
			if (!cached || cached.signature !== signature) {
				this.cachedListRowElements.set(cacheKey, { signature, el: row });
			}
			rowOuter.appendChild(row);
		});
	});

	// Purges the cached rows that no longer match the current filter (see
	// cachedListRowElements): without this, a session with many different
	// filters would make the cache grow without bound. The keys of the pinned
	// "Recently Added" copy (prefixed "recent:", see above) must be derived
	// the same way here, otherwise they would never match liveRowIds (which
	// only contains bare card.id values) and would be purged — then rebuilt —
	// on every render.
	const liveRowIds = new Set(
		cardGroups.flatMap((g) => g.cards.map((c) => (g.isRecentlyAdded ? `recent:${c.id}` : c.id)))
	);
	for (const id of this.cachedListRowElements.keys()) {
		if (!liveRowIds.has(id)) this.cachedListRowElements.delete(id);
	}

	// navOrder.length (not filteredCards.length): the pinned "Recently Added"
	// group doubles each recent card (see above), so the REAL number of rows
	// across cardGroups exceeds the number of unique cards in the list.
	// Comparing to filteredCards.length made pagination stop as soon as
	// renderLimit exceeded this undoubled count — while there were still
	// unrendered cards further along in the normal groups (real bug: on a list
	// of ~595 freshly added cards, renderLimit reached 600 while going through
	// the 594 rows of "Recently Added", 594 > 600 became false, and the next
	// group stayed frozen at 6 cards rendered out of 90, with no sentinel ever
	// recreated).
	if (navOrder.length > this.listRenderLimit) {
		this.renderLoadMoreSentinel(list, () => {
			this.listRenderLimit += RENDER_BATCH_SIZE;
			this.render();
		});
	}
}

// Lightweight signature of the fields that influence the rendering of a
// row: if it hasn't changed since the last render, the existing DOM row is
// reused as is (see cachedListRowElements) rather than rebuilt (async
// icons, listeners...).

export function collectionCardRowSignature(this: MTGCollectionView, card: CollectionCard, isSelected: boolean): string {
	return [
		card.imageUrl,
		card.setCode,
		card.rarity,
		card.finish,
		card.name,
		card.manaCost,
		card.setName,
		card.collectorNumber,
		card.language,
		card.condition,
		card.count,
		card.priceUsd,
		card.priceUsdFoil,
		card.priceEur,
		card.priceEurFoil,
		card.priceUsdEtched,
		card.priceEurEtched,
		this.plugin.settings.priceCurrency,
		isSelected,
		this.listSelectMode,
		// The Card view has a different DOM structure from List/Grid (full-width
		// image + info below, no title) — without this field, switching mode would
		// reuse as is a row already in the cache built for the OTHER mode (see
		// buildCollectionCardRow).
		phoneAwareViewMode(this.listViewMode),
	].join("|");
}

// Builds the content of a row (.mtg-card-row), detached from any parent —
// the caller is responsible for attaching it (see renderListDetail) and
// for updating cachedListRowElements. The main click references
// this.navOrderForClick (always up to date at click time) rather than a
// "navOrder" variable captured here: this row can survive, reused as is,
// across several renders whose navOrder would have changed
// (sort/grouping/filter) without its own content changing.

export function buildCollectionCardRow(this: MTGCollectionView, card: CollectionCard, isSelected: boolean): HTMLElement {
	const row = createDiv();
	row.addClass("mtg-card-row");
	if (isSelected) row.addClass("mtg-card-row-selected");

	if (this.listSelectMode) {
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
	// "Mana Value" column: only built in Table mode (see
	// TABLE_COLUMNS_COLLECTION, card-sorting.ts) — in the other modes this cell
	// has no place, and this.viewMode is already part of
	// collectionCardRowSignature above so a mode change rebuilds this row anyway
	// (see its own comment).
	if (phoneAwareViewMode(this.listViewMode) === "table") {
		const manaValueCell = body.createDiv({ cls: "mtg-table-mana-value-cell" });
		if (card.manaCost) {
			renderManaCostIcons(manaValueCell, card.manaCost, (letter) =>
				this.plugin.getManaSymbolSvg(letter)
			);
		} else {
			manaValueCell.createSpan({ cls: "mtg-table-mana-value-empty", text: "—" });
		}
		// Hover on the NAME only (nameSpan), not on the whole
		// .mtg-card-row-name-line cell — explicitly requested ("the name only, not
		// the whole cell").
		nameSpan.addEventListener("mouseenter", () =>
			this.showCardNamePreview(nameSpan, card.imageUrl)
		);
		nameSpan.addEventListener("mouseleave", () => this.hideCardNamePreview());
	}
	const setLine = body.createDiv({ cls: "mtg-card-row-set" });
	const setNameSpan = setLine.createSpan({
		cls: "mtg-card-row-set-name",
		text: card.setName,
	});
	const setNumberSpan = setLine.createSpan({
		cls: "mtg-card-row-set-number",
		text: `${card.setCode.toUpperCase()} #${card.collectorNumber}`,
	});
	const openPrintingPicker = (evt: MouseEvent) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		new ChangePrintingModal(this.app, this.plugin, card, () => this.render()).open();
	};
	[setNameSpan, setNumberSpan].forEach((el) => {
		el.setAttribute("title", "Click to change printing");
		el.addEventListener("click", openPrintingPicker);
	});

	const tagsLine = body.createDiv({ cls: "mtg-card-row-tags" });

	const langTrigger = tagsLine.createSpan({ cls: "mtg-icon-trigger" });
	createLanguageIcon(langTrigger, card.language);
	langTrigger.setAttribute("title", getLanguage(card.language).label);
	langTrigger.addEventListener("click", (evt) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		void this.plugin
			.getAvailableLanguages(card.setCode, card.collectorNumber)
			.then((availableCodes) => {
				const options = languagePickerOptions(availableCodes);
				openPickerMenu(
					langTrigger,
					options.map((l) => ({
						render: (el) => {
							createFlagImg(el, l.flag, "mtg-flag-img mtg-flag-img-inline");
							el.createSpan({ text: l.label });
						},
						onSelect: () => {
							this.plugin.setCollectionCardLanguage(card.id, l.code);
							this.render();
						},
					}))
				);
			});
	});

	// The badge (colored border) goes on an inner span, never on condTrigger
	// itself: in Table mode, .mtg-card-row-tags becomes display:contents (see
	// .mtg-collection-list-table higher up in styles.css) and condTrigger then
	// becomes a full-fledged grid item, stretched by the container to fill its
	// whole column — a border placed directly on it would then trace the
	// outline of the whole cell instead of staying a small badge (reported
	// bug). Same cell/content split as langTrigger just above, whose <img>
	// flag is already a child rather than the trigger itself.
	const condTrigger = tagsLine.createSpan({ cls: "mtg-icon-trigger" });
	createConditionIcon(condTrigger, card.condition);
	condTrigger.setAttribute("title", getCondition(card.condition).label);
	condTrigger.addEventListener("click", (evt) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		openPickerMenu(
			condTrigger,
			CONDITIONS.map((c) => ({
				render: (el) => {
					createConditionIcon(el, c.value, "mtg-picker-condition-glyph");
					el.createSpan({ text: c.label });
				},
				onSelect: () => {
					this.plugin.setCollectionCardCondition(card.id, c.value);
					this.render();
				},
			}))
		);
	});

	const stepper = row.createDiv({ cls: "mtg-stepper" });
	stepper.addEventListener("click", (evt) => {
		if (!this.listSelectMode) evt.stopPropagation();
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
		if (this.listSelectMode) return;
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
			this.plugin.setCollectionCardCount(card.id, Number(input.value), () => this.render());
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
		if (this.listSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeCollectionCardCount(card.id, 1, () => this.render());
	});
	downBtn.addEventListener("click", (evt) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeCollectionCardCount(card.id, -1, () => this.render());
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
		if (this.listSelectMode) {
			if (this.selectedListCardIds.has(card.id)) this.selectedListCardIds.delete(card.id);
			else this.selectedListCardIds.add(card.id);
			this.render();
			return;
		}
		new CardDetailModal(this.app, this.plugin, this, card, this.navOrderForListClick).open();
	});

	return row;
}

// Card view (My Collection): the card is displayed in full (no cropping, see
// renderThumbWithBadge variant "tile"), the name is deliberately NOT repeated below (already
// legible on the image itself — that's the point of this view). Reuses the same interactive
// widgets as buildCollectionCardRow (language/condition picker, stepper, price) rather than
// reinventing them, just rearranged in a vertical stack instead of a row — but remains a
// separate function rather than a layout parameter on buildCollectionCardRow, to follow the
// same per-variant duplication principle already established between
// buildCollectionCardRow/buildDeckCardRow/buildWantlistCardRow (see CLAUDE.md). On explicit
// request, only the set code (not its full name) is displayed — more compact, enough to
// identify the printing once the image is already visible.

export function buildCollectionCardTile(this: MTGCollectionView, card: CollectionCard, isSelected: boolean): HTMLElement {
	const tile = createDiv();
	tile.addClass("mtg-card-row", "mtg-card-tile");
	if (isSelected) tile.addClass("mtg-card-row-selected");

	if (this.listSelectMode) {
		const indicator = tile.createDiv({ cls: "mtg-card-row-select-indicator" });
		setIcon(indicator, isSelected ? "check-circle-2" : "circle");
		if (isSelected) indicator.addClass("is-selected");
	}

	this.renderThumbWithBadge(
		tile,
		card.imageUrl,
		card.setCode,
		card.rarity,
		finishHasFoilLook(card.finish),
		false,
		"tile"
	);

	const info = tile.createDiv({ cls: "mtg-card-tile-info" });

	// Row 1: set icon + code/number on the left; language, condition, foil
	// (the "secondary" info) on the right — same row, two groups spaced out
	// via justify-content:space-between (see .mtg-card-tile-row1).
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
		if (this.listSelectMode) return;
		evt.stopPropagation();
		new ChangePrintingModal(this.app, this.plugin, card, () => this.render()).open();
	});

	const row1Right = row1.createDiv({ cls: "mtg-card-tile-row1-right" });

	const langTrigger = row1Right.createSpan({ cls: "mtg-icon-trigger" });
	createLanguageIcon(langTrigger, card.language);
	langTrigger.setAttribute("title", getLanguage(card.language).label);
	langTrigger.addEventListener("click", (evt) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		void this.plugin
			.getAvailableLanguages(card.setCode, card.collectorNumber)
			.then((availableCodes) => {
				const options = languagePickerOptions(availableCodes);
				openPickerMenu(
					langTrigger,
					options.map((l) => ({
						render: (el) => {
							createFlagImg(el, l.flag, "mtg-flag-img mtg-flag-img-inline");
							el.createSpan({ text: l.label });
						},
						onSelect: () => {
							this.plugin.setCollectionCardLanguage(card.id, l.code);
							this.render();
						},
					}))
				);
			});
	});

	const condTrigger = row1Right.createSpan({ cls: "mtg-icon-trigger" });
	createConditionIcon(condTrigger, card.condition);
	condTrigger.setAttribute("title", getCondition(card.condition).label);
	condTrigger.addEventListener("click", (evt) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		openPickerMenu(
			condTrigger,
			CONDITIONS.map((c) => ({
				render: (el) => {
					createConditionIcon(el, c.value, "mtg-picker-condition-glyph");
					el.createSpan({ text: c.label });
				},
				onSelect: () => {
					this.plugin.setCollectionCardCondition(card.id, c.value);
					this.render();
				},
			}))
		);
	});

	if (card.finish !== "regular") {
		row1Right.createSpan({ cls: "mtg-foil-pill", text: getFinishLabel(card.finish) });
	}

	// Row 2: quantity, horizontal arrows — same widget/same classes as a
	// card's detail window (mtg-stepper-horizontal, round +/- buttons),
	// explicitly requested rather than the stacked chevrons of the List view.
	// No click-to-edit here (unlike the List view): the detail window itself
	// doesn't have it either, so faithfully reproducing "as in the detail
	// window" also means leaving out this feature, not just the style of the
	// buttons.
	const qtyRow = info.createDiv({ cls: "mtg-card-tile-qty-row" });
	// mtg-card-tile-stepper: enlarged +/- buttons, scoped to the Card view
	// only — the detail window keeps its own buttons at their original size
	// (mtg-stepper-horizontal alone), this modifier only applies here.
	const stepper = qtyRow.createDiv({ cls: "mtg-stepper mtg-stepper-horizontal mtg-card-tile-stepper" });
	stepper.addEventListener("click", (evt) => {
		if (!this.listSelectMode) evt.stopPropagation();
	});
	const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
	const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(downBtn, "minus");
	downBtn.toggleClass("is-disabled", card.count <= 1);
	controls.createDiv({ cls: "mtg-stepper-value", text: String(card.count) });
	const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
	setIcon(upBtn, "plus");
	upBtn.addEventListener("click", (evt) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeCollectionCardCount(card.id, 1, () => this.render());
	});
	downBtn.addEventListener("click", (evt) => {
		if (this.listSelectMode) return;
		evt.stopPropagation();
		this.plugin.changeCollectionCardCount(card.id, -1, () => this.render());
	});

	// Row 3: price, on a single line (unit + total, instead of the double
	// stack of the List view). Always created, even without a known price
	// (min-height reserved in CSS): otherwise the tiles of a same row would
	// not all have the same height depending on whether or not a Scryfall
	// price exists for this precise printing (reported bug).
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
		if (this.listSelectMode) {
			if (this.selectedListCardIds.has(card.id)) this.selectedListCardIds.delete(card.id);
			else this.selectedListCardIds.add(card.id);
			this.render();
			return;
		}
		new CardDetailModal(this.app, this.plugin, this, card, this.navOrderForListClick).open();
	});

	return tile;
}

export function renderCollectionBulkActionsBar(this: MTGCollectionView, container: HTMLElement, animate: boolean, visibleCardIds: string[]) {
	const bar = createBulkActionsBar(this, "list-cards", container, animate);

	bar.createSpan({
		cls: "mtg-bulk-actions-count",
		text: `${this.selectedListCardIds.size} selected`,
	});

	// "Select all" / "Clear": selection utilities, not actions on the cards
	// themselves — grouped together and visually separated from the rest.
	const selectionUtils = bar.createDiv({ cls: "mtg-bulk-selection-utils" });
	const selectAllBtn = selectionUtils.createEl("button", {
		text: "Select all",
		cls: "mtg-bulk-action-btn",
	});
	selectAllBtn.addEventListener("click", () => {
		visibleCardIds.forEach((id) => this.selectedListCardIds.add(id));
		this.render();
	});
	const clearBtn = selectionUtils.createEl("button", { text: "Clear", cls: "mtg-bulk-action-btn" });
	clearBtn.addEventListener("click", () => {
		this.selectedListCardIds.clear();
		this.render();
	});

	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	const selectedIds = () => Array.from(this.selectedListCardIds);
	// Clear has no useful effect without a selection (unlike Select all,
	// relevant precisely when the selection is empty) — included in
	// actionButtons to benefit from the same disabled toggle as the rest at
	// the bottom of the function, rather than a separate disabling.
	const actionButtons: HTMLButtonElement[] = [clearBtn];

	// Move to a list, a deck or a wantlist — reuses the same "Move card" modal
	// as the individual button of the detail panel (CopyCardModal, "move"
	// mode), now able to take several cards at once (see CopyCardModal.cards,
	// an array). Replaces the old "Move to list…" (a simple dropdown menu
	// limited to My Collection lists) — explicitly requested to get the same
	// 3-tab experience (search, "+ New X") everywhere as the rest of the
	// plugin rather than a second, poorer picker reserved for bulk. Renamed
	// "Move to" accordingly.
	const moveBtn = bar.createEl("button", { text: "Move to", cls: "mtg-bulk-action-btn" });
	actionButtons.push(moveBtn);
	moveBtn.addEventListener("click", () => {
		const cards = this.plugin.settings.collection.filter((c) => this.selectedListCardIds.has(c.id));
		if (cards.length === 0) return;
		new CopyCardModal(
			this.app,
			this.plugin,
			cards,
			"collection",
			() => {
				// The cards have left this list (moved elsewhere) — the selection no
				// longer points to valid rows here, same behavior as the old "Move to
				// list…".
				this.selectedListCardIds.clear();
				this.render();
			},
			"move"
		).open();
	});

	// Copy to a list, a deck or a wantlist — same modal as above, in copy mode
	// (CopyCardModal, "copy" mode by default). Replaces the old "Add to deck…"
	// (limited to decks) — same reason as "Move to" above. Renamed "Copy to"
	// accordingly. Does NOT clear selectedListCardIds (unlike Move): copying
	// removes nothing from the currently displayed list, so the selection
	// remains valid — same behavior as the old "Add to deck…".
	const copyBtn = bar.createEl("button", { text: "Copy to", cls: "mtg-bulk-action-btn" });
	actionButtons.push(copyBtn);
	copyBtn.addEventListener("click", () => {
		const cards = this.plugin.settings.collection.filter((c) => this.selectedListCardIds.has(c.id));
		if (cards.length === 0) return;
		new CopyCardModal(this.app, this.plugin, cards, "collection", () => {
			this.render();
		}).open();
	});

	// Change the condition — "Set condition" → "Condition" (saves space,
	// explicitly requested on 2026-09-08, same renaming for Set language/Set
	// finish/Set quantity further down and for the 3 bars My Collection/My
	// Decks/My Wantlists).
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
					this.plugin.bulkSetCollectionCardCondition(selectedIds(), cond.value);
					new Notice(`Condition set to "${cond.label}".`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// Change the language
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
					this.plugin.bulkSetCollectionCardLanguage(selectedIds(), l.code);
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
					this.plugin.bulkSetCollectionCardFinish(selectedIds(), f.value);
					new Notice(`Finish set to ${f.label}.`);
					this.render();
				},
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	// Set the quantity for the whole selection (inline editing, as for the
	// number of an individual card)
	const qtyBtn = bar.createEl("button", { text: "Quantity", cls: "mtg-bulk-action-btn" });
	actionButtons.push(qtyBtn);
	qtyBtn.addEventListener("click", () => {
		const input = bar.createEl("input", {
			cls: "mtg-bulk-qty-input",
			type: "number",
			attr: { min: "1" },
		});
		input.value = "1";

		// Visible Cancel next to the field — keyboard cancellation (Escape)
		// already existed but wasn't discoverable without knowing about it; a
		// visible button explicitly requested, same icon+text pair as
		// Delete/Cancel further down in this bar.
		const cancelQtyBtn = bar.createEl("button", { cls: "mtg-bulk-action-btn" });
		setIcon(cancelQtyBtn.createSpan({ cls: "mtg-bulk-action-btn-icon" }), "x");
		cancelQtyBtn.createSpan({ text: "Cancel" });

		replaceInBulkBar(qtyBtn, input, cancelQtyBtn);
		input.focus();
		input.select();
		const commit = () => {
			const count = this.selectedListCardIds.size;
			this.plugin.bulkSetCollectionCardCount(selectedIds(), Number(input.value));
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
		// mousedown + preventDefault prevents the input from losing focus (and
		// therefore from triggering commit via blur) at the moment we click on
		// Cancel — without this, the blur fires BEFORE the click of this button
		// (the browser's natural order) and validates the quantity by mistake
		// right before the cancellation. A simple removeEventListener in the click
		// handler would come too late; preventDefault on mousedown prevents the
		// blur from happening at all for this precise click.
		cancelQtyBtn.addEventListener("mousedown", (e) => e.preventDefault());
		cancelQtyBtn.addEventListener("click", () => {
			input.removeEventListener("blur", commit);
			this.render();
		});
	});

	// Export the selection to a file — "Export CSV" (simple button) and the
	// "Download file" of the old "TXT" menu merged into a single "Export"
	// button with a choice of format (CSV/TXT), explicitly requested on
	// 2026-09-08 to save space; "Copy to clipboard" (always in TXT format)
	// becomes its own simple button right after, rather than a 3rd option
	// hidden in this same menu — the two ideas ("which file to download" vs
	// "copy to the clipboard") are now two distinct buttons instead of 2
	// buttons each carrying a mix of both.
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
					onSelect: () => this.exportListSelectionCsv(),
				},
				{
					render: (el) => el.createSpan({ text: "TXT" }),
					onSelect: () => this.exportListSelectionTxt(),
				},
			],
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});

	const copyTxtBtn = bar.createEl("button", { text: "Copy to clipboard", cls: "mtg-bulk-action-btn" });
	actionButtons.push(copyTxtBtn);
	copyTxtBtn.addEventListener("click", () => this.copyListSelectionTxt());

	// Separator before Delete — same treatment as the one after Clear, to
	// visually isolate the destructive action from the rest of the actions.
	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	// Delete (with confirmation). Replaces the old "Confirm delete?" text (a
	// single button, with no way back once clicked) with a pair of buttons
	// that look distinct on click: red "Delete" (confirms) and "Cancel"
	// (cancels, returns to the initial state) — explicitly requested to be
	// able to cancel. The initial button stays neutral (not
	// mtg-bulk-action-btn-danger) until the first click — only turns red at
	// the confirmation stage, so as not to alarm permanently when no deletion
	// is in progress (explicitly requested).
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
			const count = this.selectedListCardIds.size;
			this.plugin.bulkRemoveCollectionCards(selectedIds());
			this.selectedListCardIds.clear();
			new Notice(`Deleted ${count} card(s).`);
			this.render();
		});
		// No data mutation — a full this.render() is enough to rebuild everything
		// from the current state (same selection still intact), same idiom as the
		// Escape cancellation of the quantity field just above.
		cancelBtn.addEventListener("click", () => this.render());
	});

	if (this.selectedListCardIds.size === 0) {
		actionButtons.forEach((btn) => (btn.disabled = true));
	}
}

// Deck version of renderCollectionBulkActionsBar — full parity with My Collection
// since 2026-09-08 (explicitly requested), once DeckCard was given
// finish/condition/language (My Decks/My Collection harmonization, 2026-08-25) and
// Move card/Copy card to (same date): Move to/Copy to reuse CopyCardModal
// (sourceKind: "deck") exactly like their individual buttons in
// DeckCardDetailModal, Condition/Language/Finish reuse
// bulkSetDeckCardCondition/Language/Finish (plugin.ts, same idioms as
// Condition/Language/Finish on the collection side), Export reuses
// buildDeckCsvString (already given the same columns as My Collection). Two buttons
// specific to My Decks, with no equivalent on the My Collection/My Wantlists side:
// "Board" (Mainboard/Sideboard/Maybeboard — same 3 options as the board tabs/the
// "Board" picker of DeckCardDetailModal, "Category" renamed on 2026-09-08) and
// "Function" (Ramp/Removal/etc., same picker as the "Function" box of this same
// modal), explicitly requested to apply either one to a whole selection rather than
// one card at a time. The delete button now reads "Delete" (like My Collection/My
// Wantlists, renamed on 2026-09-08 to save space) — the underlying distinction
// ("remove from the deck" ≠ "delete from the collection/wantlist") remains real,
// only the label changed (see bulkRemoveDeckCards, which never touches
// settings.collection/wantlist). Reuses the same CSS classes *and* the same idioms
// (no "…", carets on the dropdown menus, two-step Delete) as My Collection.

export function exportListCsv(this: MTGCollectionView, listId: string) {
	const list = this.plugin.settings.lists.find((l) => l.id === listId);
	const cards = this.plugin.settings.collection.filter((c) => c.listId === listId);
	const filename = `mtg-${(list?.name ?? "list").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
	this.downloadListCsv(cards, filename);
}

// Same "qty - name" format as listSelectionTxtLines further down, but for
// the ENTIRE list (ListSettingsModal, "Export"/"Copy to clipboard") rather
// than the current selection — two different subsets of
// settings.collection, so no direct reuse of listSelectionTxtLines is
// possible here.

export function listTxtLines(this: MTGCollectionView, listId: string): string {
	const cards = this.plugin.settings.collection.filter((c) => c.listId === listId);
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportListTxt(this: MTGCollectionView, listId: string) {
	const list = this.plugin.settings.lists.find((l) => l.id === listId);
	const filename = `mtg-${(list?.name ?? "list").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
	this.downloadTextFile(this.listTxtLines(listId), filename);
}

// navigator.clipboard.writeText: same precedent already established (see
// copyListSelectionTxt further down) — explicit .catch() rather than a
// resolution assumed to always happen.

export function copyListTxt(this: MTGCollectionView, listId: string) {
	const cardCount = this.plugin.settings.collection.filter((c) => c.listId === listId).length;
	navigator.clipboard
		.writeText(this.listTxtLines(listId))
		.then(() => new Notice(`Copied ${cardCount} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}


export function exportListSelectionCsv(this: MTGCollectionView) {
	const cards = this.plugin.settings.collection.filter((c) => this.selectedListCardIds.has(c.id));
	this.downloadListCsv(cards, "mtg-selection.csv");
}

// Simple format, one card per line: "3 - Lightning Bolt". Shared between
// the file export (exportListSelectionTxt) and the clipboard copy
// (copyListSelectionTxt) below, so that the two stay identical.

export function listSelectionTxtLines(this: MTGCollectionView): string {
	const cards = this.plugin.settings.collection.filter((c) => this.selectedListCardIds.has(c.id));
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportListSelectionTxt(this: MTGCollectionView) {
	this.downloadTextFile(this.listSelectionTxtLines(), "mtg-selection.txt");
}

// navigator.clipboard.writeText is not used anywhere else in this plugin —
// a new API surface here, so handled with an explicit .catch() (failure
// Notice) rather than assumed to always succeed.

export function copyListSelectionTxt(this: MTGCollectionView) {
	const count = this.selectedListCardIds.size;
	navigator.clipboard
		.writeText(this.listSelectionTxtLines())
		.then(() => new Notice(`Copied ${count} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}

// Pure construction (no side effects) of the CSV — extracted from downloadListCsv
// to be reusable as is by downloadZip (each list becomes an archive entry, see
// renderListGalleryBulkActionsBar) without duplicating the header/columns a second
// time.

export function buildListCsvString(this: MTGCollectionView, cards: CollectionCard[]): string {
	const header =
		"Name,Set,SetCode,CollectorNumber,Rarity,Count,Finish,Language,Condition,PriceUsd,List,GradingCompany,GradingGrade,GradingLabel,CustomPrice\n";
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
				c.language,
				c.condition,
				c.priceUsd,
				toCsvField(this.plugin.settings.lists.find((l) => l.id === c.listId)?.name ?? ""),
				c.gradingCompany ?? "",
				c.gradingGrade ?? "",
				toCsvField(c.gradingLabel ?? ""),
				toCsvField(c.customPrice ?? ""),
			].join(",")
		)
		.join("\n");
	return header + rows;
}


export function downloadListCsv(this: MTGCollectionView, cards: CollectionCard[], filename: string) {
	this.downloadTextFile(this.buildListCsvString(cards), filename, "text/csv");
}

// Same format as buildListCsvString, without Language/Condition (a wantlist
// card is not yet owned) — "Wantlist" rather than "List" as the last
// column.

export function listGroupsToTxtLines(this: MTGCollectionView, groups: ListGroup[]): string {
	return groups
		.map((g) => `# ${g.name}\n` + g.cards.map((c) => `${c.count} - ${c.name}`).join("\n"))
		.join("\n\n");
}

// Same principle as listGroupsToTxtLines above, on the wantlist side.

export function triggerImportIntoList(this: MTGCollectionView, listId: string) {
	this.triggerImportCollection(listId);
}

// "Import TXT" of ListSettingsModal — reads an external decklist .txt (Moxfield/Archidekt/plain text) and goes
// through plugin.importDecklistToList (parseDecklistText + Scryfall resolution) rather than through the
// dedicated CSV parser; the file/progress/summary flow is that of file-import.ts.

export function triggerImportTxtIntoList(this: MTGCollectionView, listId: string) {
	const list = this.plugin.settings.lists.find((l) => l.id === listId);
	importDecklistFile(this, {
		noun: "list",
		entityName: () => list?.name,
		run: (text, onStatus) => this.plugin.importDecklistToList(listId, text, onStatus),
	});
}


export function openList(this: MTGCollectionView, listId: string) {
	this.activeSection = "collection";
	this.openListId = listId;
	// Any grid-level selection (MergeListsModal, etc.) no longer makes sense
	// once we navigate to a specific list — without this, going back to the
	// grid afterwards could leave the selection mode active with ids of lists
	// now merged/deleted still in the selection.
	this.selectedListIds.clear();
	this.listGallerySelectMode = false;
	this.render();
}


export function closeListIfOpen(this: MTGCollectionView, listId: string) {
	if (this.openListId === listId) this.openListId = null;
	this.render();
}

