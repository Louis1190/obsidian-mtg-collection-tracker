import { App, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { ListIcon } from "../core/data-model";
import { CollectionCard, WantlistCard } from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { CopyCardModal } from "./copy-card-modal";

/* -------------------------------------------------------------------------- */
/* Building blocks of the main screen of the settings modals */
/* (List/Wantlist/Deck/InboxSettingsModal) */
/* -------------------------------------------------------------------------- */
// The four modals built their main screen with the same copied building blocks: name field, "Display settings"
// section, "icon + label" buttons, Export/Import menus, Copy/Move, Merge duplicates, "Save and close" row. They
// are here only once; each modal assembles them in order and with the callbacks of ITS section (what remains
// specific to each: the deck's Format field, a deck's direct copy, the layout in rows or in a single grid, what
// "Save" does). The sub-screens (confirmation, merge, cover, icon) are in entity-settings-screens.ts.

// "Name" field — just the field, no inline "Save" button: Save lives at the very bottom of the window
// (explicitly requested), a single button for what needs to be "saved" rather than triggered immediately
// (Copy/Move/Export/Import/Delete all act on click, with no validation step).
export function renderNameField(contentEl: HTMLElement, label: string, value: string): HTMLInputElement {
	const nameField = contentEl.createDiv({ cls: "mtg-search-field" });
	nameField.createEl("label", { text: label });
	const nameInput = nameField.createEl("input", { type: "text", cls: "mtg-name-input" });
	nameInput.value = value;
	// The cursor landed here by itself on opening (reported bug) — nothing in these modals calls .focus() on this
	// field, it's Obsidian itself that seems to focus the first form field of a modal after onOpen() returns.
	// setTimeout(0) (a real macrotask, guaranteed to run after that automatic focus, whatever its own exact
	// timing) rather than a simple synchronous call, which would get overwritten by that focus if it occurs after
	// this point of draw().
	window.setTimeout(() => nameInput.blur(), 0);
	return nameInput;
}

// Discreet title separating the rows of buttons ("Display settings", "Actions") — explicitly requested, in
// place of the <hr> that separated them before.
export function addSectionTitle(contentEl: HTMLElement, text: string) {
	contentEl.createDiv({ cls: "mtg-list-actions-section-title", text });
}

// "Classic" row of actions: 3 buttons of equal width (mtg-list-actions-action-row, flex:1). Suitable when the
// number of buttons is a multiple of 3 (List/Wantlist: 3 rows of 3).
export function createActionRow(contentEl: HTMLElement): HTMLElement {
	return contentEl.createDiv({
		cls: "mtg-svg-btn-row mtg-list-actions-action-row mtg-list-actions-tight-row",
	});
}

// SINGLE container for all the action buttons (mtg-list-actions-wrap-row, a grid with 3 fixed columns):
// automatic placement fills a row of 3 before moving to the next CONTINUOUSLY across all the buttons — only
// the very LAST row can stay incomplete (3-3-2), never a row in the middle. Used when the number of buttons is
// not a multiple of 3 (Deck: 8, Inbox: 7), so as not to leave a clearly visible empty cell in the middle of a
// row that is too short.
export function createWrapRow(contentEl: HTMLElement): HTMLElement {
	return contentEl.createDiv({
		cls: "mtg-svg-btn-row mtg-list-actions-wrap-row mtg-list-actions-tight-row",
	});
}

// "Pictogram + label" action button. `danger` gives it the delete color (.mtg-remove-btn), whose CSS rule
// also cancels align-self/font-size, originally designed for the Yes/No duo of a confirmation screen: in a
// row of actions it must stretch and grow exactly like its neighbors.
export function addActionButton(
	row: HTMLElement,
	a: { icon: string; label: string; danger?: boolean; onClick: () => void }
): HTMLButtonElement {
	const btn = row.createEl("button", { cls: "mtg-btn-with-icon" + (a.danger ? " mtg-remove-btn" : "") });
	setIcon(btn.createSpan(), a.icon);
	btn.createSpan({ text: a.label });
	btn.addEventListener("click", a.onClick);
	return btn;
}

// Button with a small dropdown arrow (Export / Import) offering a menu (CSV vs TXT): same recipe as the "Export
// CSV"/"TXT" of a grid's bulk-actions bar — the whole button is clickable, not only the arrow, and
// mtg-bulk-picker-menu for the accent hover already established on these menus. mtg-btn-with-icon-dropdown:
// icon+label grouped and centered as a whole (mtg-btn-with-icon-dropdown-label), the arrow pushed to the right —
// same recipe of an empty column on the left to visually balance the arrow (grid-template-columns: 1em 1fr auto,
// see the comment of this rule in styles.css).
function addDropdownButton(
	row: HTMLElement,
	d: { icon: string; label: string; items: { label: string; onSelect: () => void }[] }
) {
	const btn = row.createEl("button", { cls: "mtg-btn-with-icon mtg-btn-with-icon-dropdown" });
	const labelWrap = btn.createSpan({ cls: "mtg-btn-with-icon-dropdown-label" });
	setIcon(labelWrap.createSpan(), d.icon);
	labelWrap.createSpan({ text: d.label });
	setIcon(btn.createSpan({ cls: "mtg-btn-with-icon-caret" }), "chevron-down");
	btn.addEventListener("click", () => {
		openPickerMenu(
			btn,
			d.items.map((item) => ({
				render: (el) => el.createSpan({ text: item.label }),
				onSelect: item.onSelect,
			})),
			{ menuClass: "mtg-bulk-picker-menu" }
		);
	});
}

// Export (CSV/TXT) / Copy to clipboard / Import (CSV/TXT). An import first closes the window (`close`): the
// file picker that follows belongs to the view, not to this modal.
export function addIoButtons(
	row: HTMLElement,
	io: {
		close: () => void;
		exportCsv: () => void;
		exportTxt: () => void;
		copyTxt: () => void;
		importCsv: () => void;
		importTxt: () => void;
	}
) {
	addDropdownButton(row, {
		icon: "download",
		label: "Export",
		items: [
			{ label: "Export CSV", onSelect: io.exportCsv },
			{ label: "Export TXT", onSelect: io.exportTxt },
		],
	});
	addActionButton(row, { icon: "clipboard-copy", label: "Copy to clipboard", onClick: io.copyTxt });
	addDropdownButton(row, {
		icon: "upload",
		label: "Import",
		items: [
			{
				label: "Import CSV",
				onSelect: () => {
					io.close();
					io.importCsv();
				},
			},
			{
				label: "Import TXT",
				onSelect: () => {
					io.close();
					io.importTxt();
				},
			},
		],
	});
}

// "Merge duplicates" acts immediately, with no confirmation: it isn't destructive, only identical quantities
// are added together (same computation as "Merge duplicate cards"/mergeLists, just scoped to this single
// entity). `merge` calls the section's plugin method; `onMerged` refreshes the view.
export function addMergeDuplicatesButton(
	row: HTMLElement,
	m: { noun: string; merge: () => { merged: number; removed: number }; onMerged: () => void }
) {
	addActionButton(row, {
		icon: "combine",
		label: "Merge duplicates",
		onClick: () => {
			const { merged, removed } = m.merge();
			if (merged === 0) {
				new Notice(`No duplicate cards found in this ${m.noun}.`);
				return;
			}
			new Notice(`Merged ${merged} duplicate group(s) (${removed} card(s) removed).`);
			m.onMerged();
		},
	});
}

// Copy / Move of ALL the entity's cards: open the same CopyCardModal window ("Copy cards to"/"Move cards") as
// everywhere else in the plugin rather than their own dedicated UI — same destination tabs (list/deck/wantlist),
// same "+ New X", same search.
// - Copy stays open behind CopyCardModal (stacked), like the "Copy card to…" block of a card's detail panel: the
//   entity itself hasn't changed, nothing justifies closing this window.
// - Move: once all the cards have gone, the emptied entity no longer has a reason to exist (same behavior as the
//   former "Move all cards… then delete" flow); it is `afterMove` that checks this rather than assuming it, in
//   case `cards` was stale at the time of the click.
export function addCopyMoveButtons(
	row: HTMLElement,
	c: {
		app: App;
		plugin: MTGCollectionPlugin;
		noun: string;
		sourceKind: "collection" | "wantlist";
		// The cards currently in the entity (re-read on each click).
		cards: () => (CollectionCard | WantlistCard)[];
		afterCopy: () => void;
		afterMove: () => void;
	}
) {
	addActionButton(row, {
		icon: "copy",
		label: `Copy ${c.noun}`,
		onClick: () => {
			const cards = c.cards();
			if (cards.length === 0) {
				new Notice(`This ${c.noun} has no cards to copy.`);
				return;
			}
			new CopyCardModal(c.app, c.plugin, cards, c.sourceKind, c.afterCopy, "copy").open();
		},
	});
	addActionButton(row, {
		icon: "move",
		label: `Move ${c.noun}`,
		onClick: () => {
			const cards = c.cards();
			if (cards.length === 0) {
				new Notice(`This ${c.noun} has no cards to move.`);
				return;
			}
			new CopyCardModal(c.app, c.plugin, cards, c.sourceKind, c.afterMove, "move").open();
		},
	});
}

// "Display settings" section: cover + pictogram, grouped with the name (the three set how the entity is
// presented in its grid), before the more impactful rows of actions below. The icon button is in accent color +
// carries a small cross to remove the icon directly from here (without going back through the picker) when an
// icon is already chosen — explicitly requested. mtg-btn-with-icon-dropdown (already used by Export/Import)
// groups and centers icon+label as a whole in the 1em/1fr/auto grid, the cross taking the 3rd column (like the
// dropdowns' arrow) rather than its own margin-left:auto in a simple flex — it was the latter that shifted the
// icon+label group off the button's real center (reported bug). Applied ONLY when the cross exists: without it,
// the flex+justify-content:center inherited from the base rule already correctly centers the 2 only children, a
// 3-column grid whose 3rd would stay empty would on the contrary de-center the label.
export function renderDisplaySettings(
	contentEl: HTMLElement,
	d: {
		noun: string;
		icon: ListIcon | undefined;
		onChooseCover: () => void;
		onChooseIcon: () => void;
		// Removes the icon (the modal calls the right plugin method).
		removeIcon: () => void;
		// After the removal (the modal refreshes the view and redraws).
		onDone: () => void;
	}
) {
	addSectionTitle(contentEl, "Display settings");

	const coverRow = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-list-actions-action-row" });
	addActionButton(coverRow, { icon: "image", label: "Choose cover image", onClick: d.onChooseCover });

	const hasIcon = !!d.icon;
	const iconBtn = coverRow.createEl("button", {
		cls: "mtg-btn-with-icon" + (hasIcon ? " mtg-btn-with-icon-dropdown is-active" : ""),
	});
	const iconLabelWrap = hasIcon
		? iconBtn.createSpan({ cls: "mtg-btn-with-icon-dropdown-label" })
		: iconBtn;
	setIcon(iconLabelWrap.createSpan(), "tag");
	iconLabelWrap.createSpan({ text: "Choose icon" });
	if (hasIcon) {
		const removeIconBtn = iconBtn.createSpan({ cls: "mtg-btn-with-icon-remove" });
		setIcon(removeIconBtn, "x");
		removeIconBtn.setAttribute("title", "Remove icon");
		removeIconBtn.addEventListener("click", (evt) => {
			// Prevents this click from bubbling up to the parent button, which would open the picker in
			// addition to removing the icon.
			evt.stopPropagation();
			d.removeIcon();
			new Notice(`${d.noun.charAt(0).toUpperCase() + d.noun.slice(1)} icon removed.`);
			d.onDone();
		});
	}
	iconBtn.addEventListener("click", d.onChooseIcon);
}

// "Save and close" row at the very bottom of the window (explicitly requested), right-aligned like
// GradingModal.saveGrading (same .mtg-svg-btn-row + justify-content: flex-end recipe). `onSave` does what "Save"
// does for this section AND closes the window: no explicit view.render(), onClose() (called by close()) already
// takes care of it.
export function renderSaveRow(contentEl: HTMLElement, onSave: () => void) {
	const saveRow = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-list-actions-save-row" });
	const saveBtn = saveRow.createEl("button", { text: "Save and close", cls: "mtg-search-add-btn" });
	saveBtn.addEventListener("click", onSave);
}
