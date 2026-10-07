import { openPickerMenu } from "../ui/picker-menu";
import { DECK_SORT_BY_OPTIONS, WANTLIST_SORT_BY_OPTIONS, SORT_BY_OPTIONS, DECK_GROUP_BY_OPTIONS, GROUP_BY_OPTIONS, phoneAwareViewMode } from "../core/card-sorting";
import { setIcon } from "obsidian";
import type { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/*  Barre Group by / Sort by / modes d'affichage (en-tête d'une liste, d'un deck, d'une wantlist).*/
/* ---------------------------------------------------------------------------- */

export function persistSortSettings(this: MTGCollectionView) {
	this.plugin.settings.collectionGroupBy = this.listGroupBy;
	this.plugin.settings.collectionSortBy = this.listSortBy;
	this.plugin.settings.collectionSortReverse = this.sortReverse;
	this.plugin.settings.collectionGroupReverse = this.groupReverse;
	this.plugin.settings.collectionViewMode = this.listViewMode;
	this.plugin.settings.deckGroupBy = this.deckGroupBy;
	this.plugin.settings.deckSortBy = this.deckSortBy;
	this.plugin.settings.deckSortReverse = this.deckSortReverse;
	this.plugin.settings.deckGroupReverse = this.deckGroupReverse;
	this.plugin.settings.deckViewMode = this.deckViewMode;
	this.plugin.settings.deckActiveBoard = this.deckActiveBoard;
	this.plugin.settings.wantlistGroupBy = this.wantlistGroupBy;
	this.plugin.settings.wantlistSortBy = this.wantlistSortBy;
	this.plugin.settings.wantlistSortReverse = this.wantlistSortReverse;
	this.plugin.settings.wantlistGroupReverse = this.wantlistGroupReverse;
	this.plugin.settings.wantlistViewMode = this.wantlistViewMode;
	void this.plugin.saveSettings();
}
/* ---------------------------- Collection ---------------------------- */

export function renderGroupSortBar(this: MTGCollectionView, scope: "list" | "deck" | "wantlist", container: HTMLElement = this.bodyEl) {
	const bar = container.createDiv({ cls: "mtg-groupsort-row" });

	const sortOptions =
		scope === "deck" ? DECK_SORT_BY_OPTIONS : scope === "wantlist" ? WANTLIST_SORT_BY_OPTIONS : SORT_BY_OPTIONS;
	// "Category" (Commander/Mainboard/Sideboard/Maybeboard) n'existe que
	// côté deck (voir DECK_GROUP_BY_OPTIONS, card-sorting.ts) — List/
	// Wantlist gardent GROUP_BY_OPTIONS tel quel.
	const groupByOptions = scope === "deck" ? DECK_GROUP_BY_OPTIONS : GROUP_BY_OPTIONS;
	const groupBy = scope === "deck" ? this.deckGroupBy : scope === "wantlist" ? this.wantlistGroupBy : this.listGroupBy;
	const sortBy = scope === "deck" ? this.deckSortBy : scope === "wantlist" ? this.wantlistSortBy : this.listSortBy;
	const sortReverse =
		scope === "deck" ? this.deckSortReverse : scope === "wantlist" ? this.wantlistSortReverse : this.sortReverse;
	const groupReverse =
		scope === "deck"
			? this.deckGroupReverse
			: scope === "wantlist"
			  ? this.wantlistGroupReverse
			  : this.groupReverse;
	// Cluster "Group by" : la pilule et son bouton d'inversion sont collés
	// l'un à l'autre (pas d'espace, coins arrondis partagés).
	const groupCluster = bar.createDiv({ cls: "mtg-groupsort-cluster" });
	const groupBtn = groupCluster.createDiv({ cls: "mtg-groupsort-btn" });
	setIcon(groupBtn.createSpan({ cls: "mtg-groupsort-icon" }), "circle-dot");
	groupBtn.createSpan({ text: "Group by " });
	groupBtn.createSpan({
		cls: "mtg-groupsort-value",
		text: groupByOptions.find((o) => o.value === groupBy)?.label ?? "",
	});
	groupBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		openPickerMenu(
			groupBtn,
			groupByOptions.map((opt) => ({
				render: (el) => el.createSpan({ text: opt.label }),
				onSelect: () => {
					if (scope === "deck") this.deckGroupBy = opt.value;
					else if (scope === "wantlist") this.wantlistGroupBy = opt.value;
					else this.listGroupBy = opt.value;
					this.persistSortSettings();
					this.render();
				},
			})),
			// mtg-groupsort-picker-menu (styles.css) : le menu générique
			// .mtg-picker-menu plafonne à 260px et scrolle au-delà — avec 11
			// options côté deck (DECK_GROUP_BY_OPTIONS, "Type" étant toujours
			// la dernière puisque la liste est alphabétique), ça passe
			// largement sous la ligne de flottaison sans aucun indice visuel
			// de scroll (la scrollbar est invisible par défaut sur macOS tant
			// qu'on ne défile pas activement) — d'où un rapport "je ne vois
			// pas Group by Type" alors que l'option existe bel et bien. Ce
			// picker est ancré dans le sticky header, toujours proche du haut
			// de la fenêtre, donc une limite plus haute ne risque pas de
			// pousser le menu hors écran comme ce serait le cas pour un
			// picker générique ancré plus bas dans une longue liste.
			{ menuClass: "mtg-groupsort-picker-menu" }
		);
	});
	const groupReverseBtn = groupCluster.createDiv({ cls: "mtg-groupsort-reverse-btn" });
	setIcon(groupReverseBtn, "arrow-up-down");
	groupReverseBtn.setAttribute("title", "Reverse group order");
	groupReverseBtn.toggleClass("is-active", groupReverse);
	groupReverseBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		if (scope === "deck") this.deckGroupReverse = !this.deckGroupReverse;
		else if (scope === "wantlist") this.wantlistGroupReverse = !this.wantlistGroupReverse;
		else this.groupReverse = !this.groupReverse;
		this.persistSortSettings();
		this.render();
	});

	// Cluster "Sort by"
	const sortCluster = bar.createDiv({ cls: "mtg-groupsort-cluster" });
	const sortBtn = sortCluster.createDiv({ cls: "mtg-groupsort-btn" });
	setIcon(sortBtn.createSpan({ cls: "mtg-groupsort-icon" }), "list-filter");
	sortBtn.createSpan({ text: "Sort by " });
	sortBtn.createSpan({
		cls: "mtg-groupsort-value",
		text: sortOptions.find((o) => o.value === sortBy)?.label ?? "",
	});
	sortBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		openPickerMenu(
			sortBtn,
			sortOptions.map((opt) => ({
				render: (el) => el.createSpan({ text: opt.label }),
				onSelect: () => {
					if (scope === "deck") this.deckSortBy = opt.value;
					else if (scope === "wantlist") this.wantlistSortBy = opt.value;
					else this.listSortBy = opt.value;
					this.persistSortSettings();
					this.render();
				},
			})),
			// Même raisonnement que le picker "Group by" juste au-dessus —
			// "Sort by" grimpe jusqu'à 13 options (SORT_BY_OPTIONS, scope
			// "list"), le plus grand des deux.
			{ menuClass: "mtg-groupsort-picker-menu" }
		);
	});
	const sortReverseBtn = sortCluster.createDiv({ cls: "mtg-groupsort-reverse-btn" });
	setIcon(sortReverseBtn, "arrow-up-down");
	sortReverseBtn.setAttribute("title", "Reverse sort order");
	sortReverseBtn.toggleClass("is-active", sortReverse);
	sortReverseBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		if (scope === "deck") this.deckSortReverse = !this.deckSortReverse;
		else if (scope === "wantlist") this.wantlistSortReverse = !this.wantlistSortReverse;
		else this.sortReverse = !this.sortReverse;
		this.persistSortSettings();
		this.render();
	});

	// Cluster bascule d'affichage : liste (une carte par ligne), grille
	// (2 colonnes), ou tableau (dense, sans image, séparations horizontales).
	const viewMode = phoneAwareViewMode(
		scope === "deck" ? this.deckViewMode : scope === "wantlist" ? this.wantlistViewMode : this.listViewMode
	);
	const viewCluster = bar.createDiv({ cls: "mtg-groupsort-cluster mtg-view-toggle" });

	const listModeBtn = viewCluster.createDiv({ cls: "mtg-groupsort-reverse-btn mtg-viewmode-btn-list" });
	setIcon(listModeBtn, "mtg-one-column");
	listModeBtn.setAttribute("title", "List view");
	listModeBtn.toggleClass("is-active", viewMode === "list");
	listModeBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		if (scope === "deck") this.deckViewMode = "list";
		else if (scope === "wantlist") this.wantlistViewMode = "list";
		else this.listViewMode = "list";
		this.persistSortSettings();
		this.render();
	});

	const gridModeBtn = viewCluster.createDiv({ cls: "mtg-groupsort-reverse-btn mtg-viewmode-btn-grid" });
	setIcon(gridModeBtn, "layout-panel-top");
	gridModeBtn.setAttribute("title", "Grid view (2 columns)");
	gridModeBtn.toggleClass("is-active", viewMode === "grid");
	gridModeBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		if (scope === "deck") this.deckViewMode = "grid";
		else if (scope === "wantlist") this.wantlistViewMode = "grid";
		else this.listViewMode = "grid";
		this.persistSortSettings();
		this.render();
	});

	const tableModeBtn = viewCluster.createDiv({ cls: "mtg-groupsort-reverse-btn mtg-viewmode-btn-table" });
	setIcon(tableModeBtn, "table");
	tableModeBtn.setAttribute("title", "Table view (no images)");
	tableModeBtn.toggleClass("is-active", viewMode === "table");
	tableModeBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		if (scope === "deck") this.deckViewMode = "table";
		else if (scope === "wantlist") this.wantlistViewMode = "table";
		else this.listViewMode = "table";
		this.persistSortSettings();
		this.render();
	});

	const cardModeBtn = viewCluster.createDiv({ cls: "mtg-groupsort-reverse-btn mtg-viewmode-btn-card" });
	setIcon(cardModeBtn, "layout-grid");
	cardModeBtn.setAttribute("title", "Card view (full card images, 4 per row)");
	cardModeBtn.toggleClass("is-active", viewMode === "card");
	cardModeBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		if (scope === "deck") this.deckViewMode = "card";
		else if (scope === "wantlist") this.wantlistViewMode = "card";
		else this.listViewMode = "card";
		this.persistSortSettings();
		this.render();
	});

	if (scope === "deck") {
		const stacksModeBtn = viewCluster.createDiv({ cls: "mtg-groupsort-reverse-btn mtg-viewmode-btn-stacks" });
		setIcon(stacksModeBtn, "layers");
		stacksModeBtn.setAttribute("title", "Stacks view (cards piled by group, like Archidekt)");
		stacksModeBtn.toggleClass("is-active", viewMode === "stacks");
		stacksModeBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.deckViewMode = "stacks";
			// Le regroupement par défaut "Category" d'Archidekt sur sa propre
			// vue Stacks n'a plus d'équivalent depuis le 2026-09-07 : les
			// onglets Mainboard/Sideboard/Maybeboard (renderDeckBoardTabs)
			// séparent déjà les boards, Stacks garde simplement le
			// regroupement déjà choisi (ou "none" par défaut, une seule
			// colonne) au lieu d'en imposer un.
			this.persistSortSettings();
			this.render();
		});
	}

	if (groupBy !== "none") {
		const utilityCluster = bar.createDiv({ cls: "mtg-groupsort-cluster mtg-view-toggle" });
		const collapsedSet =
			scope === "deck" ? this.deckCollapsedGroups : scope === "wantlist" ? this.wantlistCollapsedGroups : this.listCollapsedGroups;
		const groupLabels =
			scope === "deck"
				? this.lastRenderedDeckGroupLabels
				: scope === "wantlist"
				  ? this.lastRenderedWantlistGroupLabels
				  : this.lastRenderedListGroupLabels;
		const toggleAllBtn = utilityCluster.createDiv({ cls: "mtg-groupsort-reverse-btn" });
		const anyCollapsed = groupLabels.some((l) => collapsedSet.has(l));
		const disabledInStacks = viewMode === "stacks";
		setIcon(toggleAllBtn, anyCollapsed ? "chevrons-down-up" : "chevrons-up-down");
		toggleAllBtn.toggleClass("is-disabled", disabledInStacks);
		toggleAllBtn.setAttribute(
			"title",
			disabledInStacks
				? "Collapse/expand all groups (not available in Stacks view)"
				: anyCollapsed
				  ? "Expand all groups"
				  : "Collapse all groups"
		);
		toggleAllBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (anyCollapsed) {
				groupLabels.forEach((l) => collapsedSet.delete(l));
			} else {
				groupLabels.forEach((l) => collapsedSet.add(l));
			}
			this.render();
		});
	}
}
