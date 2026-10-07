import { App, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { ListIcon } from "../core/data-model";
import { CollectionCard, WantlistCard } from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { CopyCardModal } from "./copy-card-modal";

/* -------------------------------------------------------------------------- */
/*  Briques de l'écran principal des modales de réglages                      */
/*  (List/Wantlist/Deck/InboxSettingsModal)                                   */
/* -------------------------------------------------------------------------- */
// Les quatre modales construisaient leur écran principal avec les mêmes briques copiées : champ de nom, section
// « Display settings », boutons « icône + libellé », menus Export/Import, Copy/Move, Merge duplicates, ligne
// « Save and close ». Elles sont ici une seule fois ; chaque modale les assemble dans l'ordre et avec les
// callbacks de SA section (ce qui reste propre à chacune : le champ Format du deck, la copie directe d'un deck,
// la disposition en rangées ou en grille unique, ce que fait « Save »). Les sous-écrans (confirmation, fusion,
// couverture, icône) sont dans entity-settings-screens.ts.

// Champ « nom » — juste le champ, pas de bouton « Save » inline : Save vit tout en bas de la fenêtre (demandé
// explicitement), un seul bouton pour ce qui a besoin d'être « sauvegardé » plutôt que déclenché immédiatement
// (Copy/Move/Export/Import/Delete agissent tous sur clic, sans étape de validation).
export function renderNameField(contentEl: HTMLElement, label: string, value: string): HTMLInputElement {
	const nameField = contentEl.createDiv({ cls: "mtg-search-field" });
	nameField.createEl("label", { text: label });
	const nameInput = nameField.createEl("input", { type: "text", cls: "mtg-name-input" });
	nameInput.value = value;
	// Le curseur atterrissait ici tout seul à l'ouverture (bug signalé) — rien dans ces modales n'appelle .focus()
	// sur ce champ, c'est Obsidian lui-même qui semble focaliser le premier champ de formulaire d'une modale après
	// le retour de onOpen(). setTimeout(0) (une vraie macrotâche, garantie de s'exécuter après ce focus
	// automatique, quel que soit son propre timing exact) plutôt qu'un simple appel synchrone, qui se ferait
	// écraser par ce focus s'il intervient après ce point de draw().
	window.setTimeout(() => nameInput.blur(), 0);
	return nameInput;
}

// Titre discret séparant les rangées de boutons (« Display settings », « Actions ») — demandé explicitement,
// à la place des <hr> qui les séparaient auparavant.
export function addSectionTitle(contentEl: HTMLElement, text: string) {
	contentEl.createDiv({ cls: "mtg-list-actions-section-title", text });
}

// Rangée d'actions « classique » : 3 boutons de largeur égale (mtg-list-actions-action-row, flex:1). Convient
// quand le nombre de boutons est un multiple de 3 (List/Wantlist : 3 rangées de 3).
export function createActionRow(contentEl: HTMLElement): HTMLElement {
	return contentEl.createDiv({
		cls: "mtg-svg-btn-row mtg-list-actions-action-row mtg-list-actions-tight-row",
	});
}

// Conteneur UNIQUE pour tous les boutons d'actions (mtg-list-actions-wrap-row, un grid à 3 colonnes fixes) :
// le placement automatique remplit une ligne de 3 avant de passer à la suivante EN CONTINU à travers tous les
// boutons — seule la toute DERNIÈRE ligne peut rester incomplète (3-3-2), jamais une ligne au milieu. Utilisé
// quand le nombre de boutons n'est pas un multiple de 3 (Deck : 8, Inbox : 7), pour ne pas laisser une cellule
// vide bien visible au milieu d'une rangée trop courte.
export function createWrapRow(contentEl: HTMLElement): HTMLElement {
	return contentEl.createDiv({
		cls: "mtg-svg-btn-row mtg-list-actions-wrap-row mtg-list-actions-tight-row",
	});
}

// Bouton d'action « pictogramme + libellé ». `danger` lui donne la couleur de suppression (.mtg-remove-btn),
// dont la règle CSS annule aussi align-self/font-size, pensés à l'origine pour le duo Yes/No d'un écran de
// confirmation : dans une rangée d'actions il doit s'étirer et s'agrandir exactement comme ses voisins.
export function addActionButton(
	row: HTMLElement,
	a: { icon: string; label: string; danger?: boolean; onClick: () => void }
): HTMLButtonElement {
	const btn = row.createEl("button", { cls: "mtg-btn-with-icon" + (a.danger ? " mtg-remove-btn" : "") });
	setIcon(btn.createSpan(), a.icon);
	btn.createSpan({ text: a.label });
	btn.addEventListener("click", a.onClick);
	return btn;
}

// Bouton à petite flèche de dropdown (Export / Import) proposant un menu (CSV vs TXT) : même recette que le
// « Export CSV »/« TXT » de la barre d'actions groupées d'une grille — bouton entier cliquable, pas seulement la
// flèche, et mtg-bulk-picker-menu pour le survol accent déjà établi sur ces menus. mtg-btn-with-icon-dropdown :
// icône+libellé regroupés et centrés comme un tout (mtg-btn-with-icon-dropdown-label), la flèche poussée à
// droite — même recette de colonne vide à gauche pour équilibrer visuellement la flèche (grid-template-columns:
// 1em 1fr auto, voir le commentaire de cette règle dans styles.css).
function addDropdownButton(
	row: HTMLElement,
	d: { icon: string; label: string; items: { label: string; onSelect: () => void }[] }
) {
	const btn = row.createEl("button", { cls: "mtg-btn-with-icon mtg-btn-with-icon-dropdown" });
	const labelWrap = btn.createSpan({ cls: "mtg-btn-with-icon-dropdown-label" });
	setIcon(labelWrap.createSpan(), d.icon);
	labelWrap.createSpan({ text: d.label });
	setIcon(btn.createSpan({ cls: "mtg-btn-with-icon-caret" }), "chevron-down");
	btn.addEventListener("click", () => {
		openPickerMenu(
			btn,
			d.items.map((item) => ({
				render: (el) => el.createSpan({ text: item.label }),
				onSelect: item.onSelect,
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});
}

// Export (CSV/TXT) / Copy to clipboard / Import (CSV/TXT). Un import ferme d'abord la fenêtre (`close`) : le
// sélecteur de fichier qui suit appartient à la vue, pas à cette modale.
export function addIoButtons(
	row: HTMLElement,
	io: {
		close: () => void;
		exportCsv: () => void;
		exportTxt: () => void;
		copyTxt: () => void;
		importCsv: () => void;
		importTxt: () => void;
	}
) {
	addDropdownButton(row, {
		icon: "download",
		label: "Export",
		items: [
			{ label: "Export CSV", onSelect: io.exportCsv },
			{ label: "Export TXT", onSelect: io.exportTxt },
		],
	});
	addActionButton(row, { icon: "clipboard-copy", label: "Copy to clipboard", onClick: io.copyTxt });
	addDropdownButton(row, {
		icon: "upload",
		label: "Import",
		items: [
			{
				label: "Import CSV",
				onSelect: () => {
					io.close();
					io.importCsv();
				},
			},
			{
				label: "Import TXT",
				onSelect: () => {
					io.close();
					io.importTxt();
				},
			},
		],
	});
}

// « Merge duplicates » agit immédiatement, sans confirmation : ce n'est pas destructif, seules des quantités
// identiques sont additionnées (même calcul que « Merge duplicate cards »/mergeLists, juste scopé à cette seule
// entité). `merge` appelle la méthode du plugin de la section ; `onMerged` rafraîchit la vue.
export function addMergeDuplicatesButton(
	row: HTMLElement,
	m: { noun: string; merge: () => { merged: number; removed: number }; onMerged: () => void }
) {
	addActionButton(row, {
		icon: "combine",
		label: "Merge duplicates",
		onClick: () => {
			const { merged, removed } = m.merge();
			if (merged === 0) {
				new Notice(`No duplicate cards found in this ${m.noun}.`);
				return;
			}
			new Notice(`Merged ${merged} duplicate group(s) (${removed} card(s) removed).`);
			m.onMerged();
		},
	});
}

// Copy / Move de TOUTES les cartes de l'entité : ouvrent la même fenêtre CopyCardModal (« Copy cards to »/« Move
// cards ») que partout ailleurs dans le plugin plutôt que leur propre UI dédiée — mêmes onglets de destination
// (liste/deck/wantlist), même « + New X », même recherche.
//  - Copy reste ouverte derrière CopyCardModal (empilée), comme le bloc « Copy card to… » du panneau de détail
//    d'une carte : l'entité elle-même n'a pas changé, rien ne justifie de fermer cette fenêtre.
//  - Move : une fois toutes les cartes parties, l'entité vidée n'a plus de raison d'exister (même comportement que
//    l'ancien flux « Move all cards… then delete ») ; c'est `afterMove` qui le vérifie plutôt que de le supposer,
//    au cas où `cards` aurait été obsolète au moment du clic.
export function addCopyMoveButtons(
	row: HTMLElement,
	c: {
		app: App;
		plugin: MTGCollectionPlugin;
		noun: string;
		sourceKind: "collection" | "wantlist";
		// Les cartes actuellement dans l'entité (relues à chaque clic).
		cards: () => (CollectionCard | WantlistCard)[];
		afterCopy: () => void;
		afterMove: () => void;
	}
) {
	addActionButton(row, {
		icon: "copy",
		label: `Copy ${c.noun}`,
		onClick: () => {
			const cards = c.cards();
			if (cards.length === 0) {
				new Notice(`This ${c.noun} has no cards to copy.`);
				return;
			}
			new CopyCardModal(c.app, c.plugin, cards, c.sourceKind, c.afterCopy, "copy").open();
		},
	});
	addActionButton(row, {
		icon: "move",
		label: `Move ${c.noun}`,
		onClick: () => {
			const cards = c.cards();
			if (cards.length === 0) {
				new Notice(`This ${c.noun} has no cards to move.`);
				return;
			}
			new CopyCardModal(c.app, c.plugin, cards, c.sourceKind, c.afterMove, "move").open();
		},
	});
}

// Section « Display settings » : couverture + pictogramme, groupés avec le nom (les trois règlent la
// présentation de l'entité dans sa grille), avant les rangées d'actions plus impactantes en dessous.
// Le bouton d'icône est en couleur d'accent + porte une petite croix pour retirer l'icône directement d'ici (sans
// repasser par le sélecteur) quand une icône est déjà choisie — demandé explicitement. mtg-btn-with-icon-dropdown
// (déjà utilisée par Export/Import) regroupe et centre icône+libellé comme un tout dans la grille 1em/1fr/auto,
// la croix prenant la 3ᵉ colonne (comme la flèche des dropdowns) plutôt que son propre margin-left:auto dans un
// simple flex — c'est ce dernier qui décalait le groupe icône+libellé hors du centre réel du bouton (bug signalé).
// N'appliquée QUE quand la croix existe : sans elle, le flex+justify-content:center hérité de la règle de base
// centre déjà correctement les 2 seuls enfants, une grille à 3 colonnes dont la 3ᵉ resterait vide décentrerait au
// contraire le libellé.
export function renderDisplaySettings(
	contentEl: HTMLElement,
	d: {
		noun: string;
		icon: ListIcon | undefined;
		onChooseCover: () => void;
		onChooseIcon: () => void;
		// Retire l'icône (c'est la modale qui appelle la bonne méthode du plugin).
		removeIcon: () => void;
		// Après le retrait (la modale rafraîchit la vue et redessine).
		onDone: () => void;
	}
) {
	addSectionTitle(contentEl, "Display settings");

	const coverRow = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-list-actions-action-row" });
	addActionButton(coverRow, { icon: "image", label: "Choose cover image", onClick: d.onChooseCover });

	const hasIcon = !!d.icon;
	const iconBtn = coverRow.createEl("button", {
		cls: "mtg-btn-with-icon" + (hasIcon ? " mtg-btn-with-icon-dropdown is-active" : ""),
	});
	const iconLabelWrap = hasIcon
		? iconBtn.createSpan({ cls: "mtg-btn-with-icon-dropdown-label" })
		: iconBtn;
	setIcon(iconLabelWrap.createSpan(), "tag");
	iconLabelWrap.createSpan({ text: "Choose icon" });
	if (hasIcon) {
		const removeIconBtn = iconBtn.createSpan({ cls: "mtg-btn-with-icon-remove" });
		setIcon(removeIconBtn, "x");
		removeIconBtn.setAttribute("title", "Remove icon");
		removeIconBtn.addEventListener("click", (evt) => {
			// Empêche ce clic de remonter jusqu'au bouton parent, qui ouvrirait le sélecteur en plus de retirer
			// l'icône.
			evt.stopPropagation();
			d.removeIcon();
			new Notice(`${d.noun.charAt(0).toUpperCase() + d.noun.slice(1)} icon removed.`);
			d.onDone();
		});
	}
	iconBtn.addEventListener("click", d.onChooseIcon);
}

// Ligne « Save and close » tout en bas de la fenêtre (demandé explicitement), alignée à droite comme
// GradingModal.saveGrading (même recette .mtg-svg-btn-row + justify-content: flex-end). `onSave` fait ce que fait
// « Save » pour cette section ET ferme la fenêtre : pas de view.render() explicite, onClose() (appelé par close())
// s'en charge déjà.
export function renderSaveRow(contentEl: HTMLElement, onSave: () => void) {
	const saveRow = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-list-actions-save-row" });
	const saveBtn = saveRow.createEl("button", { text: "Save and close", cls: "mtg-search-add-btn" });
	saveBtn.addEventListener("click", onSave);
}
