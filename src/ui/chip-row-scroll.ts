// La barre de puces (.mtg-filter-chip-row-inner) ne passe jamais à la ligne, sur aucune
// plateforme : elle défile horizontalement, sans scrollbar visible (styles.css, base de
// `.mtg-filter-chip-row-inner`). Téléphone d'abord (2026-10-02), puis bureau et iPad
// (2026-10-03, "partout pareil"). Deux conséquences, traitées ici :
//
// 1. Chaque reconstruction de la barre (renderChipFilter dans le clone détaché de
//    render(), renderSearchChipBar à chaque puce validée/retirée) la recrée à
//    scrollLeft = 0 : la saisie et le bouton "effacer", derniers enfants, seraient hors
//    champ dès que les puces débordent -> scrollChipRowToEnd.
// 2. Sans scrollbar, une souris à molette verticale n'a plus aucun moyen d'atteindre les
//    premières puces (le trackpad et le toucher défilent déjà en horizontal tout seuls)
//    -> la molette verticale est convertie en défilement horizontal.
//
// À appeler une fois la barre construite, qu'elle ait le focus ou non.
//
// Le fichier héberge aussi les briques génériques de la barre d'actions du mode
// Sélection (2026-10-03), qui défile de la même façon : la molette
// (setupWheelHorizontalScroll) et le fondu d'indice + la position mémorisée
// (setupFadingScrollRow) — composées dans createBulkActionsBar (view/shared-render-helpers.ts).
export function setupChipRowScroll(inner: HTMLElement) {
	setupWheelHorizontalScroll(inner);
	scrollChipRowToEnd(inner);
}

// Molette verticale -> défilement horizontal, pour toute rangée à scrollbar masquée.
// Aussi utilisée seule par la barre d'actions du mode Sélection (createBulkActionsBar,
// view/shared-render-helpers.ts), qui défile comme la barre de puces mais démarre à
// GAUCHE (compteur + "Select all" d'abord) : pas de scrollChipRowToEnd pour elle.
export function setupWheelHorizontalScroll(row: HTMLElement) {
	// `row` est recréé à chaque reconstruction : un seul écouteur par élément, jamais
	// cumulé. Non passif, sinon preventDefault() serait ignoré.
	row.addEventListener(
		"wheel",
		(evt) => {
			const max = row.scrollWidth - row.clientWidth;
			if (max <= 0) return;
			// Geste surtout horizontal (trackpad, molette inclinée) : le défilement natif
			// s'en charge déjà.
			if (Math.abs(evt.deltaX) >= Math.abs(evt.deltaY)) return;
			const next = Math.min(max, Math.max(0, row.scrollLeft + evt.deltaY));
			// Déjà au bout dans ce sens : on laisse la molette défiler la page au lieu de
			// la bloquer sur une barre qui ne peut plus bouger. Tolérance de 1px : sur un
			// écran à ratio fractionnaire `scrollLeft` vaut p.ex. 834.5 quand
			// scrollWidth - clientWidth (entiers arrondis) vaut 835 — un `===` croirait la
			// barre encore mobile et avalerait un cran de molette au bout.
			if (Math.abs(next - row.scrollLeft) < 1) return;
			row.scrollLeft = next;
			evt.preventDefault();
		},
		{ passive: false }
	);
}

// Distance (px) de l'extrémité sur laquelle le fondu monte de 0 à 100 % : à l'arrivée au
// bout de la rangée il s'éteint progressivement au lieu de disparaître d'un coup.
const FADE_RAMP_PX = 24;

// Recalcule le fondu d'une rangée défilante : `--mtg-row-fade-start`/`-end` valent 0 à 1
// (la part du fondu CSS réellement affichée, `.mtg-bulk-actions-scroll` dans styles.css) et
// `.is-scrollable` n'est posée que si la rangée déborde — sans elle, aucun mask-image du
// tout. Variables continues plutôt qu'une classe par côté (le motif de setupPanelScrollFade,
// card-detail-fx.ts) : une classe basculée au bout ferait "sauter" le dernier bouton de
// semi-estompé à net d'un coup. À rappeler quand le CONTENU change sans que la rangée
// change de taille ni ne défile (replaceInBulkBar) : ni l'écouteur de scroll ni le
// ResizeObserver de setupFadingScrollRow ne s'en aperçoivent alors.
export function refreshScrollRowFade(row: HTMLElement) {
	const max = row.scrollWidth - row.clientWidth;
	const scrollable = max > 1;
	row.toggleClass("is-scrollable", scrollable);
	const ratio = (distance: number) => (scrollable ? Math.min(1, Math.max(0, distance / FADE_RAMP_PX)) : 0);
	row.style.setProperty("--mtg-row-fade-start", String(ratio(row.scrollLeft)));
	row.style.setProperty("--mtg-row-fade-end", String(ratio(max - row.scrollLeft)));
}

// Rangée défilante à fondu d'indice, qui retrouve sa position après une reconstruction.
// `restoreLeft` : où remettre la rangée (la valeur mémorisée par `onScroll`) ; `onScroll`
// reçoit chaque nouvelle position — y compris celle de la restauration, déjà bornée par ce
// que la rangée peut réellement défiler.
// Une seule mécanique pour les deux : un ResizeObserver, dont le PREMIER rappel tombe dès
// que l'élément est dans le DOM et mis en page, avant la peinture — la rangée est
// construite dans le clone détaché de render() (scrollWidth = 0, un `scrollLeft` posé à ce
// moment-là ne tient pas), et aucun scintillement à gauche n'est visible. Il reste branché :
// un changement de largeur du panneau modifie ce qui déborde, donc le fondu. Pas de
// disconnect() explicite, même raisonnement que setupResponsiveRadius (card-detail-fx.ts) :
// la rangée est recréée à chaque rendu, l'ancienne et son observer deviennent éligibles au
// ramasse-miettes une fois détachées.
export function setupFadingScrollRow(row: HTMLElement, restoreLeft: number, onScroll: (left: number) => void) {
	row.addEventListener("scroll", () => {
		refreshScrollRowFade(row);
		onScroll(row.scrollLeft);
	});
	let restored = false;
	const observer = new ResizeObserver(() => {
		if (!restored) {
			restored = true;
			if (restoreLeft > 0) row.scrollLeft = restoreLeft;
		}
		refreshScrollRowFade(row);
	});
	observer.observe(row);
}

function scrollChipRowToEnd(inner: HTMLElement) {
	const toEnd = () => {
		inner.scrollLeft = inner.scrollWidth;
	};
	const settle = () => {
		toEnd();
		// Les icônes des puces (symbole de mana/d'édition) arrivent via une promesse
		// (getManaSymbolSvg/getSetIconSvg().then) et élargissent la rangée APRÈS ce
		// premier passage ; une micro-tâche, mise en file après ces .then, recale le
		// défilement avant la peinture. Un symbole encore jamais récupéré (réseau)
		// arrive trop tard pour ça : le prochain rendu — la frappe suivante — remet la
		// saisie en vue.
		queueMicrotask(toEnd);
	};
	if (inner.isConnected) {
		settle();
		return;
	}
	// Barre construite hors DOM (clone détaché de render()) : aucune mise en page,
	// scrollWidth vaut 0. Le premier rappel d'un ResizeObserver tombe dès que l'élément
	// est dans le DOM et a une taille, avant la peinture ; un seul passage suffit
	// (disconnect), pour ne pas lutter ensuite contre un défilement fait à la main.
	const observer = new ResizeObserver(() => {
		observer.disconnect();
		settle();
	});
	observer.observe(inner);
}
