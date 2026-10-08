import { Modal, App, Notice } from "obsidian";
import { LEGALITY_SEARCH_FORMATS } from "../core/card-search";
import { resolveDeckCoverImage } from "../core/price";
import type MTGCollectionPlugin from "../plugin";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";
import type { MTGCollectionView } from "../view";
import { MergeDecksModal } from "./merge-modals";
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
	createWrapRow,
	addActionButton,
	addIoButtons,
	addMergeDuplicatesButton,
	renderDisplaySettings,
	renderSaveRow,
} from "./entity-settings-controls";

/* -------------------------------------------------------------------------- */
/*  Deck actions modal ("...")                                                */
/* -------------------------------------------------------------------------- */

export class DeckSettingsModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private deckId: string;
	private confirmingDelete = false;
	private confirmingClear = false;
	private pickingMergeTarget = false;
	private pickingCoverImage = false;
	private pickingIcon = false;
	// State of the icon picker (current choice, tab, deduplicated sets), see IconPickerState.
	private iconPicker = newIconPickerState();

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, deckId: string) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.deckId = deckId;
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

		const deck = this.plugin.settings.decks.find((d) => d.id === this.deckId);
		if (!deck) {
			this.close();
			return;
		}

		if (this.confirmingDelete) {
			renderConfirmScreen(contentEl, {
				title: "Delete deck?",
				message: `Are you sure you want to delete "${deck.name}"? This cannot be undone.`,
				confirmLabel: "Yes, delete",
				onConfirm: () => {
					this.plugin.deleteDeck(deck.id);
					this.view.closeDeckIfOpen(deck.id);
					this.close();
				},
				onCancel: () => {
					this.confirmingDelete = false;
					this.draw();
				},
			});
			return;
		}

		// Same full-format confirmation screen as "Delete deck?" above (not the in-place Delete/Cancel swap of the
		// bulk-actions bar) — consistent with the other destructive action in this window. The entity itself is not
		// deleted, so no close*IfOpen/close() here, just a refresh.
		if (this.confirmingClear) {
			const cardCount = deck.cards.length;
			renderConfirmScreen(contentEl, {
				title: "Clear deck?",
				message: `Are you sure you want to remove all ${cardCount} card(s) from "${deck.name}"? The deck itself will be kept. This cannot be undone.`,
				confirmLabel: "Yes, clear",
				onConfirm: () => {
					this.plugin.clearDeck(deck.id);
					new Notice(`Cleared "${deck.name}".`);
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
		// is delegated to MergeDecksModal (merge-modals.ts).
		if (this.pickingMergeTarget) {
			const otherDecks = this.plugin.settings.decks.filter((d) => d.id !== deck.id);
			renderMergeTargetScreen(contentEl, {
				noun: "deck",
				currentName: deck.name,
				candidates: otherDecks.map((d) => ({
					id: d.id,
					name: d.name,
					coverImage: resolveDeckCoverImage(d.cards, d.coverCardId),
					totalQty: d.cards.reduce((sum, c) => sum + c.count, 0),
				})),
				onChoose: (targetId) => {
					this.close();
					new MergeDecksModal(this.app, this.plugin, this.view, [deck.id, targetId]).open();
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
				noun: "deck",
				cards: [...deck.cards]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((c) => ({ key: c.scryfallId, name: c.name, artCropUrl: c.artCropUrl, imageUrl: c.imageUrl })),
				currentKey: deck.coverCardId,
				save: (key) => this.plugin.setDeckCoverCard(deck.id, key),
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
				noun: "deck",
				state: this.iconPicker,
				save: (icon) => this.plugin.setDeckIcon(deck.id, icon),
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

		contentEl.createEl("h2", { text: "Deck settings" });

		const nameInput = renderNameField(contentEl, "Deck name", deck.name);

		// Format — same LEGALITY_SEARCH_FORMATS list as NewDeckModal (see its own comment), editable afterwards rather
		// than frozen at creation. "None" at the top = no format chosen (Deck.format becomes undefined again via
		// setDeckFormat).
		const formatField = contentEl.createDiv({ cls: "mtg-search-field" });
		formatField.createEl("label", { text: "Format" });
		const formatSelect = formatField.createEl("select");
		formatSelect.createEl("option", { text: "None", value: "" });
		LEGALITY_SEARCH_FORMATS.forEach((f) => formatSelect.createEl("option", { text: f.label, value: f.key }));
		formatSelect.value = deck.format ?? "";

		renderDisplaySettings(contentEl, {
			noun: "deck",
			icon: deck.deckIcon,
			onChooseCover: () => {
				this.pickingCoverImage = true;
				this.draw();
			},
			onChooseIcon: () => {
				openIconPicker(this.iconPicker, deck.deckIcon);
				this.pickingIcon = true;
				this.draw();
			},
			removeIcon: () => this.plugin.setDeckIcon(deck.id, undefined),
			onDone: () => {
				this.view.render();
				this.draw();
			},
		});

		addSectionTitle(contentEl, "Actions");

		// The 8 "Actions" buttons all live in ONE grid container (3-3-2) rather than 3 separate rows: 8 is not a
		// multiple of 3, and the 2-button row left a clearly visible empty 3rd cell (explicitly reported,
		// screenshot) — see createWrapRow, and InboxSettingsModal, same recipe. No "Move deck", unlike
		// ListSettingsModal's "Move list": a deck lives in no container it could leave, unlike a list card which
		// can be reassigned.
		const actionsRow = createWrapRow(contentEl);
		addActionButton(actionsRow, {
			icon: "copy",
			label: "Copy deck",
			onClick: () => {
				const newDeck = this.plugin.copyDeck(deck.id);
				new Notice(`Copied to "${newDeck.name}".`);
				this.close();
				this.view.openDeck(newDeck.id);
			},
		});
		addActionButton(actionsRow, {
			icon: "trash-2",
			label: "Delete deck",
			danger: true,
			onClick: () => {
				this.confirmingDelete = true;
				this.draw();
			},
		});
		addActionButton(actionsRow, {
			icon: "eraser",
			label: "Clear deck",
			danger: true,
			onClick: () => {
				this.confirmingClear = true;
				this.draw();
			},
		});
		addMergeDuplicatesButton(actionsRow, {
			noun: "deck",
			merge: () => this.plugin.mergeDeckDuplicates(deck.id),
			onMerged: () => this.view.render(),
		});
		addActionButton(actionsRow, {
			icon: "git-merge",
			label: "Merge decks",
			onClick: () => {
				this.pickingMergeTarget = true;
				this.draw();
			},
		});
		addIoButtons(actionsRow, {
			close: () => this.close(),
			exportCsv: () => this.view.exportDeckCsv(deck.id),
			exportTxt: () => this.view.exportDeckTxt(deck.id),
			copyTxt: () => this.view.copyDeckTxt(deck.id),
			importCsv: () => this.view.triggerImportIntoDeck(deck.id),
			importTxt: () => this.view.triggerImportTxtIntoDeck(deck.id),
		});

		// Saves the name (if non-empty) AND the format together, then closes.
		renderSaveRow(contentEl, () => {
			const newName = nameInput.value.trim();
			if (newName) this.plugin.renameDeck(deck.id, newName);
			this.plugin.setDeckFormat(deck.id, formatSelect.value || undefined);
			new Notice("Deck settings saved.");
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
		this.view.render();
	}
}
