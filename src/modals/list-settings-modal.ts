import { App, Modal, Notice } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import type { MTGCollectionView } from "../view";
import { groupByList } from "../core/price";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import { MergeListsModal } from "./merge-modals";
import {
	renderConfirmScreen,
	renderMergeTargetScreen,
	renderCoverPickerScreen,
	renderIconPickerScreen,
	newIconPickerState,
	openIconPicker,
} from "./entity-settings-screens";
import {
	renderNameField,
	addSectionTitle,
	createActionRow,
	addActionButton,
	addIoButtons,
	addMergeDuplicatesButton,
	addCopyMoveButtons,
	renderDisplaySettings,
	renderSaveRow,
} from "./entity-settings-controls";

/* -------------------------------------------------------------------------- */
/*  List actions modal ("...")                                                */
/* -------------------------------------------------------------------------- */

export class ListSettingsModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private listId: string;
	private confirmingDelete = false;
	private confirmingClear = false;
	private pickingMergeTarget = false;
	private pickingCoverImage = false;
	private pickingIcon = false;
	// État du sélecteur d'icône (choix en cours, onglet, éditions dédupliquées), voir IconPickerState.
	private iconPicker = newIconPickerState();

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, listId: string) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.listId = listId;
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		this.draw();
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	draw() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mtg-list-actions-modal");

		const list = this.plugin.settings.lists.find((l) => l.id === this.listId);
		if (!list) {
			this.close();
			return;
		}

		if (this.confirmingDelete) {
			const cardCount = this.plugin.settings.collection.filter(
				(c) => c.listId === list.id
			).length;
			renderConfirmScreen(contentEl, {
				title: "Delete list?",
				message: `Are you sure you want to delete "${list.name}"? This will remove ${cardCount} card(s) from your collection. This cannot be undone.`,
				confirmLabel: "Yes, delete",
				onConfirm: () => {
					this.plugin.deleteList(list.id);
					this.view.closeListIfOpen(list.id);
					this.close();
				},
				onCancel: () => {
					this.confirmingDelete = false;
					this.draw();
				},
			});
			return;
		}

		// Même écran de confirmation plein-format que « Delete list? » ci-dessus (pas le swap Delete/Cancel en place
		// de la barre d'actions groupées) — cohérent avec l'autre action destructive de cette fenêtre. L'entité
		// elle-même n'est pas supprimée, donc pas de close*IfOpen/close() ici, juste un rafraîchissement.
		if (this.confirmingClear) {
			const cardCount = this.plugin.settings.collection.filter(
				(c) => c.listId === list.id
			).length;
			renderConfirmScreen(contentEl, {
				title: "Clear list?",
				message: `Are you sure you want to remove all ${cardCount} card(s) from "${list.name}"? The list itself will be kept. This cannot be undone.`,
				confirmLabel: "Yes, clear",
				onConfirm: () => {
					this.plugin.clearList(list.id);
					new Notice(`Cleared "${list.name}".`);
					this.confirmingClear = false;
					this.view.render();
					this.draw();
				},
				onCancel: () => {
					this.confirmingClear = false;
					this.draw();
				},
			});
			return;
		}

		// Écran de choix de la 2ᵉ entité (renderMergeTargetScreen, entity-settings-screens.ts) ; la fusion elle-même
		// est déléguée à MergeListsModal (merge-modals.ts).
		if (this.pickingMergeTarget) {
			const otherLists = this.plugin.settings.lists.filter((l) => l.id !== list.id && !l.isInbox);
			renderMergeTargetScreen(contentEl, {
				noun: "list",
				currentName: list.name,
				candidates: groupByList(otherLists, this.plugin.settings.collection, this.plugin.settings.priceCurrency),
				onChoose: (targetId) => {
					this.close();
					new MergeListsModal(this.app, this.plugin, this.view, [list.id, targetId]).open();
				},
				onCancel: () => {
					this.pickingMergeTarget = false;
					this.draw();
				},
			});
			return;
		}

		// Écran « Choose cover image » (renderCoverPickerScreen, entity-settings-screens.ts).
		if (this.pickingCoverImage) {
			renderCoverPickerScreen(contentEl, {
				noun: "list",
				cards: this.plugin.settings.collection
					.filter((c) => c.listId === list.id)
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((c) => ({ key: c.id, name: c.name, artCropUrl: c.artCropUrl, imageUrl: c.imageUrl })),
				currentKey: list.coverCardId,
				save: (key) => this.plugin.setListCoverCard(list.id, key),
				onDone: () => {
					this.pickingCoverImage = false;
					this.view.render();
					this.draw();
				},
				onCancel: () => {
					this.pickingCoverImage = false;
					this.draw();
				},
			});
			return;
		}

		// Écran « Choose icon » (renderIconPickerScreen, entity-settings-screens.ts) ; son état (choix en cours, onglet,
		// éditions dédupliquées) vit dans this.iconPicker pour survivre aux changements d'onglet.
		if (this.pickingIcon) {
			renderIconPickerScreen(contentEl, {
				plugin: this.plugin,
				noun: "list",
				state: this.iconPicker,
				save: (icon) => this.plugin.setListIcon(list.id, icon),
				onDone: () => {
					this.pickingIcon = false;
					this.view.render();
					this.draw();
				},
				onCancel: () => {
					this.pickingIcon = false;
					this.draw();
				},
			});
			return;
		}

		contentEl.createEl("h2", { text: "List settings" });

		const nameInput = renderNameField(contentEl, "List name", list.name);

		renderDisplaySettings(contentEl, {
			noun: "list",
			icon: list.listIcon,
			onChooseCover: () => {
				this.pickingCoverImage = true;
				this.draw();
			},
			onChooseIcon: () => {
				openIconPicker(this.iconPicker, list.listIcon);
				this.pickingIcon = true;
				this.draw();
			},
			removeIcon: () => this.plugin.setListIcon(list.id, undefined),
			onDone: () => {
				this.view.render();
				this.draw();
			},
		});

		addSectionTitle(contentEl, "Actions");

		// 3 rangées de 3 boutons pleine largeur (mtg-list-actions-action-row) : Copy/Move/Delete,
		// Clear/Merge duplicates/Merge lists, Export/Copy to clipboard/Import. Voir entity-settings-controls.ts pour
		// ce que fait chaque bouton ; ici seulement ce qui est propre à une liste.
		const copyMoveRow = createActionRow(contentEl);
		addCopyMoveButtons(copyMoveRow, {
			app: this.app,
			plugin: this.plugin,
			noun: "list",
			sourceKind: "collection",
			cards: () => this.plugin.settings.collection.filter((c) => c.listId === list.id),
			afterCopy: () => {
				this.view.render();
				this.draw();
			},
			afterMove: () => {
				// Vérifié plutôt que supposé : une fois toutes les cartes parties (moveCollectionCardToList/
				// moveCardToDeck/moveCollectionCardToWantlist les retirent toutes de settings.collection sans
				// exception), la liste vidée n'a plus de raison d'exister.
				if (this.plugin.settings.collection.every((c) => c.listId !== list.id)) {
					this.plugin.deleteList(list.id);
				}
				// Pas de view.render() explicite ici : onClose() (appelé par close() ci-dessous) s'en charge déjà.
				this.view.closeListIfOpen(list.id);
				this.close();
			},
		});
		addActionButton(copyMoveRow, {
			icon: "trash-2",
			label: "Delete list",
			danger: true,
			onClick: () => {
				this.confirmingDelete = true;
				this.draw();
			},
		});

		// Clear vide la liste (la garde, voir clearList) via le même écran de confirmation plein-format que Delete ;
		// Merge lists ouvre l'écran pickingMergeTarget ci-dessus, qui délègue à MergeListsModal.
		const clearMergeRow = createActionRow(contentEl);
		addActionButton(clearMergeRow, {
			icon: "eraser",
			label: "Clear list",
			danger: true,
			onClick: () => {
				this.confirmingClear = true;
				this.draw();
			},
		});
		addMergeDuplicatesButton(clearMergeRow, {
			noun: "list",
			merge: () => this.plugin.mergeListDuplicates(list.id),
			onMerged: () => this.view.render(),
		});
		addActionButton(clearMergeRow, {
			icon: "git-merge",
			label: "Merge lists",
			onClick: () => {
				this.pickingMergeTarget = true;
				this.draw();
			},
		});

		const ioRow = createActionRow(contentEl);
		addIoButtons(ioRow, {
			close: () => this.close(),
			exportCsv: () => this.view.exportListCsv(list.id),
			exportTxt: () => this.view.exportListTxt(list.id),
			copyTxt: () => this.view.copyListTxt(list.id),
			importCsv: () => this.view.triggerImportIntoList(list.id),
			importTxt: () => this.view.triggerImportTxtIntoList(list.id),
		});

		renderSaveRow(contentEl, () => {
			const newName = nameInput.value.trim();
			if (!newName) return;
			this.plugin.renameList(list.id, newName);
			new Notice("List renamed.");
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
		this.view.render();
	}
}

