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

// .modal-bg est un frère de .modal, pas un enfant, d'où containerEl plutôt
// que modalEl/contentEl pour le trouver.
function getModalBackdropEl(modal: Modal): HTMLElement | null {
	return modal.containerEl.querySelector<HTMLElement>(".modal-bg");
}

// À appeler en toute première ligne de onOpen(), avant tout autre
// this.modalEl.addClass(...) propre à la modale (largeur, masquage de la
// croix native, etc.) — l'ordre entre eux n'a pas d'importance, ce sont des
// classes indépendantes sur le même élément. La classe de base (mtg-modal-
// anim-frame) est ajoutée tout de suite ; mtg-modal-visible passe une frame
// plus tard (requestAnimationFrame) pour que la transition CSS ait un
// changement d'état réel à partir duquel s'animer — sans ce délai, la
// modale apparaîtrait déjà dans son état final dès sa première peinture,
// sans transition visible.
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

// À appeler depuis un override de close() : retire mtg-modal-visible pour
// rejouer la transition en sens inverse, puis attend sa durée (160ms) avant
// d'appeler le close() réel d'Obsidian (superClose) qui détache la modale —
// sans ce délai, le DOM disparaîtrait instantanément et la transition
// n'aurait jamais le temps de se voir.
export function closeModalAnimated(modal: Modal, superClose: () => void) {
	modal.modalEl.removeClass("mtg-modal-visible");
	getModalBackdropEl(modal)?.removeClass("mtg-modal-visible");
	window.setTimeout(superClose, 160);
}

// Croix ronde de fermeture partagée par toutes les modales du plugin (voir
// .mtg-card-detail-close-btn dans styles.css) — demandé explicitement pour
// que TOUTES les fenêtres modales aient "le bouton X correct et
// correctement placé", pas seulement les 5 qui l'avaient déjà chacune en
// dupliquant ce même code (CardDetailModal/DeckCardDetailModal/
// WantlistCardDetailModal/GradingModal/CopyCardModal). Toujours ancrée sur
// modalEl, jamais contentEl : modalEl est déjà position:relative par défaut
// dans Obsidian (c'est ce sur quoi sa propre croix native s'ancre aussi),
// donc ce bouton atterrit toujours au même endroit peu importe le padding
// propre au contentEl de chaque modale — voir l'historique de GradingModal
// dans CLAUDE.md pour le bug exact que cet ancrage évite. Ajoute aussi
// mtg-modal-hides-native-close (masque la croix native d'Obsidian) : les
// deux vont toujours ensemble ici, donc pas besoin de les découpler comme
// applyModalOpenAnimation/closeModalAnimated (qui eux s'appellent depuis
// deux endroits différents du cycle de vie d'une modale).
// À appeler une seule fois depuis onOpen() — PAS depuis un draw() rejoué
// plusieurs fois, qui empilerait un nouveau bouton à chaque appel puisque
// modalEl (contrairement à contentEl) n'est jamais vidé entre deux
// redessins. C'est exactement pourquoi CardDetailModal/DeckCardDetailModal/
// WantlistCardDetailModal n'utilisent PAS cette fonction : leur bouton vit
// dans contentEl (vidé à chaque draw()) plutôt que modalEl, parce qu'il
// doit être reconstruit à chaque navigation prev/next — un besoin réel,
// pas juste un choix historique, donc ces trois-là gardent leur propre
// code plutôt que d'être forcées dans ce pattern-ci.
export function addModalCloseButton(modal: Modal) {
	modal.modalEl.addClass("mtg-modal-hides-native-close");
	const closeBtn = modal.modalEl.createDiv({ cls: "mtg-card-detail-close-btn" });
	setIcon(closeBtn, "x");
	closeBtn.setAttribute("title", "Close");
	closeBtn.addEventListener("click", () => modal.close());
}
