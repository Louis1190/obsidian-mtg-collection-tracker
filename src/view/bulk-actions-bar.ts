import { setupWheelHorizontalScroll, setupFadingScrollRow, refreshScrollRowFade } from "../ui/chip-row-scroll";
import type { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/*  Barres d'actions groupées : construction commune et remplacement de bouton sur place.*/
/* ---------------------------------------------------------------------------- */

// Barre d'actions du mode Sélection — les 6 variantes (cartes + galerie, My Collection/
// My Decks/My Wantlists) passent par ici plutôt que d'écrire chacune son `createDiv` :
// la barre ne passe jamais à la ligne, elle défile horizontalement sans scrollbar visible
// (styles.css, `.mtg-bulk-actions-scroll` — même principe que la barre de puces, voir
// ui/chip-row-scroll.ts), et la molette, le fondu d'indice et la position mémorisée
// doivent être branchés à chaque création.
//
// DEUX éléments : `.mtg-bulk-actions-bar` (enveloppe : bordure, fond, coins arrondis,
// marge, animation d'apparition) et `.mtg-bulk-actions-scroll` (celui qui défile, et celui
// que cette fonction RETOURNE — les appelants y ajoutent leurs boutons comme avant). Le
// fondu d'indice est un mask-image sur l'élément qui défile ; porté par l'enveloppe, il
// aurait aussi estompé la bordure et le fond aux extrémités, la barre perdant ses bouts.
//
// La barre est reconstruite à CHAQUE render() (chaque tap de sélection, chaque action
// appliquée) : sa position de défilement est mémorisée dans `view.bulkBarScrollLeft` (une
// entrée par `kind`, voir ce champ) et remise à la reconstruction. Elle repart de 0 (compteur + "Select all" en vue) à sa
// première apparition (`animate`, soit l'entrée dans le mode Sélection), pas à chaque rendu.

export type BulkBarKind = "list-cards" | "list-gallery" | "deck-cards" | "deck-gallery" | "wantlist-cards" | "wantlist-gallery";

export function createBulkActionsBar(
	view: MTGCollectionView,
	kind: BulkBarKind,
	container: HTMLElement,
	animate: boolean
): HTMLElement {
	const wrap = container.createDiv({
		cls: `mtg-bulk-actions-bar${animate ? " mtg-bulk-actions-bar-animate" : ""}`,
	});
	const bar = wrap.createDiv({ cls: "mtg-bulk-actions-scroll" });
	if (animate) view.bulkBarScrollLeft.delete(kind);
	setupWheelHorizontalScroll(bar);
	setupFadingScrollRow(bar, view.bulkBarScrollLeft.get(kind) ?? 0, (left) => {
		view.bulkBarScrollLeft.set(kind, left);
	});
	return bar;
}
// Remplace un bouton de la barre (Quantity -> champ + Cancel, Delete -> Delete rouge +
// Cancel) puis ramène le DERNIER nouvel élément dans le champ : ces éléments arrivent
// à droite de l'ancien, et la barre étant défilante, un Cancel/Confirm peut sinon se
// retrouver hors de l'écran sans que rien n'indique pourquoi rien ne se passe.
// `block: "nearest"` : jamais de défilement vertical, la barre étant déjà visible.
// Le fondu est rafraîchi à la main : le contenu a changé de largeur sans que la barre
// défile (déjà visible) ni ne change de taille, donc rien d'autre ne le recalcule.

export function replaceInBulkBar(oldEl: HTMLElement, ...newEls: HTMLElement[]) {
	const bar = oldEl.parentElement;
	oldEl.replaceWith(...newEls);
	newEls[newEls.length - 1]?.scrollIntoView({ block: "nearest", inline: "nearest" });
	if (bar) refreshScrollRowFade(bar);
}
