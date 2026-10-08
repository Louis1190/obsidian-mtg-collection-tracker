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
	// State of the icon picker (current choice, tab, deduplicated sets), see IconPickerState.
	private iconPicker = newIconPickerState();

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, listId: string) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.listId = listId;
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
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

		// Same full-format confirmation screen as "Delete list?" above (not the in-place Delete/Cancel swap of the
		// bulk-actions bar) — consistent with the other destructive action in this window. The entity itself is not
		// deleted, so no close*IfOpen/close() here, just a refresh.
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

		// Screen for choosing the 2nd entity (renderMergeTargetScreen, entity-settings-screens.ts); the merge itself
		// is delegated to MergeListsModal (merge-modals.ts).
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

		// "Choose cover image" screen (renderCoverPickerScreen, entity-settings-screens.ts).
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

		// "Choose icon" screen (renderIconPickerScreen, entity-settings-screens.ts); its state (current choice, tab,
		// deduplicated sets) lives in this.iconPicker to survive tab changes.
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

		// 3 rows of 3 full-width buttons (mtg-list-actions-action-row): Copy/Move/Delete, Clear/Merge
		// duplicates/Merge lists, Export/Copy to clipboard/Import. See entity-settings-controls.ts for what each
		// button does; here only what is specific to a list.
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
				// Checked rather than assumed: once all the cards have gone
				// (moveCollectionCardToList/moveCardToDeck/moveCollectionCardToWantlist remove them all from
				// settings.collection without exception), the emptied list no longer has a reason to exist.
				if (this.plugin.settings.collection.every((c) => c.listId !== list.id)) {
					this.plugin.deleteList(list.id);
				}
				// No explicit view.render() here: onClose() (called by close() below) already takes care of it.
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

		// Clear empties the list (keeps it, see clearList) via the same full-format confirmation screen as Delete;
		// Merge lists opens the pickingMergeTarget screen above, which delegates to MergeListsModal.
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

