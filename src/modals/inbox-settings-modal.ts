import { Modal, App, Notice } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";
import type { MTGCollectionView } from "../view";
import { renderConfirmScreen } from "./entity-settings-screens";
import {
	addSectionTitle,
	createWrapRow,
	addActionButton,
	addIoButtons,
	addMergeDuplicatesButton,
	addCopyMoveButtons,
} from "./entity-settings-controls";

/* -------------------------------------------------------------------------- */
/*  Inbox settings modal ("...")                                              */
/* -------------------------------------------------------------------------- */
// System list "Inbox" (see CollectionList.isInbox/ensureInboxList,
// MTGCollectionView.renderListTile) — its own modal rather than one more
// branch in ListSettingsModal: explicitly requested ("not the 'List Settings'
// window... but 'Inbox settings'"). Modeled on ListSettingsModal (explicitly
// requested, "copy List settings") — same full-width button rows, same
// Copy/Move flow via CopyCardModal, same "Clear list?" confirmation screen,
// same Export/Copy to clipboard/Import row — MINUS two things, explicitly
// requested:
// - the "Display settings" section (Choose cover image / Choose icon);
// - the "Merge lists" action (Merge duplicates stays, only that action is
//   excluded).
// Two other exclusions do NOT come from the request but from the safeguard
// already established on the plugin side (deleteList/renameList, see their
// respective comments — "the UI already no longer shows... for Inbox"):
// neither the "List name" field (renameList silently no-ops on isInbox), nor
// "Delete list" (deleteList no-ops likewise) — showing them would suggest
// that a click does something while that safeguard would cancel it without
// saying so.
// With no field to "save", no "Save and close" row either: the round close
// cross (addModalCloseButton) is enough, each action here applies immediately
// on click, exactly as Copy/Move/Clear/Merge duplicates/Export/Import already
// do in ListSettingsModal itself.

export class InboxSettingsModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private listId: string;
	private confirmingClear = false;

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

		// Same full-format confirmation screen as ListSettingsModal (renderConfirmScreen) — Inbox can never be deleted,
		// but emptying it remains a valid action (clearList only touches settings.collection, never the list itself).
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

		contentEl.createEl("h2", { text: "Inbox settings" });

		addSectionTitle(contentEl, "Actions");

		// The 7 "Actions" buttons all live in ONE grid container (3-3-1) rather than 3 separate rows bounded to 3
		// cells (see createWrapRow): explicitly reported via screenshot ("I'd like the buttons to 'wrap' naturally").
		// No "Merge with another list" nor Delete/Rename/Display settings: Inbox is a deliberately reduced variant of
		// ListSettingsModal.
		const actionsRow = createWrapRow(contentEl);
		// Copy / Move: Inbox is a normal list for these two operations.
		addCopyMoveButtons(actionsRow, {
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
				// deleteList no-ops on Inbox (see its own safeguard, plugin.ts) — Inbox therefore stays in place
				// once emptied, exactly the behavior wanted here.
				if (this.plugin.settings.collection.every((c) => c.listId !== list.id)) {
					this.plugin.deleteList(list.id);
				}
				this.view.closeListIfOpen(list.id);
				this.close();
			},
		});
		addActionButton(actionsRow, {
			icon: "eraser",
			label: "Clear list",
			danger: true,
			onClick: () => {
				this.confirmingClear = true;
				this.draw();
			},
		});
		addMergeDuplicatesButton(actionsRow, {
			noun: "list",
			merge: () => this.plugin.mergeListDuplicates(list.id),
			onMerged: () => this.view.render(),
		});
		addIoButtons(actionsRow, {
			close: () => this.close(),
			exportCsv: () => this.view.exportListCsv(list.id),
			exportTxt: () => this.view.exportListTxt(list.id),
			copyTxt: () => this.view.copyListTxt(list.id),
			importCsv: () => this.view.triggerImportIntoList(list.id),
			importTxt: () => this.view.triggerImportTxtIntoList(list.id),
		});
	}

	onClose() {
		this.contentEl.empty();
		this.view.render();
	}
}
