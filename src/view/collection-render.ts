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
		// Une fois ajoutée (stepper affiché), la tuile devient cliquable et
		// ouvre sa fenêtre de détail — demandé explicitement. navCards
		// n'est que la carte elle-même (pas la liste complète) : ce
		// contexte n'a pas de "liste de résultats de recherche affichée"
		// équivalente à naviguer en Cover Flow, donc pas de flèches
		// précédent/suivant ici (canNavigate exige navCards.length > 1).
		onOpenDetail: (entryId, onDetailClosed) => this.openCollectionCardDetailById(entryId, onDetailClosed),
		// Panneau "Add history" — annule/rejoue un ajout par sa clé de
		// dédoublonnage (scryfallId+listId+options), pas par un id de
		// ligne qui pourrait devenir invalide entre un disable et un
		// re-enable — voir onUndoAdd, shared-search-ui.ts.
		onUndoAdd: (card, options, undoListId, delta) =>
			this.plugin.undoAddToCollection(card.id, undoListId, options, delta),
		destinationName: listName,
		// Pilote les liens "Change printing"/"Move card" du panneau "Add
		// history" — voir sourceKind, shared-search-ui.ts.
		sourceKind: "collection",
		titleText: `Add cards to "${listName}"`,
	});
	modal.onClose = () => {
		modal.contentEl.empty();
		this.render();
	};
	modal.open();
}

// Partagé par les 2 flux d'ajout Collection (avec/sans sélecteur de
// liste) — voir onOpenDetail ci-dessus/plus bas. Recherche l'entrée par
// id plutôt que de faire remonter l'objet CollectionCard lui-même depuis
// AddCardsModal (qui ne connaît que { id, count }, voir
// AddCardsModalOptions.onAdd) — un lookup de plus, mais garde
// AddCardsModal générique, sans dépendance sur le modèle de données
// Collection. `onDetailClosed` (optionnel — bug corrigé : sans lui, la
// tuile carrousel d'origine restait affichée avec sa valeur périmée
// après un changement de quantité/une suppression depuis cette fenêtre
// de détail) est enveloppé autour du onClose EXISTANT de CardDetailModal
// plutôt que de l'écraser — capturé/lié AVANT d'être remplacé, puis
// rappelé explicitement en premier, pour ne perdre aucun nettoyage que
// CardDetailModal fait déjà de son côté (aujourd'hui juste
// contentEl.empty(), mais pas garanti de le rester). Relit la ligne
// APRÈS ce nettoyage plutôt que de réutiliser `card` (capturé avant
// ouverture, donc périmé si la quantité a changé ou si la ligne a été
// supprimée entre-temps) — undefined si elle n'existe plus.
// Publique (pas juste appelée depuis AddCardsModalOptions.onOpenDetail
// ci-dessus) depuis le 2026-09-08 : le bloc "Copies in Lists"
// cross-section (CardDetailModal/DeckCardDetailModal/
// WantlistCardDetailModal) l'appelle aussi directement pour ouvrir la
// bonne fenêtre sur une tuile My Collection cliquée depuis un autre
// modal — sans callback onDetailClosed dans ce cas (la fenêtre d'origine
// se ferme, rien à resynchroniser une fois la cible fermée).

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

// Depuis "All Cards", il n'y a pas de liste cible implicite : la modale
// affiche elle-même une galerie de listes (image de fond + nom) à choisir
// avant/pendant la recherche, plutôt qu'un menu texte à part.

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
		// Pas de destinationName ici — voir onUndoAdd, shared-search-ui.ts :
		// le flux listGallery résout plutôt le nom par listId depuis
		// listGallery.summaries, la destination variant tuile par tuile.
		onUndoAdd: (card, options, undoListId, delta) =>
			this.plugin.undoAddToCollection(card.id, undoListId, options, delta),
		sourceKind: "collection",
		titleText: "Add cards",
		// defaultListId (Inbox) : "Add"/"Add all" ajoutent directement à
		// Inbox sans ouvrir SelectListModal — demandé explicitement
		// ("sans choisir explicitement de liste, elle atterrit dans
		// Inbox"), voir AddCardsModalOptions.listGallery.defaultListId.
		// Pour choisir une AUTRE destination malgré tout : le panneau
		// "Add history" de cette même modale sait déjà déplacer une
		// carte tout juste ajoutée vers une autre liste (lien "Move" sur
		// la destination) — pas besoin d'un 2e sélecteur à l'ajout, qui
		// réintroduirait exactement le choix forcé que ceci enlève.
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
		// Inbox (liste système, épinglée à part de la grille) n'est pas comptée
		// comme une liste — demandé explicitement, pour rester cohérent avec le
		// titre « Lists: N lists » de la grille, qui ne la compte pas non plus.
		// Ses cartes, elles, restent dans totalCards/totalValue.
		const realListCount = this.plugin.settings.lists.filter((l) => !l.isInbox).length;
		this.headerStatsEl.setText(
			`${realListCount} lists · ${totalCards} cards · ${formatMoney(totalValue, currency)}`
		);
	}

	// Plus de garde "0 liste" ici : Inbox (voir CollectionList.isInbox/
	// ensureInboxList) est désormais garantie présente dès le chargement
	// des settings, donc this.plugin.settings.lists.length === 0 ne peut
	// plus jamais se produire une fois le plugin chargé.
	if (this.openListId) {
		this.renderListDetail(this.openListId);
	} else {
		this.renderListGrid();
	}
}


