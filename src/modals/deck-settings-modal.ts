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
	// État du sélecteur d'icône (choix en cours, onglet, éditions dédupliquées), voir IconPickerState.
	private iconPicker = newIconPickerState();

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, deckId: string) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.deckId = deckId;
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

		// Même écran de confirmation plein-format que « Delete deck? » ci-dessus (pas le swap Delete/Cancel en place
		// de la barre d'actions groupées) — cohérent avec l'autre action destructive de cette fenêtre. L'entité
		// elle-même n'est pas supprimée, donc pas de close*IfOpen/close() ici, juste un rafraîchissement.
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

		// Écran de choix de la 2ᵉ entité (renderMergeTargetScreen, entity-settings-screens.ts) ; la fusion elle-même
		// est déléguée à MergeDecksModal (merge-modals.ts).
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

		// Écran « Choose cover image » (renderCoverPickerScreen, entity-settings-screens.ts).
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

		// Écran « Choose icon » (renderIconPickerScreen, entity-settings-screens.ts) ; son état (choix en cours, onglet,
		// éditions dédupliquées) vit dans this.iconPicker pour survivre aux changements d'onglet.
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

		// Format — même liste LEGALITY_SEARCH_FORMATS que NewDeckModal (voir son propre commentaire), modifiable après
		// coup plutôt que figé à la création. "None" en tête = pas de format choisi (Deck.format redevient undefined
		// via setDeckFormat).
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

		// Les 8 boutons « Actions » vivent tous dans UN SEUL conteneur en grille (3-3-2) plutôt que 3 rangées
		// séparées : 8 n'est pas un multiple de 3, et la rangée à 2 boutons laissait une 3ᵉ cellule vide bien
		// visible (signalé explicitement, capture d'écran) — voir createWrapRow, et InboxSettingsModal, même
		// recette. Pas de « Move deck », contrairement au « Move list » de ListSettingsModal : un deck ne vit dans
		// aucun conteneur qu'il pourrait quitter, contrairement à une carte de liste qui peut être réaffectée.
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

		// Sauvegarde le nom (si non vide) ET le format ensemble, puis ferme.
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
