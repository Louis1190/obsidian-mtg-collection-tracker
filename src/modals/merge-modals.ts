import { Modal, App, Notice } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { applyModalOpenAnimation, addModalCloseButton, closeModalAnimated } from "../ui/modal-animation";
import type { MTGCollectionView } from "../view";

/* -------------------------------------------------------------------------- */
/*  Merge modals (lists / wantlists / decks)                                  */
/* -------------------------------------------------------------------------- */
// Merges several lists (My Collection), wantlists (My Wantlists) or decks (My
// Decks) into a single NEW entity containing all their cards, then deletes the
// originals. Two entry points: the grouped "Merge" action of a gallery's
// selection mode (see MTGCollectionView.listGallerySelectMode), and "Merge
// with another …" from an entity's settings modal
// (List/Wantlist/DeckSettingsModal). Explicitly requested for lists: "we
// select the lists we want to merge together, it creates a new list with all
// the cards from the lists to merge and deletes the lists that were merged".
//
// A single form (pre-filled name + button) for all three: only what MergeKind
// describes changes from one entity to another. It remains its own class (not
// an extension of NewListModal/NewDeckModal/NewWantlistModal) since those are
// hard-wired to plugin.createX, a MUTATION action different from the merge.
// The modal ITSELF serves as the confirmation (pre-filled name to
// re-read/modify, explicit text about what is going to be deleted) — no second
// "Confirm/Cancel" level like the Delete button of the bulk-actions bar, same
// reasoning already established for "Move to"/"Copy to" (CopyCardModal):
// opening a whole window to fill in/validate IS already the confirmation.

// What differs from one entity type to another; everything else (form,
// flow, texts) is common.
interface MergeKind {
	// Singular name as displayed ("list", "wantlist", "deck"); the plural is
	// obtained by adding "s".
	noun: string;
	// The existing entities (only id and name matter here).
	entities: (plugin: MTGCollectionPlugin) => readonly { id: string; name: string }[];
	// Launches the merge and returns the created entity.
	merge: (plugin: MTGCollectionPlugin, ids: string[], name: string) => { id: string; name: string };
	// Opens the created entity in the view.
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
		// Default name proposed (concatenation of the original names) — editable
		// before validating, same if the user prefers to type their own from
		// scratch rather than edit this one.
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
