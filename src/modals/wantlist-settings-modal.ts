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
// Recalquée sur ListSettingsModal (demandé explicitement, "peut être
// exactement comme List settings") — mêmes écrans/mêmes drapeaux
// (confirmingDelete/confirmingClear/pickingMergeTarget/pickingCoverImage/
// pickingIcon) et même état de sélecteur d'icône (iconPicker) ; les sous-écrans
// eux-mêmes sont COMMUNS aux trois modales de réglages (entity-settings-screens.ts),
// même section "Display settings" (Choose cover image/Choose icon — voir
// Wantlist.coverCardId/listIcon, data-model.ts, ajoutés pour l'occasion
// en miroir de CollectionList), mêmes 3 rangées d'actions pleine largeur
// (Copy/Move/Delete, Clear/Merge duplicates/Merge wantlists, Export/Copy to
// clipboard/Import), même "Save and close" tout en bas. Contrairement à
// InboxSettingsModal (une variante volontairement réduite de List settings,
// deux actions en moins) : ici AUCUNE exclusion, une wantlist ordinaire n'a
// ni le concept "Inbox" (donc pas de filtre isInbox dans la galerie de
// fusion) ni le garde-fou deleteList/renameList qui justifiait ces
// exclusions côté Inbox.

export class WantlistSettingsModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private wantlistId: string;
	private confirmingDelete = false;
	private confirmingClear = false;
	private pickingMergeTarget = false;
	private pickingCoverImage = false;
	private pickingIcon = false;
	// État du sélecteur d'icône (choix en cours, onglet, éditions dédupliquées), voir IconPickerState.
	private iconPicker = newIconPickerState();

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, wantlistId: string) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.wantlistId = wantlistId;
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

		// Même écran de confirmation plein-format que « Delete wantlist? » ci-dessus (pas le swap Delete/Cancel en place
		// de la barre d'actions groupées) — cohérent avec l'autre action destructive de cette fenêtre. L'entité
		// elle-même n'est pas supprimée, donc pas de close*IfOpen/close() ici, juste un rafraîchissement.
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

		// Écran de choix de la 2ᵉ entité (renderMergeTargetScreen, entity-settings-screens.ts) ; la fusion elle-même
		// est déléguée à MergeWantlistsModal (merge-modals.ts).
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

		// Écran « Choose cover image » (renderCoverPickerScreen, entity-settings-screens.ts).
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

		// Écran « Choose icon » (renderIconPickerScreen, entity-settings-screens.ts) ; son état (choix en cours, onglet,
		// éditions dédupliquées) vit dans this.iconPicker pour survivre aux changements d'onglet.
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

		// 3 rangées de 3 boutons pleine largeur (mtg-list-actions-action-row) : Copy/Move/Delete,
		// Clear/Merge duplicates/Merge wantlists, Export/Copy to clipboard/Import. Voir entity-settings-controls.ts pour
		// ce que fait chaque bouton ; ici seulement ce qui est propre à une wantlist.
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
				// Même comportement que l'ancien flux (« Move all cards… then delete this wantlist ») : voir le commentaire
				// équivalent de ListSettingsModal. Pas de view.render() explicite : onClose() s'en charge déjà.
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

		// Clear vide la wantlist (la garde, voir clearWantlist) via le même écran de confirmation plein-format que Delete ;
		// Merge wantlists ouvre l'écran pickingMergeTarget ci-dessus, qui délègue à MergeWantlistsModal.
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
