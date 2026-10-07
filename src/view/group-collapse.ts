import { CardViewMode } from "../core/card-sorting";
import { holdAtOffset, releaseOffset } from "../ui/flip";
import type { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/*  Repli/dépli animé des groupes de cartes (rangées, FLIP).                   */
/* ---------------------------------------------------------------------------- */

// Format "qty - name" (comme listSelectionTxtLines), avec un en-tête "# Nom"
// par liste quand plusieurs sont fusionnées — sans ça, un export combiné
// de plusieurs listes serait une liste plate sans indication de quelle
// carte vient d'où (le CSV combiné, lui, a déjà sa propre colonne "List"
// par ligne, voir buildListCsvString).

export function setRowCollapsed(this: MTGCollectionView, rowOuter: HTMLElement, collapsed: boolean) {
	// Utilisé uniquement en mode Tableau (voir toggleGroupRows pour
	// Liste/Grille, qui traite le groupe entier en une fois pour permettre
	// l'animation FLIP des voisins).
	const pending = this.tableFadeTimeouts.get(rowOuter);
	if (pending) window.clearTimeout(pending);

	if (collapsed) {
		rowOuter.addClass("mtg-row-fading");
		const timeoutId = window.setTimeout(() => {
			rowOuter.addClass("mtg-hidden");
			rowOuter.removeClass("mtg-row-fading");
			this.tableFadeTimeouts.delete(rowOuter);
		}, 150);
		this.tableFadeTimeouts.set(rowOuter, timeoutId);
	} else {
		rowOuter.removeClass("mtg-hidden");
		rowOuter.addClass("mtg-row-fading");
		window.requestAnimationFrame(() => {
			rowOuter.removeClass("mtg-row-fading");
		});
		this.tableFadeTimeouts.delete(rowOuter);
	}
}
// Replie/déplie TOUT un groupe (Liste/Grille) comme une seule opération,
// plutôt que ligne par ligne : la disparition/apparition de chaque carte
// utilise toujours transform/opacity (voir CSS), mais le décalage des
// groupes suivants est lissé via la technique FLIP (First-Last-Invert-
// Play) — voir flipListChange. En mode Tableau, pas de FLIP : chaque
// ligne garde son fondu individuel (setRowCollapsed).


export function toggleGroupRows(this: MTGCollectionView, 
	list: HTMLElement,
	headerEl: HTMLElement,
	rows: HTMLElement[],
	collapsed: boolean,
	viewMode: CardViewMode
) {
	if (viewMode === "table") {
		rows.forEach((r) => this.setRowCollapsed(r, collapsed));
		return;
	}

	const pending = this.groupCollapseTimeouts.get(headerEl);
	if (pending) window.clearTimeout(pending);

	if (collapsed) {
		// Mesure chaque ligne avant de la sortir du flux normal (position
		// absolue, figée à son emplacement exact) — les voisins peuvent
		// alors glisser IMMÉDIATEMENT (via flipListChange, ci-dessous),
		// pendant que la ligne continue de jouer sa propre disparition en
		// fondu par-dessus, sans plus faire attendre les autres. Sans ça,
		// les voisins ne bougeaient qu'une fois le fondu de la ligne déjà
		// terminé, créant un temps mort perceptible.
		const listRect = list.getBoundingClientRect();
		const rowRects = rows.map((r) => r.getBoundingClientRect());

		this.flipListChange(list, () => {
			rows.forEach((r, i) => {
				const rect = rowRects[i];
				// Position absolue figée à l'emplacement exact : la classe porte position/z-index, les trois
				// mesures passent en variables CSS (voir .mtg-row-detached, styles.css).
				r.setCssProps({
					"--mtg-row-top": `${rect.top - listRect.top}px`,
					"--mtg-row-left": `${rect.left - listRect.left}px`,
					"--mtg-row-width": `${rect.width}px`,
				});
				r.addClass("mtg-row-detached");
				r.addClass("mtg-row-collapsed");
			});
		});

		const timeoutId = window.setTimeout(() => {
			rows.forEach((r) => {
				r.addClass("mtg-hidden");
				r.removeClass("mtg-row-detached");
			});
			this.groupCollapseTimeouts.delete(headerEl);
		}, 300);
		this.groupCollapseTimeouts.set(headerEl, timeoutId);
	} else {
		rows.forEach((r) => r.removeClass("mtg-row-detached"));
		this.flipListChange(list, () => {
			rows.forEach((r) => r.removeClass("mtg-hidden"));
		});
		void list.offsetHeight;
		window.requestAnimationFrame(() => {
			rows.forEach((r) => r.removeClass("mtg-row-collapsed"));
		});
	}
}
// Technique FLIP : mesure la position de tout ce qui pourrait se déplacer
// AVANT le changement, applique le changement réel instantanément, puis
// compense visuellement l'écart avec un transform (immédiat, invisible),
// avant de le relâcher en douceur. Comme seul "transform" anime, aucun
// recalcul de mise en page n'a lieu pendant l'animation elle-même — les
// groupes suivants glissent donc en douceur, plutôt que de sauter d'un
// coup à la fin.

export function flipListChange(this: MTGCollectionView, list: HTMLElement, mutate: () => void) {
	const movables = Array.from(
		list.querySelectorAll<HTMLElement>(".mtg-card-row-outer, .mtg-group-header")
	).filter((el) => !el.hasClass("mtg-hidden"));
	const firstTops = movables.map((el) => el.getBoundingClientRect().top);

	mutate();

	const toAnimate: HTMLElement[] = [];
	movables.forEach((el, i) => {
		if (el.hasClass("mtg-hidden")) return;
		const deltaY = firstTops[i] - el.getBoundingClientRect().top;
		if (Math.abs(deltaY) < 1) return;
		holdAtOffset(el, deltaY);
		toAnimate.push(el);
	});

	if (toAnimate.length === 0) return;
	// Force le navigateur à "voir" la position décalée avant de relâcher,
	// sinon les deux changements risquent d'être fusionnés et l'animation
	// sautée.
	list.getBoundingClientRect();
	window.requestAnimationFrame(() => {
		toAnimate.forEach((el) => releaseOffset(el));
	});
}
