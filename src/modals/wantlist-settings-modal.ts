import { Modal, App, Notice } from "obsidian";
import { groupByWantlist } from "../core/price";
import type MTGCollectionPlugin from "../plugin";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";
import type { MTGCollectionView } from "../view";
import { MergeWantlistsModal } from "./merge-modals";
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
/*  Wantlist actions modal ("...")                                            */
/* -------------------------------------------------------------------------- */
// Modeled on ListSettingsModal (explicitly requested, "can be exactly like List
// settings") — same screens/same flags
// (confirmingDelete/confirmingClear/pickingMergeTarget/pickingCoverImage/pickingIcon)
// and same icon-picker state (iconPicker); the sub-screens themselves are COMMON to
// the three settings modals (entity-settings-screens.ts), same "Display settings"
// section (Choose cover image/Choose icon — see Wantlist.coverCardId/listIcon,
// data-model.ts, added for the occasion as a mirror of CollectionList), same 3 rows
// of full-width actions (Copy/Move/Delete, Clear/Merge duplicates/Merge wantlists,
// Export/Copy to clipboard/Import), same "Save and close" at the very bottom. Unlike
// InboxSettingsModal (a deliberately reduced variant of List settings, two actions
// fewer): here NO exclusion, an ordinary wantlist has neither the "Inbox" concept
// (hence no isInbox filter in the merge gallery) nor the deleteList/renameList
// safeguard that justified those exclusions on the Inbox side.