export function renderListGrid(this: MTGCollectionView) {
	const filter = this.filterEl.value.trim().toLowerCase();
	// Inbox (liste système, voir CollectionList.isInbox/ensureInboxList)
	// est retirée du tableau trié/filtré par l'utilisateur puis réinjectée à
	// part, dans la rangée épinglée avec "All Cards" (plus bas), pour qu'elle
	// reste toujours en tête quel que soit le tri/la recherche choisis.
	const inboxList = this.plugin.settings.lists.find((l) => l.isInbox);
	const allGroups = groupByList(
		this.plugin.settings.lists,
		this.plugin.settings.collection,
		this.plugin.settings.priceCurrency
	);
	const inboxGroup = inboxList ? allGroups.find((g) => g.id === inboxList.id) : undefined;
	// Les vraies listes, Inbox exclue : c'est exactement ce que la grille
	// affiche sous le titre « Lists: … » (voir plus bas), donc son « total ».
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

	// Rangée épinglée "Inbox"/"All Cards" — au plus 2 colonnes à elles deux,
	// jamais 4 comme la grille des vraies listes plus bas (demandé
	// explicitement), mais une seule (les deux tuiles l'une sous l'autre)
	// tant que le panneau est étroit, soit un téléphone en portrait : côte à
	// côte elles n'y faisaient plus qu'~135px chacune (~90px à 300px de
	// panneau), leur texte écrasé sur plusieurs lignes (demandé explicitement
	// aussi). Un .mtg-set-grid séparé plutôt que ces 2 tuiles en
	// tête de la grille principale : dans celle-ci leur largeur aurait suivi
	// le nombre de colonnes du moment (jusqu'à 4) au lieu de plafonner à 2.
	// Dans son PROPRE .mtg-set-grid-wrap — même conteneur de requête, donc
	// mêmes seuils que la grille principale : elle passe de 1 à 2 colonnes à
	// la même largeur de panneau, par construction, et
	// .mtg-pinned-tiles-grid neutralise le palier des 4 colonnes (voir
	// styles.css). Inbox avant "All Cards" — demandé explicitement ("Place
	// 'Inbox' en première position").
	//
	// Construite dans this.collectionPinnedEl (élément persistant du
	// squelette, voir onOpen) et non dans this.bodyEl : la rangée est AU-DESSUS
	// de la barre de filtre, qui est elle-même persistante et donc hors de
	// this.bodyEl — demandé explicitement (la recherche et le tri passent
	// après ces deux tuiles). Conséquence voulue : la recherche ne les
	// filtre plus (avant, "inbox"/"all cards" les masquait quand la saisie ne
	// leur correspondait pas). Sous la rangée, une tuile qui disparaîtrait au
	// fil de la frappe ferait sauter la barre de recherche elle-même vers le
	// haut pendant qu'on y écrit ; le tri, lui, ne les a jamais concernées.
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

	// La recherche ne porte que sur les vraies listes (la rangée épinglée
	// ci-dessus reste affichée quoi qu'il arrive) : sans saisie, une galerie
	// qui n'a que ses deux tuiles épinglées s'affiche normalement, avec sa
	// grille vide en dessous.
	if (filter && groups.length === 0) {
		this.bodyEl.createEl("p", {
			text: "No list matches your filter.",
			cls: "mtg-status",
		});
		return;
	}

	// Barre "Sort by" (comme à l'intérieur d'une liste).
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

	// Petit titre "Lists" au-dessus de la grille des vraies listes juste en
	// dessous — demandé explicitement, à l'origine pour la séparer de la
	// rangée épinglée qui la précédait immédiatement ; désormais sous la
	// barre de tri, la rangée épinglée étant passée au-dessus de la barre de
	// recherche (voir plus haut). Porte aussi le nombre de listes, qui passe
	// à « x of y lists match » pendant une recherche (demandé explicitement).
	this.bodyEl.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle("list", groups.length, realGroups.length, filter !== ""),
	});

	// Nombre de colonnes automatique (1/2/4 selon la largeur du panneau, plus
	// de choix utilisateur) : .mtg-set-grid-wrap est le conteneur de requête
	// dont dépend .mtg-set-grid — voir son commentaire dans styles.css.
	const gridWrap = this.bodyEl.createDiv({ cls: "mtg-set-grid-wrap" });
	const grid = gridWrap.createDiv({
		cls: `mtg-set-grid${this.listGallerySelectMode ? " mtg-gallery-selecting" : ""}`,
	});

	groups.forEach((group) => this.renderListTile(grid, group));
}

// isInbox : tuile de la liste système "Inbox" (voir CollectionList.isInbox
// /ensureInboxList) — rendue en couleur d'accent pleine, sans image/
// dégradé de fond, avec un petit pictogramme "inbox" (demandé
// explicitement), et jamais sélectionnable en mode sélection galerie
// (même traitement qu'isVirtual/"All Cards" ci-dessous : rien à
// supprimer/fusionner n'y correspond, voir aussi les garde-fous côté
// MTGCollectionPlugin.deleteList/renameList/bulkDeleteLists/mergeLists).
// Contrairement à "All Cards", le menu "..." reste affiché — mais ouvre
// InboxSettingsModal (Move + Export/Import CSV) plutôt que ListActions-
// Modal, qui exposerait à tort un renommage/une suppression — voir le
// routage isInbox plus bas.

