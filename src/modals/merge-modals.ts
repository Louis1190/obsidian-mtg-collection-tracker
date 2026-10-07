import { Modal, App, Notice } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";
import type { MTGCollectionView } from "../view";

/* -------------------------------------------------------------------------- */
/*  Merge modals (lists / wantlists / decks)                                  */
/* -------------------------------------------------------------------------- */
// Fusionne plusieurs listes (My Collection), wantlists (My Wantlists) ou
// decks (My Decks) en une seule NOUVELLE entité contenant toutes leurs
// cartes, puis supprime les originales. Deux entrées : l'action groupée
// "Merge" du mode sélection d'une galerie (voir
// MTGCollectionView.listGallerySelectMode), et "Merge with another …"
// depuis la modale de réglages d'une entité (List/Wantlist/DeckSettingsModal).
// Demandé explicitement pour les listes : "on sélectionne les listes que
// l'on a envie de fusionner ensemble, cela crée une nouvelle liste avec
// toutes les cartes issues des listes à fusionner et supprime les listes qui
// ont été fusionnées".
//
// Un seul formulaire (nom pré-rempli + bouton) pour les trois : seul ce que
// décrit MergeKind change d'une entité à l'autre. Il reste sa propre classe
// (pas une extension de NewListModal/NewDeckModal/NewWantlistModal) puisque
// celles-ci sont câblées en dur sur plugin.createX, une action de MUTATION
// différente de la fusion. La modale ELLE-MÊME sert de confirmation (nom
// pré-rempli à relire/modifier, texte explicite sur ce qui va être supprimé)
// — pas de second palier "Confirm/Cancel" comme le bouton Delete de la barre
// d'actions groupées, même raisonnement déjà établi pour "Move to"/"Copy to"
// (CopyCardModal) : ouvrir toute une fenêtre à remplir/valider EST déjà la
// confirmation.

// Ce qui diffère d'un type d'entité à l'autre ; tout le reste (formulaire,
// flux, textes) est commun.
interface MergeKind {
	// Nom au singulier tel qu'affiché ("list", "wantlist", "deck") ; le pluriel
	// s'obtient en ajoutant "s".
	noun: string;
	// Les entités existantes (seuls id et nom comptent ici).
	entities: (plugin: MTGCollectionPlugin) => readonly { id: string; name: string }[];
	// Lance la fusion et renvoie l'entité créée.
	merge: (plugin: MTGCollectionPlugin, ids: string[], name: string) => { id: string; name: string };
	// Ouvre l'entité créée dans la vue.
	open: (view: MTGCollectionView, id: string) => void;
}

const LIST_KIND: MergeKind = {
	noun: "list",
	entities: (plugin) => plugin.settings.lists,
	merge: (plugin, ids, name) => plugin.mergeLists(ids, name),
	open: (view, id) => view.openList(id),
};

const WANTLIST_KIND: MergeKind = {
	noun: "wantlist",
	entities: (plugin) => plugin.settings.wantlists,
	merge: (plugin, ids, name) => plugin.mergeWantlists(ids, name),
	open: (view, id) => view.openWantlist(id),
};

const DECK_KIND: MergeKind = {
	noun: "deck",
	entities: (plugin) => plugin.settings.decks,
	merge: (plugin, ids, name) => plugin.mergeDecks(ids, name),
	open: (view, id) => view.openDeck(id),
};

class MergeEntitiesModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private kind: MergeKind;
	private ids: string[];
	private names: string[];

	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, ids: string[], kind: MergeKind) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.kind = kind;
		this.ids = ids;
		const entities = kind.entities(plugin);
		this.names = ids
			.map((id) => entities.find((e) => e.id === id)?.name)
			.filter((n): n is string => !!n);
	}

	onOpen() {
		const { noun } = this.kind;
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-new-deck-modal");
		this.contentEl.createEl("h2", { text: `Merge ${noun}s` });
		this.contentEl.createEl("p", {
			cls: "mtg-status",
			text: `This creates one new ${noun} with every card from "${this.names.join(
				'", "'
			)}", then deletes those ${this.names.length} original ${noun}s.`,
		});
		const input = this.contentEl.createEl("input", { type: "text", placeholder: `New ${noun} name` });
		// Nom par défaut proposé (concaténation des noms d'origine) — modifiable
		// avant de valider, même que si l'utilisateur préfère taper le sien de
		// zéro plutôt que d'éditer celui-ci.
		input.value = this.names.join(" + ");
		input.focus();
		input.select();

		const merge = () => {
			const name = input.value.trim();
			if (!name) return;
			const mergedCount = this.names.length;
			const merged = this.kind.merge(this.plugin, this.ids, name);
			new Notice(`Merged ${mergedCount} ${noun}(s) into "${merged.name}".`);
			this.close();
			this.kind.open(this.view, merged.id);
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") merge();
		});

		const mergeBtn = this.contentEl.createEl("button", { text: "Merge", cls: "mtg-search-add-btn" });
		mergeBtn.addEventListener("click", merge);
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class MergeListsModal extends MergeEntitiesModal {
	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, listIds: string[]) {
		super(app, plugin, view, listIds, LIST_KIND);
	}
}

export class MergeWantlistsModal extends MergeEntitiesModal {
	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, wantlistIds: string[]) {
		super(app, plugin, view, wantlistIds, WANTLIST_KIND);
	}
}

export class MergeDecksModal extends MergeEntitiesModal {
	constructor(app: App, plugin: MTGCollectionPlugin, view: MTGCollectionView, deckIds: string[]) {
		super(app, plugin, view, deckIds, DECK_KIND);
	}
}
