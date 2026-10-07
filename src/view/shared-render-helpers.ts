import { setIcon } from "obsidian";
import { formatCountTitle } from "../core/count-title";
import {
	renderLoadingDots,
} from "../ui/card-detail-fx";
import type { App } from "obsidian";
import type { MTGCollectionView } from "../view";

export function openPluginSettings(this: MTGCollectionView) {
	// API interne d'Obsidian (non typée officiellement) pour ouvrir directement
	// l'onglet de réglages de ce plugin.
	const app = this.app as App & { setting?: { open?: () => void; openTabById?: (id: string) => void } };
	app.setting?.open?.();
	app.setting?.openTabById?.(this.plugin.manifest.id);
}


// Champ de filtre reconstruit à chaque rendu (nécessaire pour être placé
// juste au-dessus de la barre Group by/Sort by), mais qui conserve le focus
// et la position du curseur d'une frappe à l'autre.
// Titre "Cards: …" en tête de la zone de défilement d'une liste/deck/wantlist
// ouvert(e) : "Cards: 95 cards" au repos, "Cards: 14 of 95 cards match" dès
// qu'un filtre est saisi — même titre (même classe) que "Lists"/"Decks"/
// "Wantlists" au-dessus des galeries (voir formatCountTitle), à la place de la
// ligne "x of y cards match" qui s'affichait sous la barre de recherche.
// Dans la zone de défilement et non dans l'en-tête sticky : au repos il ne dit
// rien que l'en-tête de titre ne dise déjà, et il ne doit pas rendre la
// partie fixe de la vue plus haute (voir "Open UI/UX follow-ups", CLAUDE.md).
//
// Compte des EXEMPLAIRES (somme des `count`), pas des entrées uniques : c'est
// le "N cards" de l'en-tête de la vue et des en-têtes de groupe ("38 unique ·
// 95 cards"). Un deck de 60 cartes doit afficher "Cards: 60 cards", pas son
// nombre d'entrées distinctes.
//
// `legalityPending` : un jeton "legal:" est actif mais au moins une carte de
// la liste ouverte n'a pas encore sa légalité en cache (voir
// MTGCollectionPlugin.bulkFetchLegalities, déclenché depuis renderListDetail) :
// sans cet indicateur, le compte affiché pendant le chargement paraîtrait
// juste "faux" (des cartes légales mais pas encore résolues comptées comme non-
// légales), plutôt que lisiblement "en cours".
export function renderCardsCountTitle(
	parent: HTMLElement,
	cards: { count: number }[],
	matchedCards: { count: number }[],
	filtering: boolean,
	legalityPending = false
) {
	const sumCount = (list: { count: number }[]) => list.reduce((s, c) => s + c.count, 0);
	const titleEl = parent.createDiv({
		cls: "mtg-list-grid-section-title",
		text: formatCountTitle("card", sumCount(matchedCards), sumCount(cards), filtering),
	});
	if (legalityPending) {
		const loadingWrap = titleEl.createSpan({ cls: "mtg-filter-legality-loading" });
		loadingWrap.createSpan({ text: "Fetching legality data" });
		renderLoadingDots(loadingWrap.createSpan({ cls: "mtg-filter-legality-loading-dots" }));
	}
}

// Rangée d'intitulés de colonnes en mode Tableau. Grâce au flux naturel de
// la grille CSS, ces cellules occupent simplement les N premières colonnes
// de la grille, avant que les lignes de cartes ne continuent le flux.

export function renderTableHeader(this: MTGCollectionView, list: HTMLElement, columns: string[]) {
	columns.forEach((label) => {
		const cell = list.createDiv({ cls: "mtg-table-header-cell", text: label });
		// "QTY" centré, "Price" aligné à droite (demandé explicitement,
		// les deux seuls intitulés concernés à l'origine) — voir
		// .mtg-table-header-cell-qty/-price, styles.css. "Legality"
		// (colonne Deck uniquement) suit le même traitement centré que QTY.
		if (label === "Qty") cell.addClass("mtg-table-header-cell-qty");
		if (label === "Price") cell.addClass("mtg-table-header-cell-price");
		if (label === "Legality") cell.addClass("mtg-table-header-cell-legality");
	});
}

export function isDetailViewOpen(this: MTGCollectionView): boolean {
	return (
		(this.activeSection === "collection" && !!this.openListId) ||
		(this.activeSection === "decks" && !!this.openDeckId) ||
		(this.activeSection === "wantlists" && !!this.openWantlistId)
	);
}

