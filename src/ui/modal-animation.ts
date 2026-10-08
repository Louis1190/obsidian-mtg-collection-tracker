import { setIcon } from "obsidian";
import type { Modal } from "obsidian";

/* -------------------------------------------------------------------------- */
/*  Shared modal chrome for every modal in this plugin: the open/close        */
/*  animation (fade + small zoom) and the round "X" close button — both       */
/*  extracted from what CardDetailModal/DeckCardDetailModal/                  */
/*  WantlistCardDetailModal/GradingModal/CopyCardModal each used to           */
/*  duplicate individually, so every modal looks and behaves exactly the      */
/*  same way and any future tuning only needs to happen in one place.         */
/* -------------------------------------------------------------------------- */

// .modal-bg is a sibling of .modal, not a child, hence containerEl rather
// than modalEl/contentEl to find it.
function getModalBackdropEl(modal: Modal): HTMLElement | null {
	return modal.containerEl.querySelector<HTMLElement>(".modal-bg");
}

// To be called as the very first line of onOpen(), before any other
// this.modalEl.addClass(...) specific to the modal (width, hiding the
// native cross, etc.) — the order between them doesn't matter, they are
// independent classes on the same element. The base class
// (mtg-modal-anim-frame) is added right away; mtg-modal-visible comes one
// frame later (requestAnimationFrame) so that the CSS transition has a real
// state change to animate from — without this delay, the modal would appear
// already in its final state from its first paint, with no visible
// transition.
export function applyModalOpenAnimation(modal: Modal) {
	modal.modalEl.addClass("mtg-modal-anim-frame");
	window.requestAnimationFrame(() => {
		modal.modalEl.addClass("mtg-modal-visible");
		const backdrop = getModalBackdropEl(modal);
		if (backdrop) {
			backdrop.addClass("mtg-card-detail-backdrop");
			window.requestAnimationFrame(() => backdrop.addClass("mtg-modal-visible"));
		}
	});
}

// To be called from an override of close(): removes mtg-modal-visible to replay
// the panel's transition in reverse, and sets mtg-modal-closing on the scrim
// (which is driven by a CSS animation, not a transition: see
// .mtg-card-detail-backdrop in styles.css), then waits for its duration (160ms)
// before calling Obsidian's real close() (superClose) which detaches the modal —
// without this delay, the DOM would disappear instantly and the transition would
// never have time to be seen.
export function closeModalAnimated(modal: Modal, superClose: () => void) {
	modal.modalEl.removeClass("mtg-modal-visible");
	const backdrop = getModalBackdropEl(modal);
	backdrop?.removeClass("mtg-modal-visible");
	backdrop?.addClass("mtg-modal-closing");
	window.setTimeout(superClose, 160);
}

// Round close cross shared by all the plugin's modals (see
// .mtg-card-detail-close-btn in styles.css) — explicitly requested so that
// ALL modal windows have "the correct X button, correctly placed", not only
// the 5 that already each had it by duplicating this same code
// (CardDetailModal/DeckCardDetailModal/WantlistCardDetailModal/GradingModal/CopyCardModal).
// Always anchored on modalEl, never contentEl: modalEl is already
// position:relative by default in Obsidian (that is also what its own
// native cross anchors on), so this button always lands in the same place
// regardless of the padding specific to each modal's contentEl — see the
// GradingModal history in CLAUDE.md for the exact bug this anchoring
// avoids. Also adds mtg-modal-hides-native-close (hides Obsidian's native
// cross): the two always go together here, so no need to decouple them like
// applyModalOpenAnimation/closeModalAnimated (which are called from two
// different places of a modal's lifecycle).
// To be called only once from onOpen() — NOT from a draw() replayed several
// times, which would stack a new button on each call since modalEl (unlike
// contentEl) is never emptied between two redraws. That is exactly why
// CardDetailModal/DeckCardDetailModal/WantlistCardDetailModal do NOT use
// this function: their button lives in contentEl (emptied on every draw())
// rather than modalEl, because it must be rebuilt on every prev/next
// navigation — a real need, not just a historical choice, so those three
// keep their own code rather than being forced into this pattern.
export function addModalCloseButton(modal: Modal) {
	modal.modalEl.addClass("mtg-modal-hides-native-close");
	const closeBtn = modal.modalEl.createDiv({ cls: "mtg-card-detail-close-btn" });
	setIcon(closeBtn, "x");
	closeBtn.setAttribute("title", "Close");
	closeBtn.addEventListener("click", () => modal.close());
}
