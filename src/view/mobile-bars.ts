import { Platform } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
// NAMED export (not `import type MTGCollectionView from`, unlike plugin.ts) — see "Phase 5b" in CLAUDE.md:
// the wrong syntax makes `this` degrade to `any` and floods tsc with unrelated errors.
import type { MTGCollectionView } from "../view";
import { VIEW_TYPE_MTG_COLLECTION } from "../core/data-model";

export const HIDE_BARS_CLASS = "mtg-hide-obsidian-bars";

// Set on `contentEl` (never on <body>: so it cannot outlive the view) as long as one of the plugin's
// input fields has focus on phone, i.e. as long as the keyboard is on screen — see styles.css.
export const KEYBOARD_OPEN_CLASS = "mtg-keyboard-open";

// Wires up the bars ↔ active leaf sync. Called once from onOpen; no effect off phone (tablet/desktop:
// no floating bars).
export function setupMobileBars(this: MTGCollectionView) {
	if (!Platform.isPhone) return;

	this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.syncMobileBars(leaf)));
	// Whatever happens to the view (tab closed, plugin disabled), the bars must come back.
	this.register(() => document.body.removeClass(HIDE_BARS_CLASS));
	// A view restored at startup opens before the workspace knows which leaf is active: we resync once it is
	// ready (the direct call below covers the hot opening).
	this.app.workspace.onLayoutReady(() => this.syncMobileBars());
	this.syncMobileBars();

	// Virtual keyboard: Android already resizes the view (the content moves up a first time), but the
	// bottom reservations (floating navigation pill, system-gesture safety margin) stayed applied above
	// the keyboard, which nevertheless covers them — hence a big black gap (2026-10-01). Obsidian's
	// `--keyboard-height` doesn't move reliably here (0px measured in the emulator): the focus of an
	// input field is the safest signal. `focusout` is deferred by a tick so as not to flicker when focus
	// passes from one field to another.
	const isTextField = (el: EventTarget | null) =>
		el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
	const syncKeyboard = () => this.contentEl.toggleClass(KEYBOARD_OPEN_CLASS, isTextField(document.activeElement));
	this.registerDomEvent(this.contentEl, "focusin", syncKeyboard);
	this.registerDomEvent(this.contentEl, "focusout", () => window.setTimeout(syncKeyboard, 0));
}

// `leaf` = the leaf that became active (event); `undefined` = direct call (also used by setting-tab.ts
// right after changing the setting, to resync without waiting for a change of leaf — see its own
// comment).
export function syncMobileBars(this: MTGCollectionView, leaf?: WorkspaceLeaf | null) {
	if (!Platform.isPhone) return;

	const current = leaf === undefined ? this.app.workspace.getMostRecentLeaf() : leaf;
	if (current === this.leaf) {
		document.body.toggleClass(HIDE_BARS_CLASS, this.plugin.settings.hideObsidianMobileBars);
	} else if (current?.view.getViewType() !== VIEW_TYPE_MTG_COLLECTION) {
		// Another view is active: the bars come back, whatever the setting — it only applies inside
		// this plugin.
		document.body.removeClass(HIDE_BARS_CLASS);
	}
	// Otherwise ANOTHER view of the plugin became active (two plugin tabs): it is up to it to decide —
	// touching it here would depend on the order in which the two listeners fire.
}