// L'élément qui défile RÉELLEMENT en ce moment — this.mainEl pour la
// grille d'ensemble, .mtg-detail-scroll-area (voir styles.css) une fois
// une liste/un deck/une wantlist ouvert(e), puisque ce dernier prend
// alors seul en charge le défilement (this.mainEl ne déborde plus jamais
// dans ce mode). Résolu à chaque appel plutôt que mis en cache : cette
// zone est reconstruite à chaque render(), contrairement à this.mainEl.

export function getActiveScrollEl(this: MTGCollectionView): HTMLElement {
	if (this.isDetailViewOpen()) {
		const scrollArea = this.bodyEl.querySelector<HTMLElement>(".mtg-detail-scroll-area");
		if (scrollArea) return scrollArea;
	}
	return this.mainEl;
}

// Logique déjà utilisée par le listener posé une fois sur this.mainEl
// dans onOpen() (bouton "Back to top" + masquage de l'aperçu de nom de
// carte) — reprise ici pour être rattachée fraîchement à
// .mtg-detail-scroll-area à chaque fois qu'elle est reconstruite (voir
// renderListDetail/renderDeckDetail/renderWantlistDetail) : cet élément
// n'est PAS persistant comme this.mainEl, donc pas de "un seul listener
// pour toute la durée de vie de la vue" possible ici — un nouveau
// listener à chaque render() plutôt qu'un retrait explicite de l'ancien,
// qui part de toute façon avec le nœud détaché (garbage collecté avec
// lui, sans fuite).

export function handleScrollAreaScroll(this: MTGCollectionView, scrollEl: HTMLElement) {
	this.backToTopBtn.toggleClass("is-visible", scrollEl.scrollTop > 400);
	this.hideCardNamePreview();
}

// Resynchronise l'icône/l'état actif d'un des 3 boutons "Select"
// persistants de la grille (listGallerySelectBtn/deckGallerySelectBtn/
// wantlistGallerySelectBtn) — contrairement à selectModeBtn (sélection de
// cartes, reconstruit à neuf à chaque render() puisqu'il vit dans le
// stickyHeader d'une liste ouverte), ces 3 boutons sont des éléments
// persistants (comme newListBtn) jamais recréés, donc leur icône doit
// être mise à jour explicitement ici plutôt que réappliquée par un
// createDiv/setIcon initial qui ne rejouerait qu'une fois.

export function syncGallerySelectBtn(this: MTGCollectionView, btn: HTMLElement, active: boolean, label: string) {
	btn.toggleClass("is-active", active);
	setIcon(btn, active ? "x" : "square-mouse-pointer");
	btn.setAttribute("title", active ? "Exit select mode" : label);
}

// Placé en fin de liste tant qu'il reste des cartes non encore rendues
// (voir sliceGroupsForRender) : dès qu'il approche du bas de la zone
// visible, on agrandit la limite de rendu et on relance un render()
// complet, qui inclut alors ce lot de plus. root: list.parentElement (et
// non le viewport ni this.mainEl) — depuis .mtg-detail-scroll-area (voir
// styles.css), c'est CETTE zone-là, parent direct de list, qui défile
// réellement ici, pas this.mainEl ; rootMargin déclenche le chargement un
// peu avant que la sentinelle soit visible, pour éviter tout à-coup
// perceptible pendant le défilement. La préservation de scrollTop après
// onLoadMore() (déclenche un render()) n'a plus besoin d'être refaite ici
// à la main — render() s'en charge désormais lui-même, génériquement,
// pour tout appelant (voir son propre commentaire sur preservedScrollTop).

export function renderLoadMoreSentinel(this: MTGCollectionView, list: HTMLElement, onLoadMore: () => void) {
	const sentinel = list.createDiv({ cls: "mtg-load-more-sentinel" });
	const root = list.parentElement ?? this.mainEl;
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0].isIntersecting) {
				observer.disconnect();
				onLoadMore();
			}
		},
		{ root, rootMargin: "600px" }
	);
	// list (et donc sentinel) est construit hors DOM à cet instant précis —
	// render() assemble tout dans un clone détaché avant de l'échanger d'un
	// coup avec l'ancien contenu (voir render()). Observer un nœud encore
	// détaché ne capte pas fiablement son intersection une fois attaché :
	// certains moteurs ne recalculent alors plus jamais l'état de la
	// sentinelle, et "Loading more…" reste affiché indéfiniment sans que
	// rien ne charge. On diffère donc l'appel à observe() au tick suivant,
	// une fois l'échange terminé et sentinel réellement dans le document.
	window.setTimeout(() => observer.observe(sentinel), 0);
}