export function renderListTile(this: MTGCollectionView, grid: HTMLElement, group: ListGroup, isInbox = false) {
	const isVirtual = group.id === ALL_CARDS_ID;
	const nonSelectable = isVirtual || isInbox;
	const tile = grid.createDiv({
		cls: `mtg-set-tile${isInbox ? " mtg-set-tile-inbox" : ""}${isVirtual ? " mtg-set-tile-all-cards" : ""}`,
	});
	// "All Cards" n'a plus non plus d'image de fond (demandé explicitement,
	// "Supprime l'image de fond de 'All cards'") — gris foncé fixe à la
	// place, voir .mtg-set-tile-all-cards, styles.css.
	if (group.coverImage && !isInbox && !isVirtual) {
		const bg = tile.createDiv({ cls: "mtg-set-tile-bg" });
		bg.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.85)), url("${group.coverImage}")`;
	}
	const content = tile.createDiv({ cls: "mtg-set-tile-content" });

	// Rangée épinglée (Inbox/"All Cards") : layout horizontal — un
	// pictogramme dans un cercle à gauche (fond plus sombre/légèrement
	// opaque, taille pensée pour les 3 lignes de texte), le texte à
	// droite — au lieu du layout vertical/ancré en bas des tuiles de
	// liste normales. Demandé explicitement avec un croquis ; une classe
	// modificatrice sur .mtg-set-tile-content (mtg-set-tile-content-
	// pinned) plutôt que de changer .mtg-set-tile-content lui-même, qui
	// reste par ailleurs le layout par défaut de toute autre tuile.
	let textParent = content;
	if (isInbox || isVirtual) {
		content.addClass("mtg-set-tile-content-pinned");
		const iconCircle = content.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
		setIcon(iconCircle, isInbox ? "inbox" : "gallery-horizontal-end");
		textParent = content.createDiv({ cls: "mtg-set-tile-pinned-text" });
	}

	// Pictogramme choisi manuellement (ListSettingsModal, "Choose icon")
	// pour une liste normale — même cercle à légère opacité que ci-dessus
	// (.mtg-set-tile-pictogram-circle, réutilisé tel quel), mais posé dans
	// une simple rangée imbriquée (mtg-set-tile-icon-row) plutôt que sur
	// .mtg-set-tile-content lui-même comme pour Inbox/"All Cards" : ces
	// deux-là n'ont pas d'image de fond, donc centrer tout le contenu
	// verticalement dans la tuile ne coûte rien ; une liste normale, elle,
	// a son dégradé de fond spécifiquement assombri vers le BAS pour la
	// lisibilité du texte ancré là (voir plus haut) — y appliquer le même
	// centrage vertical aurait déplacé le texte loin de la zone la plus
	// sombre du dégradé. La rangée imbriquée garde donc .mtg-set-tile-
	// content ancré en bas comme avant, avec juste ce nouveau bloc
	// (cercle + texte) comme unique enfant.
	if (group.icon && !isInbox && !isVirtual) {
		const iconRow = textParent.createDiv({ cls: "mtg-set-tile-icon-row" });
		const iconCircle = iconRow.createDiv({ cls: "mtg-set-tile-pictogram-circle" });
		// Mana (déjà coloré par Scryfall, jamais retouché) vs édition
		// (monochrome, recoloré en blanc pour rester lisible dans ce cercle
		// sombre — même traitement que les icônes d'en-tête de groupe
		// ailleurs dans ce fichier, applySvgColor(..., "#ffffff")).
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

	// Mode sélection galerie : "All Cards" (agrégat virtuel) et "Inbox"
	// (liste système) ne sont jamais sélectionnables — voir nonSelectable
	// ci-dessus.
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

	// Menu "..." masqué en mode sélection galerie : ouvrir les réglages
	// d'une liste au milieu d'une sélection multiple prêterait à
	// confusion (même raisonnement que le masquage du bouton "+ Add
	// cards" côté carte en mode select).
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

// Barre d'actions groupées de la grille "My Collection" (sélection de
// listes entières, pas de cartes) — même look/structure que
// renderCollectionBulkActionsBar (cartes), volontairement plus courte : seules les
// 3 actions demandées ont un sens ici (rien à déplacer/copier/regrouper
// entre listes elles-mêmes). visibleListIds sert à "Select all", comme
// visibleCardIds pour renderCollectionBulkActionsBar.

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

	// Fusionne les listes sélectionnées en une nouvelle — n'a de sens qu'à
	// partir de 2 listes (fusionner "1 liste" ne changerait rien), donc
	// désactivé explicitement en dessous de ce seuil, indépendamment du
	// bascule générique "0 sélectionné → tout désactiver" en bas de
	// fonction (qui, lui, ne couvre que le cas 0). La modale elle-même sert
	// de confirmation (nom pré-rempli à relire, listes d'origine listées) —
	// voir MergeListsModal. My Collection uniquement — pas d'équivalent
	// pour Decks/Wantlists, non demandé.
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
	// Liste système "Inbox" (voir CollectionList.isInbox/ensureInboxList) —
	// ouvre InboxSettingsModal au lieu de ListSettingsModal depuis le menu
	// "..." de ce sticky header, même raisonnement que renderListTile.
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

	// Le bouton "← Back to X" et la rangée titre partagent maintenant UN
	// SEUL conteneur (.mtg-detail-header-banner, voir styles.css pour le
	// raisonnement complet) — reconstruit ici à chaque render() comme le
	// reste de ce header, plus de second élément sticky persistant à
	// synchroniser (voir l'ancien collectionBackRow, supprimé). C'est ce
	// qui permet une image de couverture (même source que la tuile de la
	// grille — groupByList/pickCoverImage, core/price.ts) réellement
	// UNIQUE derrière le bouton ET le titre à la fois — un seul calque,
	// pas deux à raccorder — quand la liste a une illustration.
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
	// Ouvre les settings (ListSettingsModal/InboxSettingsModal) au clic sur
	// le titre, au lieu du renommage en ligne d'origine — demandé
	// explicitement, le renommage reste accessible depuis cette même
	// fenêtre. openListSettings est réutilisé plus bas par menuBtn (le
	// bouton "...") pour ne pas dupliquer la construction de la modale.
	// isVirtual ("All Cards") n'a pas de settings du tout (pas de menuBtn
	// non plus, voir plus bas) : titre non cliquable, comme avant.
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

	// "+ Add cards"/"Select cards"/"..." vivaient auparavant sur la
	// rangée du titre, juste au-dessus — déplacés ici, à droite de la
	// barre de recherche, pour gagner de la hauteur verticale (demandé
	// explicitement, capture d'écran annotée à l'appui). searchActionsRow
	// (voir styles.css) est la rangée flex englobante ; filterRow grandit
	// pour occuper l'espace restant, actionsRow garde sa largeur propre.
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
	// Snapshot de la Map en cours de session (voir MTGCollectionPlugin.
	// getLegalitiesCache) — My Collection uniquement, voir renderChipFilter
	// pour pourquoi Decks/Wantlists ne passent pas cet argument.
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

	// Pré-fetch en arrière-plan des légalités de TOUTE la liste ouverte
	// (pas juste des cartes déjà rendues/paginées) dès qu'un jeton
	// "legal:" est actif — voir MTGCollectionPlugin.bulkFetchLegalities.
	// Se contente de renvoyer `false` sans rien faire si tout est déjà en
	// cache/en vol (voir cette méthode) : sûr à rappeler à chaque render()
	// sans provoquer de boucle ou de doublons réseau.
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
			this.plugin.settings.lists
		);
		this.cachedListCardGroups = cardGroups;
		this.lastListDataSignature = dataSignature;
	}
	if (this.listGroupBy !== "none") {
		const recentIds = this.plugin.recentlyAddedCollectionCardIds;
		if (recentIds.size > 0) {
			const filteredById = new Map(filteredCards.map((c) => [c.id, c]));
			// Array.from(...).reverse() : un Set JS garde l'ordre d'insertion,
			// donc inverser donne "le plus récemment ajouté en premier" sans
			// avoir besoin de comparer des timestamps.
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
	// Un groupe tronqué par la pagination (voir sliceGroupsForRender) a un
	// cardGroup.cards plus court que son vrai contenu : le compteur d'en-tête
	// et "tout sélectionner ce groupe" doivent rester exacts sur le groupe
	// COMPLET, pas seulement sur sa portion actuellement rendue.
	const fullGroupCardsByLabel = new Map(cardGroups.map((g) => [g.label, g.cards]));
	// Ordre "visuel" complet (tous les groupes, pas seulement la portion
	// déjà rendue) : sert de base à la navigation précédent/suivant de
	// CardDetailModal, indépendamment de ce qui est effectivement affiché
	// dans le DOM à l'instant du clic.
	const navOrder = cardGroups.flatMap((g) => g.cards);
	this.navOrderForListClick = navOrder;

	// .mtg-detail-scroll-area (voir styles.css) : c'est CET élément-ci qui
	// défile réellement pour cette liste, pas this.mainEl (voir
	// isDetailViewOpen/getActiveScrollEl/handleScrollAreaScroll,
	// src/view/shared-render-helpers.ts) —
	// sa propre scrollbar démarre donc exactement là où le contenu
	// défilable commence, juste sous stickyHeader, plutôt qu'en haut de
	// toute la fenêtre comme avant. Un nouveau listener de scroll à chaque
	// render() (élément non persistant, contrairement à this.mainEl) —
	// voir le commentaire de handleScrollAreaScroll pour pourquoi.
	const scrollArea = this.bodyEl.createDiv({ cls: "mtg-detail-scroll-area" });
	scrollArea.addEventListener("scroll", () => this.handleScrollAreaScroll(scrollArea));
	// Fondu haut/bas (voir setupPanelScrollFade, card-detail-fx.ts, déjà
	// utilisé par les 3 fenêtres de détail carte) : sans lui, une rangée qui
	// défile sous stickyHeader disparaît net à sa bordure inférieure plutôt
	// que de s'estomper — demandé explicitement (capture à l'appui). Même
	// mécanisme ici que là-bas, juste appliqué à un second élément
	// défilant : mask-image révèle le fond plat de .mtg-detail-scroll-area
	// (--background-primary, identique à celui de stickyHeader juste
	// au-dessus, aucune photo de couverture ne descend jusqu'ici — voir
	// .mtg-detail-header-banner, confiné à son propre overflow: hidden),
	// donc le raccord reste net sans qu'aucune couleur de fond n'ait
	// besoin d'être redéclarée ici.
	setupPanelScrollFade(scrollArea);
	// Titre "Cards: …" (nombre de cartes, "x of y cards match" pendant une
	// recherche) — voir renderCardsCountTitle. Un jeton "legal:" actif dont
	// les légalités ne sont pas toutes encore en cache ajoute "Fetching
	// legality data" à côté (voir bulkFetchLegalities plus haut).
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
		// Une recherche sans résultat n'est pas une liste vide (même
		// distinction que renderDeckDetail) : sans ça le message "empty"
		// contredisait le titre "Cards: 0 of N cards match" juste au-dessus.
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

			// Case à cocher réelle : vide par défaut, se coche et prend la
			// couleur d'accent une fois que TOUTES les cartes du groupe sont
			// sélectionnées ; sinon (aucune ou seulement une partie), reste
			// vide. Cliquer bascule entre "tout sélectionner" et "tout
			// désélectionner" ce groupe précis. Porte sur le groupe complet
			// (fullGroupCards), pas seulement sur sa portion déjà rendue.
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
				// Groupement par couleur : les symboles remplacent le nom (ex.
				// "Blue", "Red/Green"), plus grands et centrés.
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
				// Groupement par valeur de mana : le symbole générique Scryfall
				// (rond gris avec le chiffre) remplace le texte "Mana Value N".
				const iconEl = centerEl.createSpan({ cls: "mtg-group-header-icon" });
				const labelEl = centerEl.createSpan({ cls: "mtg-group-header-label" });
				void this.plugin.getManaSymbolSvg(String(Math.round(cardGroup.manaValueKey))).then((svg) => {
					if (!svg) {
						// Repli sur le texte si Scryfall n'a pas ce symbole précis
						// (ex. très grandes valeurs).
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
				// Groupement par édition : le symbole officiel du set, en blanc,
				// juste avant son nom.
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
				// Pas de fetch réseau nécessaire ici (contrairement aux symboles
				// mana/set ci-dessus) : setIcon() rend une icône Lucide déjà
				// disponible localement dans Obsidian.
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
			// Une carte récemment ajoutée apparaît volontairement à la fois
			// dans le groupe épinglé "Recently Added" et dans son groupe
			// normal (voir plus haut) — donc, pour ce SEUL rendu, le même
			// card.id est traité deux fois dans cette boucle. Un cache
			// keyé uniquement par card.id ferait alors partager le MÊME
			// nœud DOM aux deux endroits : comme un nœud n'a qu'un seul
			// parent possible, le second appendChild() le retirerait
			// silencieusement du premier (bug observé : la section
			// épinglée affichait "1 card" dans son en-tête mais restait
			// visuellement vide, la ligne ayant été déplacée dans le
			// groupe normal rendu juste après). Un préfixe de clé dédié
			// pour la copie épinglée donne donc deux nœuds DOM distincts.
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

	// Purge les lignes mises en cache qui ne correspondent plus au filtre
	// courant (voir cachedListRowElements) : sans ça, une session avec
	// beaucoup de filtres différents ferait grossir le cache sans borne.
	// Les clés de la copie épinglée "Recently Added" (préfixées "recent:",
	// voir plus haut) doivent être dérivées la même façon ici, sinon elles
	// ne correspondraient jamais à liveRowIds (qui ne contient que des
	// card.id nus) et seraient purgées — puis reconstruites — à chaque rendu.
	const liveRowIds = new Set(
		cardGroups.flatMap((g) => g.cards.map((c) => (g.isRecentlyAdded ? `recent:${c.id}` : c.id)))
	);
	for (const id of this.cachedListRowElements.keys()) {
		if (!liveRowIds.has(id)) this.cachedListRowElements.delete(id);
	}

	// navOrder.length (pas filteredCards.length) : le groupe épinglé
	// "Recently Added" double chaque carte récente (voir plus haut), donc
	// le nombre RÉEL de lignes à travers cardGroups dépasse le nombre de
	// cartes uniques de la liste. Comparer à filteredCards.length faisait
	// arrêter la pagination dès que renderLimit dépassait ce compte non
	// doublé — alors qu'il restait encore des cartes non rendues plus loin
	// dans les groupes normaux (bug réel : sur une liste de ~595 cartes
	// fraîchement ajoutées, renderLimit atteignait 600 en parcourant les
	// 594 lignes de "Recently Added", 594 > 600 devenait faux, et le
	// groupe suivant restait figé à 6 cartes rendues sur 90, sans plus
	// jamais recréer de sentinelle).
	if (navOrder.length > this.listRenderLimit) {
		this.renderLoadMoreSentinel(list, () => {
			this.listRenderLimit += RENDER_BATCH_SIZE;
			this.render();
		});
	}
}

// Signature légère des champs qui influent sur le rendu d'une ligne : si
// elle n'a pas changé depuis le dernier rendu, la ligne DOM existante est
// réutilisée telle quelle (voir cachedListRowElements) plutôt que
// reconstruite (icônes async, écouteurs...).

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
		// La vue Carte a une structure DOM différente de Liste/Grille (image
		// pleine largeur + infos en dessous, pas de titre) — sans ce champ,
		// basculer de mode réutiliserait telle quelle une ligne déjà en
		// cache construite pour l'AUTRE mode (voir buildCollectionCardRow).
		phoneAwareViewMode(this.listViewMode),
	].join("|");
}

// Construit le contenu d'une ligne (.mtg-card-row), détaché de tout
// parent — appelant responsable de l'attacher (voir renderListDetail) et
// de mettre cachedListRowElements à jour. Le clic principal référence
// this.navOrderForClick (toujours à jour au moment du clic) plutôt qu'une
// variable "navOrder" capturée ici : cette ligne peut survivre, réutilisée
// telle quelle, à plusieurs rendus dont le navOrder aurait changé
// (tri/groupement/filtre) sans que son propre contenu change.

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
	// Colonne "Mana Value" : uniquement construite en mode Tableau (voir
	// TABLE_COLUMNS_COLLECTION, card-sorting.ts) — dans les autres modes
	// cette cellule n'a pas sa place, et this.viewMode fait déjà partie de
	// collectionCardRowSignature ci-dessus donc un changement de mode reconstruit
	// cette ligne de toute façon (voir son propre commentaire).
	if (phoneAwareViewMode(this.listViewMode) === "table") {
		const manaValueCell = body.createDiv({ cls: "mtg-table-mana-value-cell" });
		if (card.manaCost) {
			renderManaCostIcons(manaValueCell, card.manaCost, (letter) =>
				this.plugin.getManaSymbolSvg(letter)
			);
		} else {
			manaValueCell.createSpan({ cls: "mtg-table-mana-value-empty", text: "—" });
		}
		// Survol du NOM seulement (nameSpan), pas de toute la cellule
		// .mtg-card-row-name-line — demandé explicitement ("le nom
		// seulement, pas la cellule en entière").
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

	// La badge (bordure colorée) va sur un span interne, jamais sur
	// condTrigger lui-même : en mode Tableau, .mtg-card-row-tags passe en
	// display:contents (voir .mtg-collection-list-table plus haut dans
	// styles.css) et condTrigger devient alors un item de grille à part
	// entière, étiré par le conteneur pour remplir toute sa colonne — une
	// bordure posée directement dessus tracerait alors le contour de toute
	// la cellule au lieu de rester un petit badge (bug rapporté). Même
	// scission cellule/contenu que langTrigger juste au-dessus, dont le
	// drapeau <img> est déjà un enfant plutôt que le trigger lui-même.
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

// Vue Carte (My Collection) : la carte s'affiche en entier (pas de recadrage,
// voir renderThumbWithBadge variant "tile"), le nom n'est volontairement PAS
// répété en dessous (déjà lisible sur l'image elle-même — c'est le point de
// cette vue). Réutilise les mêmes widgets interactifs que buildCollectionCardRow
// (picker langue/condition, stepper, prix) plutôt que de les réinventer,
// juste réarrangés dans un empilement vertical au lieu d'une ligne — mais
// reste une fonction séparée plutôt qu'un paramètre de mise en page sur
// buildCollectionCardRow, pour suivre le même principe de duplication par variante déjà
// établi entre buildCollectionCardRow/buildDeckCardRow/buildWantlistCardRow (voir CLAUDE.md).
// Sur demande explicite, seul le code d'édition (pas son nom complet) est
// affiché — plus compact, suffisant pour identifier l'impression une fois
// l'image déjà visible.

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

	// Ligne 1 : icône d'édition + code/numéro à gauche ; langue, état, foil
	// (les infos "secondaires") à droite — même ligne, deux groupes espacés
	// via justify-content:space-between (voir .mtg-card-tile-row1).
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

	// Ligne 2 : quantité, flèches horizontales — même widget/mêmes classes
	// que la fenêtre de détail d'une carte (mtg-stepper-horizontal, boutons
	// ronds +/-), demandé explicitement plutôt que les chevrons empilés de
	// la vue Liste. Pas de clic-pour-éditer ici (contrairement à la vue
	// Liste) : la fenêtre de détail elle-même n'en a pas non plus, donc
	// reproduire fidèlement "comme dans la fenêtre de détail" veut dire
	// aussi laisser de côté cette fonctionnalité, pas seulement le style
	// des boutons.
	const qtyRow = info.createDiv({ cls: "mtg-card-tile-qty-row" });
	// mtg-card-tile-stepper : boutons +/- agrandis, scopés à la vue Carte
	// uniquement — la fenêtre de détail garde ses propres boutons à leur
	// taille d'origine (mtg-stepper-horizontal seul), ce modificateur ne
	// s'applique qu'ici.
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

	// Ligne 3 : prix, sur une seule ligne (unité + total, plus le double
	// empilement de la vue Liste). Toujours créée, même sans prix connu
	// (min-height réservé en CSS) : sinon les tuiles d'une même rangée
	// n'ont pas toutes la même hauteur selon qu'un prix Scryfall existe ou
	// non pour cette impression précise (bug rapporté).
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

	// "Select all" / "Clear" : utilitaires de sélection, pas des actions sur
	// les cartes elles-mêmes — regroupés et séparés visuellement du reste.
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
	// Clear n'a aucun effet utile sans sélection (contrairement à Select
	// all, pertinent justement quand la sélection est vide) — inclus dans
	// actionButtons pour profiter du même bascule disabled que le reste
	// en bas de fonction, plutôt qu'un désactivage séparé.
	const actionButtons: HTMLButtonElement[] = [clearBtn];

	// Déplacer vers une liste, un deck ou une wantlist — réutilise la même
	// modale "Move card" que le bouton individuel du panneau de détail
	// (CopyCardModal, mode "move"), maintenant capable de prendre
	// plusieurs cartes à la fois (voir CopyCardModal.cards, un tableau).
	// Remplace l'ancien "Move to list…" (un simple menu déroulant limité
	// aux listes My Collection) — demandé explicitement pour retrouver
	// partout la même expérience à 3 onglets (recherche, "+ New X") que
	// le reste du plugin plutôt qu'un second picker plus pauvre réservé
	// au bulk. Renommé "Move to" en conséquence.
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
				// Les cartes ont quitté cette liste (déplacées ailleurs) — la
				// sélection ne pointe plus vers des lignes valides ici, même
				// comportement que l'ancien "Move to list…".
				this.selectedListCardIds.clear();
				this.render();
			},
			"move"
		).open();
	});

	// Copier vers une liste, un deck ou une wantlist — même modale que
	// ci-dessus, en mode copie (CopyCardModal, mode "copy" par défaut).
	// Remplace l'ancien "Add to deck…" (limité aux decks) — même raison
	// que "Move to" ci-dessus. Renommé "Copy to" en conséquence.
	// Ne vide PAS selectedListCardIds (contrairement à Move) : copier ne
	// retire rien de la liste actuellement affichée, la sélection reste
	// donc valide — même comportement que l'ancien "Add to deck…".
	const copyBtn = bar.createEl("button", { text: "Copy to", cls: "mtg-bulk-action-btn" });
	actionButtons.push(copyBtn);
	copyBtn.addEventListener("click", () => {
		const cards = this.plugin.settings.collection.filter((c) => this.selectedListCardIds.has(c.id));
		if (cards.length === 0) return;
		new CopyCardModal(this.app, this.plugin, cards, "collection", () => {
			this.render();
		}).open();
	});

	// Changer l'état — "Set condition" → "Condition" (gain de place,
	// demandé explicitement le 2026-09-08, même renommage pour Set
	// language/Set finish/Set quantity plus bas et pour les 3 barres
	// My Collection/My Decks/My Wantlists).
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

	// Changer la langue
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

	// Définir la quantité pour toute la sélection (édition en ligne, comme
	// pour le chiffre d'une carte individuelle)
	const qtyBtn = bar.createEl("button", { text: "Quantity", cls: "mtg-bulk-action-btn" });
	actionButtons.push(qtyBtn);
	qtyBtn.addEventListener("click", () => {
		const input = bar.createEl("input", {
			cls: "mtg-bulk-qty-input",
			type: "number",
			attr: { min: "1" },
		});
		input.value = "1";

		// Cancel visible à côté du champ — l'annulation au clavier
		// (Escape) existait déjà mais n'était pas découvrable sans le
		// savoir ; demandé explicitement pour un bouton visible, même
		// paire icône+texte que Delete/Cancel plus bas dans cette barre.
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
		// mousedown + preventDefault empêche l'input de perdre le focus
		// (et donc de déclencher commit via blur) au moment où on clique
		// sur Cancel — sans ça, le blur se déclenche AVANT le click de ce
		// bouton (l'ordre naturel du navigateur) et valide la quantité
		// par erreur juste avant l'annulation. Un simple
		// removeEventListener dans le handler click arriverait trop
		// tard ; preventDefault sur mousedown empêche le blur de se
		// produire du tout pour ce clic précis.
		cancelQtyBtn.addEventListener("mousedown", (e) => e.preventDefault());
		cancelQtyBtn.addEventListener("click", () => {
			input.removeEventListener("blur", commit);
			this.render();
		});
	});

	// Exporter la sélection en fichier — "Export CSV" (bouton simple) et le
	// "Download file" de l'ancien menu "TXT" fusionnés en un seul bouton
	// "Export" avec un choix de format (CSV/TXT), demandé explicitement le
	// 2026-09-08 pour gagner de la place ; "Copy to clipboard" (presse-
	// papier, toujours au format TXT) devient son propre bouton simple
	// juste après, plutôt qu'une 3e option cachée dans ce même menu — les
	// deux idées ("quel fichier télécharger" vs "copier dans le presse-
	// papier") sont désormais deux boutons distincts au lieu de 2 boutons
	// portant chacun un mélange des deux.
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

	// Séparateur avant Delete — même traitement que celui après Clear,
	// pour isoler visuellement l'action destructive du reste des actions.
	bar.createDiv({ cls: "mtg-bulk-actions-divider" });

	// Supprimer (avec confirmation). Remplace l'ancien texte "Confirm
	// delete?" (un seul bouton, sans retour en arrière possible une fois
	// cliqué) par une paire de boutons visuellement distincts au clic :
	// "Delete" rouge (confirme) et "Cancel" (annule, revient à l'état
	// initial) — demandé explicitement pour pouvoir annuler. Le bouton
	// initial reste neutre (pas mtg-bulk-action-btn-danger) tant qu'on
	// n'a pas cliqué une première fois — ne devient rouge qu'au stade de
	// confirmation, pour ne pas alarmer en permanence alors qu'aucune
	// suppression n'est engagée (demandé explicitement).
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
		// Aucune mutation de données — un plein this.render() suffit à
		// tout reconstruire depuis l'état actuel (même sélection encore
		// intacte), même idiome que l'annulation Escape du champ quantité
		// juste au-dessus.
		cancelBtn.addEventListener("click", () => this.render());
	});

	if (this.selectedListCardIds.size === 0) {
		actionButtons.forEach((btn) => (btn.disabled = true));
	}
}

// Version deck de renderCollectionBulkActionsBar — pleine parité avec My Collection
// depuis le 2026-09-08 (demandé explicitement), une fois DeckCard doté de
// finish/condition/langue (harmonisation My Decks/My Collection,
// 2026-08-25) et Move card/Copy card to (même date) : Move to/Copy to
// réutilisent CopyCardModal (sourceKind: "deck") exactement comme leurs
// boutons individuels dans DeckCardDetailModal, Condition/Language/
// Finish réutilisent bulkSetDeckCardCondition/Language/Finish (plugin.ts,
// mêmes idiomes que Condition/Language/Finish côté collection), Export
// réutilise buildDeckCsvString (déjà doté des mêmes colonnes que My
// Collection). Deux boutons propres à My Decks, sans équivalent côté My
// Collection/My Wantlists : "Board" (Mainboard/Sideboard/Maybeboard —
// même 3 options que les onglets de board/le picker "Board" de
// DeckCardDetailModal, "Category" renommé le 2026-09-08) et "Function"
// (Ramp/Removal/etc., même picker que la boîte "Function" de ce même
// modale), demandés explicitement pour appliquer l'un ou l'autre à toute
// une sélection plutôt qu'une carte à la fois. Le bouton de suppression
// lit désormais "Delete" (comme My Collection/My Wantlists, renommé le
// 2026-09-08 pour gagner de la place) — la distinction de fond
// ("retirer du deck" ≠ "supprimer de la collection/wantlist") reste
// réelle, seul le libellé a changé (voir bulkRemoveDeckCards, qui ne
// touche jamais settings.collection/wantlist). Réutilise les mêmes
// classes CSS *et* les mêmes idiomes (pas de "…", carets sur les menus
// déroulants, Delete à deux étapes) que My Collection.

export function exportListCsv(this: MTGCollectionView, listId: string) {
	const list = this.plugin.settings.lists.find((l) => l.id === listId);
	const cards = this.plugin.settings.collection.filter((c) => c.listId === listId);
	const filename = `mtg-${(list?.name ?? "list").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
	this.downloadListCsv(cards, filename);
}

