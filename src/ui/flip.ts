/* -------------------------------------------------------------------------- */
/*  Les deux gestes de la technique FLIP (First-Last-Invert-Play)             */
/* -------------------------------------------------------------------------- */

// Partagés par le repli des groupes de cartes (view/group-collapse.ts) et par l'historique de la fenêtre
// d'ajout (modals/add-cards-modal.ts), qui écrivaient chacun les mêmes affectations en ligne. Le principe :
// APRÈS le vrai changement de mise en page, on remet l'élément visuellement à sa place d'AVANT (holdAtOffset :
// pas de transition, décalage en Y), puis on le relâche (releaseOffset : transition sur transform seule) — il
// glisse alors vers sa vraie place. Seul "transform" anime, donc aucun recalcul de mise en page pendant le glissement.
//
// Les styles vivent dans styles.css (.mtg-flip-hold / .mtg-flip-play), plus dans des `el.style.…` (le répertoire des
// plug-ins les refuse). Un style en ligne battait toute règle de la feuille, et la ligne ou la tuile a déjà sa propre
// transition/transform (.mtg-card-row-outer, .mtg-row-collapsed…) : les deux classes sont donc écrites
// `:is(.classe, #identifiant)`, qui pèse comme un identifiant (voir .mtg-hidden) — sans !important, que le répertoire
// signale. Elles ne sont JAMAIS posées ensemble : ces deux fonctions retirent l'une avant d'ajouter l'autre.
//
// Comme avant, l'élément GARDE la classe de relâchement ensuite : sa transition reste « transform seule » (l'ancien
// code laissait de même `transition: transform …` en ligne, jamais retiré) — à ne pas « nettoyer » sans avoir regardé
// ce que ça change pour l'opacité et la marge des lignes qui se replient.

export function holdAtOffset(el: HTMLElement, deltaY: number): void {
	el.removeClass("mtg-flip-play");
	el.setCssProps({ "--mtg-flip-dy": `${deltaY}px` });
	el.addClass("mtg-flip-hold");
}

export function releaseOffset(el: HTMLElement): void {
	el.removeClass("mtg-flip-hold");
	el.addClass("mtg-flip-play");
}
