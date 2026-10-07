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
// Liste système "Inbox" (voir CollectionList.isInbox/ensureInboxList,
// MTGCollectionView.renderListTile) — sa propre modale plutôt qu'une branche
// de plus dans ListSettingsModal : demandé explicitement ("pas la fenêtre
// 'List Settings'... mais 'Inbox settings'"). Recalquée sur ListSettingsModal
// (demandé explicitement, "copier List settings") — mêmes rangées de
// boutons pleine largeur, même flux Copy/Move via CopyCardModal, même
// écran de confirmation "Clear list?", même rangée Export/Copy to
// clipboard/Import — MOINS deux choses, demandées explicitement :
//   - la section "Display settings" (Choose cover image / Choose icon) ;
//   - l'action "Merge lists" (Merge duplicates reste, seule cette action-là
//     est exclue).
// Deux autres exclusions ne viennent PAS de la demande mais du garde-fou
// déjà établi côté plugin (deleteList/renameList, voir leurs commentaires
// respectifs — "l'UI ne montre déjà plus... pour Inbox") : ni le champ
// "List name" (renameList no-ope silencieusement sur isInbox), ni "Delete
// list" (deleteList no-ope pareil) — les afficher laisserait croire qu'un
// clic fait quelque chose alors que ce garde-fou l'annulerait sans le dire.
// Sans champ à "sauvegarder", pas de rangée "Save and close" non plus : la
// croix ronde de fermeture (addModalCloseButton) suffit, chaque action ici
// s'applique immédiatement au clic, exactement comme Copy/Move/Clear/Merge
// duplicates/Export/Import le font déjà dans ListSettingsModal elle-même.

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

		// Même écran de confirmation plein-format que ListSettingsModal (renderConfirmScreen) — Inbox ne peut jamais être
		// supprimée, mais la vider reste une action valide (clearList ne touche que settings.collection, jamais la liste
		// elle-même).
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

		// Les 7 boutons « Actions » vivent tous dans UN SEUL conteneur en grille (3-3-1) plutôt que 3 rangées
		// séparées bornées à 3 cellules (voir createWrapRow) : signalé explicitement via capture d'écran (« j'aimerais
		// que les boutons se "wrap" naturellement »). Pas de « Merge with another list » ni de Delete/Rename/Display
		// settings : Inbox est une variante volontairement réduite de ListSettingsModal.
		const actionsRow = createWrapRow(contentEl);
		// Copy / Move : Inbox est une liste normale pour ces deux opérations.
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
				// deleteList no-ope sur Inbox (voir son propre garde-fou, plugin.ts) — Inbox reste donc en place une
				// fois vidée, exactement le comportement voulu ici.
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