// Même format "qty - name" que listSelectionTxtLines plus bas, mais pour LA
// liste entière (ListSettingsModal, "Export"/"Copy to clipboard")
// plutôt que la sélection en cours — deux sous-ensembles différents de
// settings.collection, donc pas de réutilisation directe de
// listSelectionTxtLines possible ici.

export function listTxtLines(this: MTGCollectionView, listId: string): string {
	const cards = this.plugin.settings.collection.filter((c) => c.listId === listId);
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportListTxt(this: MTGCollectionView, listId: string) {
	const list = this.plugin.settings.lists.find((l) => l.id === listId);
	const filename = `mtg-${(list?.name ?? "list").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
	this.downloadTextFile(this.listTxtLines(listId), filename);
}

// navigator.clipboard.writeText : même précédent déjà établi (voir
// copyListSelectionTxt plus bas) — .catch() explicite plutôt qu'une
// résolution supposée systématique.

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

// Format simple, une carte par ligne : "3 - Lightning Bolt". Partagé entre
// l'export fichier (exportListSelectionTxt) et la copie presse-papier
// (copyListSelectionTxt) ci-dessous, pour que les deux restent identiques.

export function listSelectionTxtLines(this: MTGCollectionView): string {
	const cards = this.plugin.settings.collection.filter((c) => this.selectedListCardIds.has(c.id));
	return cards.map((c) => `${c.count} - ${c.name}`).join("\n");
}


export function exportListSelectionTxt(this: MTGCollectionView) {
	this.downloadTextFile(this.listSelectionTxtLines(), "mtg-selection.txt");
}

// navigator.clipboard.writeText n'est utilisé nulle part ailleurs dans ce
// plugin — surface API neuve ici, donc gérée avec un .catch() explicite
// (Notice d'échec) plutôt que supposée toujours réussir.

export function copyListSelectionTxt(this: MTGCollectionView) {
	const count = this.selectedListCardIds.size;
	navigator.clipboard
		.writeText(this.listSelectionTxtLines())
		.then(() => new Notice(`Copied ${count} card(s) to clipboard.`))
		.catch(() => new Notice("Could not copy to clipboard."));
}

// Construction pure (aucun effet de bord) du CSV — extraite de
// downloadListCsv pour être réutilisable telle quelle par downloadZip
// (chaque liste devient une entrée d'archive, voir renderListGalleryBulkActionsBar)
// sans dupliquer l'en-tête/les colonnes une seconde fois.

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

// Même format que buildListCsvString, sans Language/Condition (une carte de
// wantlist n'est pas encore possédée) — "Wantlist" plutôt que "List"
// comme dernière colonne.

export function listGroupsToTxtLines(this: MTGCollectionView, groups: ListGroup[]): string {
	return groups
		.map((g) => `# ${g.name}\n` + g.cards.map((c) => `${c.count} - ${c.name}`).join("\n"))
		.join("\n\n");
}

// Même principe que listGroupsToTxtLines ci-dessus, côté wantlist.

export function triggerImportIntoList(this: MTGCollectionView, listId: string) {
	this.triggerImportCollection(listId);
}

// "Import TXT" de ListSettingsModal — lit un .txt de decklist externe (Moxfield/Archidekt/texte brut) et passe par
// plugin.importDecklistToList (parseDecklistText + résolution Scryfall) plutôt que par le parseur CSV dédié ;
// le flux fichier/progression/résumé est celui de file-import.ts.

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
	// Toute sélection au niveau de la grille (MergeListsModal, etc.) n'a
	// plus de sens une fois qu'on navigue vers une liste précise — sans
	// ceci, revenir ensuite à la grille pouvait laisser le mode sélection
	// actif avec des ids de listes désormais fusionnées/supprimées encore
	// dans la sélection.
	this.selectedListIds.clear();
	this.listGallerySelectMode = false;
	this.render();
}


export function closeListIfOpen(this: MTGCollectionView, listId: string) {
	if (this.openListId === listId) this.openListId = null;
	this.render();
}