export class WantlistSettingsModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private wantlistId: string;
	private confirmingDelete = false;
	private confirmingClear = false;
	private pickingMergeTarget = false;
	private pickingCoverImage = false;
	private pickingIcon = false;
	// State of the icon picker (current choice, tab, deduplicated sets), see IconPickerState.
	private iconPicker = newIconPickerState();

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, wantlistId: string) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.wantlistId = wantlistId;
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

		const wantlist = this.plugin.settings.wantlists.find((w) => w.id === this.wantlistId);
		if (!wantlist) {
			this.close();
			return;
		}

		if (this.confirmingDelete) {
			const cardCount = this.plugin.settings.wantlist.filter(
				(c) => c.listId === wantlist.id
			).length;
			renderConfirmScreen(contentEl, {
				title: "Delete wantlist?",
				message: `Are you sure you want to delete "${wantlist.name}"? This will remove ${cardCount} card(s) from your wantlists. This cannot be undone.`,
				confirmLabel: "Yes, delete",
				onConfirm: () => {
					this.plugin.deleteWantlist(wantlist.id);
					this.view.closeWantlistIfOpen(wantlist.id);
					this.close();
				},
				onCancel: () => {
					this.confirmingDelete = false;
					this.draw();
				},
			});
			return;
		}

		// Same full-format confirmation screen as "Delete wantlist?" above (not the in-place Delete/Cancel swap of the
		// bulk-actions bar) — consistent with the other destructive action in this window. The entity itself is not
		// deleted, so no close*IfOpen/close() here, just a refresh.
		if (this.confirmingClear) {
			const cardCount = this.plugin.settings.wantlist.filter(
				(c) => c.listId === wantlist.id
			).length;
			renderConfirmScreen(contentEl, {
				title: "Clear wantlist?",
				message: `Are you sure you want to remove all ${cardCount} card(s) from "${wantlist.name}"? The wantlist itself will be kept. This cannot be undone.`,
				confirmLabel: "Yes, clear",
				onConfirm: () => {
					this.plugin.clearWantlist(wantlist.id);
					new Notice(`Cleared "${wantlist.name}".`);
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
		// is delegated to MergeWantlistsModal (merge-modals.ts).
		if (this.pickingMergeTarget) {
			const otherWantlists = this.plugin.settings.wantlists.filter((w) => w.id !== wantlist.id);
			renderMergeTargetScreen(contentEl, {
				noun: "wantlist",
				currentName: wantlist.name,
				candidates: groupByWantlist(otherWantlists, this.plugin.settings.wantlist, this.plugin.settings.priceCurrency),
				onChoose: (targetId) => {
					this.close();
					new MergeWantlistsModal(this.app, this.plugin, this.view, [wantlist.id, targetId]).open();
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
				noun: "wantlist",
				cards: this.plugin.settings.wantlist
					.filter((c) => c.listId === wantlist.id)
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((c) => ({ key: c.id, name: c.name, artCropUrl: c.artCropUrl, imageUrl: c.imageUrl })),
				currentKey: wantlist.coverCardId,
				save: (key) => this.plugin.setWantlistCoverCard(wantlist.id, key),
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
				noun: "wantlist",
				state: this.iconPicker,
				save: (icon) => this.plugin.setWantlistIcon(wantlist.id, icon),
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

		contentEl.createEl("h2", { text: "Wantlist settings" });

		const nameInput = renderNameField(contentEl, "Wantlist name", wantlist.name);

		renderDisplaySettings(contentEl, {
			noun: "wantlist",
			icon: wantlist.listIcon,
			onChooseCover: () => {
				this.pickingCoverImage = true;
				this.draw();
			},
			onChooseIcon: () => {
				openIconPicker(this.iconPicker, wantlist.listIcon);
				this.pickingIcon = true;
				this.draw();
			},
			removeIcon: () => this.plugin.setWantlistIcon(wantlist.id, undefined),
			onDone: () => {
				this.view.render();
				this.draw();
			},
		});

		addSectionTitle(contentEl, "Actions");

		// 3 rows of 3 full-width buttons (mtg-list-actions-action-row): Copy/Move/Delete, Clear/Merge duplicates/Merge
		// wantlists, Export/Copy to clipboard/Import. See entity-settings-controls.ts for what each button does; here
		// only what is specific to a wantlist.
		const copyMoveRow = createActionRow(contentEl);
		addCopyMoveButtons(copyMoveRow, {
			app: this.app,
			plugin: this.plugin,
			noun: "wantlist",
			sourceKind: "wantlist",
			cards: () => this.plugin.settings.wantlist.filter((c) => c.listId === wantlist.id),
			afterCopy: () => {
				this.view.render();
				this.draw();
			},
			afterMove: () => {
				// Same behavior as the old flow ("Move all cards… then delete this wantlist"): see the equivalent comment
				// of ListSettingsModal. No explicit view.render(): onClose() already takes care of it.
				if (this.plugin.settings.wantlist.every((c) => c.listId !== wantlist.id)) {
					this.plugin.deleteWantlist(wantlist.id);
				}
				this.view.closeWantlistIfOpen(wantlist.id);
				this.close();
			},
		});
		addActionButton(copyMoveRow, {
			icon: "trash-2",
			label: "Delete wantlist",
			danger: true,
			onClick: () => {
				this.confirmingDelete = true;
				this.draw();
			},
		});

		// Clear empties the wantlist (keeps it, see clearWantlist) via the same full-format confirmation screen as
		// Delete; Merge wantlists opens the pickingMergeTarget screen above, which delegates to MergeWantlistsModal.
		const clearMergeRow = createActionRow(contentEl);
		addActionButton(clearMergeRow, {
			icon: "eraser",
			label: "Clear wantlist",
			danger: true,
			onClick: () => {
				this.confirmingClear = true;
				this.draw();
			},
		});
		addMergeDuplicatesButton(clearMergeRow, {
			noun: "wantlist",
			merge: () => this.plugin.mergeWantlistDuplicates(wantlist.id),
			onMerged: () => this.view.render(),
		});
		addActionButton(clearMergeRow, {
			icon: "git-merge",
			label: "Merge wantlists",
			onClick: () => {
				this.pickingMergeTarget = true;
				this.draw();
			},
		});

		const ioRow = createActionRow(contentEl);
		addIoButtons(ioRow, {
			close: () => this.close(),
			exportCsv: () => this.view.exportWantlistCsv(wantlist.id),
			exportTxt: () => this.view.exportWantlistTxt(wantlist.id),
			copyTxt: () => this.view.copyWantlistTxt(wantlist.id),
			importCsv: () => this.view.triggerImportIntoWantlist(wantlist.id),
			importTxt: () => this.view.triggerImportTxtIntoWantlist(wantlist.id),
		});

		renderSaveRow(contentEl, () => {
			const newName = nameInput.value.trim();
			if (!newName) return;
			this.plugin.renameWantlist(wantlist.id, newName);
			new Notice("Wantlist renamed.");
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
		this.view.render();
	}
}
