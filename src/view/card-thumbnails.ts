import { isAlphaSet } from "../core/card-model";
import { applySvgColor, getRarityColor } from "../api/scryfall";
import { setIcon } from "obsidian";
import { computeCardTileRadius } from "../ui/card-detail-fx";
import type { MTGCollectionView } from "../view";
import { setSvgMarkup } from "../ui/svg-markup";

/* ---------------------------------------------------------------------------- */
/*  Vignettes de carte avec badge d'édition, aperçu au survol, rayon des coins en mode Card.*/
/* ---------------------------------------------------------------------------- */

// Affiche l'aperçu flottant au survol du NOM d'une carte, en mode Tableau
// uniquement (voir buildCollectionCardRow/buildDeckCardRow/buildWantlistCardRow, qui
// n'attachent les écouteurs mouseenter/mouseleave appelant ces deux
// méthodes que quand this.viewMode/deckViewMode/wantlistViewMode ===
// "table"). anchor est l'élément survolé (le <span>/<div> du nom lui-même,
// pas toute la cellule) — sert uniquement à calculer la position, jamais
// stocké. Pas d'aperçu pour une carte sans image connue (imageUrl vide,
// cas rare mais possible pour une entrée CSV importée sans round-trip
// Scryfall réussi).

export function showCardNamePreview(this: MTGCollectionView, anchor: HTMLElement, imageUrl: string) {
	if (!imageUrl) return;
	this.cardNamePreviewImgEl.src = imageUrl;
	const r = anchor.getBoundingClientRect();
	const margin = 12;
	const previewWidth = this.cardNamePreviewEl.offsetWidth || 220;
	const previewHeight = previewWidth * (680 / 488);
	// Par défaut à droite du nom survolé ; bascule à gauche si ça
	// déborderait du viewport à droite (fenêtre étroite, ou nom proche du
	// bord). Clampé ensuite des deux côtés au cas où NI la droite NI la
	// gauche ne suffiraient (fenêtre plus étroite que l'aperçu lui-même).
	let left = r.right + margin;
	if (left + previewWidth > window.innerWidth - margin) {
		left = r.left - previewWidth - margin;
	}
	left = Math.max(margin, Math.min(left, window.innerWidth - previewWidth - margin));
	const top = Math.max(margin, Math.min(r.top, window.innerHeight - previewHeight - margin));
	this.cardNamePreviewEl.style.left = `${left}px`;
	this.cardNamePreviewEl.style.top = `${top}px`;
	this.cardNamePreviewEl.addClass("is-visible");
}


export function hideCardNamePreview(this: MTGCollectionView) {
	this.cardNamePreviewEl.removeClass("is-visible");
}
// Voir le commentaire de computeCardTileRadius (card-detail-fx.ts) pour
// pourquoi la vue Carte n'observe PAS ses tuiles individuellement comme
// setupCardTilt le fait pour la fenêtre de détail. this.mainEl est
// persistant (jamais détruit/reconstruit, contrairement aux tuiles
// elles-mêmes ou à this.bodyEl) — un seul ResizeObserver posé une fois
// ici, pour toute la durée de vie de la vue, plutôt qu'un par tuile.

export function setupCardTileRadiusObserver(this: MTGCollectionView) {
	const observer = new ResizeObserver(() => this.updateCardTileRadius());
	observer.observe(this.mainEl);
}
// Échantillonne la largeur d'une tuile de vue Carte ACTUELLEMENT affichée
// (n'importe laquelle : les 4 colonnes de la grille ont toutes la même
// largeur, voir .mtg-collection-list-cards) et pose --mtg-card-tile-radius
// sur this.containerEl (également persistant) — hérité de là par toutes
// les tuiles affichées, sans qu'aucune d'elles n'ait besoin de le poser
// elle-même. Appelée (1) juste après l'échange atomique dans render(),
// où une tuile fraîchement construite est déjà attachée, et (2) depuis le
// ResizeObserver de setupCardTileRadiusObserver ci-dessus, à chaque
// redimensionnement du panneau. Aucune des deux ne dépend d'observer un
// nœud tuile individuel, qui s'est révélé peu fiable (voir
// computeCardTileRadius) : celui-ci est régulièrement recréé, réutilisé
// depuis le cache (cachedListRowElements) et redéplacé d'un rendu à
// l'autre, un terrain bien plus fragile pour un ResizeObserver que
// this.mainEl, qui ne bouge jamais. Sans tuile actuellement affichée
// (vue Liste/Grille/Tableau active, ou vue Carte sur une liste vide),
// ne fait rien — rien à mettre à jour.

export function updateCardTileRadius(this: MTGCollectionView) {
	const sampleWrap = this.containerEl.querySelector<HTMLElement>(".mtg-card-tile-thumb-shadow-wrap");
	if (!sampleWrap) return;
	const width = sampleWrap.getBoundingClientRect().width;
	if (!width) return;
	this.containerEl.style.setProperty("--mtg-card-tile-radius", `${computeCardTileRadius(width)}px`);
}
export function renderThumbWithBadge(this: MTGCollectionView, 
	container: HTMLElement,
	imageUrl: string,
	setCode: string,
	rarity: string,
	showFoilLook = false,
	// Carte pas encore possédée (deck contenant une carte issue d'une
	// wantlist) : un petit ruban en coin plutôt qu'un paramètre séparé par
	// appelant, pour rester générique et réutilisable ailleurs si besoin.
	wanted = false,
	// "tile" : vue Carte (voir buildCollectionCardTile/buildDeckCardTile/
	// buildWantlistCardTile) — la carte s'affiche en entier, pleine largeur
	// de la tuile, plutôt qu'en miniature fixe recadrée.
	variant: "row" | "tile" = "row",
	// Petit badge couronne en coin (My Decks uniquement, voir
	// isDeckCommander, data-model.ts) — ajouté en DERNIER paramètre plutôt
	// qu'entre wanted/variant pour ne casser aucun appel positionnel
	// existant (plusieurs passent déjà 7 arguments jusqu'à variant).
	isCommander = false
) {
	// Vue Carte : l'ombre portée demandée ("légère, diffuse, vers le bas")
	// doit vivre sur un ancêtre qui n'a PAS overflow:hidden — .mtg-thumb-wrap
	// (ci-dessous) en a besoin pour découper le halo foil/la bordure aux
	// coins arrondis (voir son propre commentaire), et un box-shadow posé
	// sur un élément qui se découpe lui-même en overflow:hidden est
	// silencieusement rogné, pas juste assombri. D'où ce conteneur
	// supplémentaire, purement décoratif (pas de fond, pas de clip),
	// uniquement en variante "tile".
	const shadowWrap =
		variant === "tile" ? container.createDiv({ cls: "mtg-card-tile-thumb-shadow-wrap" }) : container;
	// Radius responsive (--mtg-card-tile-radius) : PAS posé ici par-tuile —
	// voir updateCardTileRadius/setupCardTileRadiusObserver (même
	// fichier), et le commentaire de computeCardTileRadius
	// (card-detail-fx.ts), pour pourquoi un observer par tuile construite
	// ici (dans le clone détaché de render()) s'est révélé peu fiable en
	// vrai Obsidian malgré plusieurs correctifs successifs.
	// Alpha (Limited Edition Alpha) a un radius physique bien plus grand que
	// les autres éditions — même besoin qu'en vue Liste/Grille
	// (mtg-card-row-thumb-alpha), mais ici la MÊME classe modificatrice
	// (mtg-card-tile-alpha) doit s'ajouter aux TROIS éléments qui portent un
	// border-radius (le wrapper d'ombre, le wrap qui découpe, et l'image
	// elle-même) — un radius différent entre celui qui découpe et celui de
	// l'image découpée désynchroniserait leur apparence (voir styles.css).
	const isAlpha = variant === "tile" && isAlphaSet(setCode);
	const wrap = shadowWrap.createDiv({
		cls:
			variant === "tile"
				? `mtg-thumb-wrap mtg-thumb-wrap-tile${isAlpha ? " mtg-card-tile-alpha" : ""}`
				: "mtg-thumb-wrap",
	});
	if (isAlpha && shadowWrap !== container) shadowWrap.addClass("mtg-card-tile-alpha");
	const thumbCls =
		variant === "tile"
			? `mtg-card-tile-thumb${isAlpha ? " mtg-card-tile-alpha" : ""}`
			: isAlphaSet(setCode)
			  ? "mtg-card-row-thumb mtg-card-row-thumb-alpha"
			  : "mtg-card-row-thumb";
	if (imageUrl) {
		wrap.createEl("img", { cls: thumbCls, attr: { src: imageUrl, loading: "lazy" } });
	} else {
		wrap.createDiv({ cls: `${thumbCls} mtg-no-image` });
	}

	if (showFoilLook) {
		wrap.createDiv({ cls: "mtg-foil-overlay" });
	}

	if (wanted) {
		wrap.createDiv({ cls: "mtg-thumb-wanted-ribbon", text: "Wanted" });
	}

	// Coin haut-DROIT (haut-gauche déjà pris par le ruban "Wanted"
	// ci-dessus et le repère "souhaité" de My Wantlists, voir leur propre
	// commentaire dans styles.css — les deux peuvent en principe coexister
	// avec ce badge sur une carte de deck pas encore possédée) — voir
	// isDeckCommander (data-model.ts) : le Commander est une Function
	// depuis le 2026-09-07, pas une catégorie, donc identifié ici via un
	// badge sur la carte elle-même plutôt qu'un onglet/en-tête de groupe
	// dédié (scoping confirmé explicitement).
	if (isCommander) {
		setIcon(wrap.createDiv({ cls: "mtg-thumb-commander-badge" }), "crown");
	}

	// Le badge en coin (logo d'édition sur l'image même) fait double emploi
	// en vue Carte, où la ligne 1 sous l'image affiche déjà ce même logo
	// (voir buildCollectionCardTile/buildDeckCardTile/buildWantlistCardTile) —
	// supprimé pour cette seule variante, sur demande explicite. Les vues
	// Liste/Grille/Tableau n'ont, elles, aucun autre endroit où ce logo
	// apparaît : le badge y reste indispensable.
	if (variant !== "tile") {
		const badge = wrap.createDiv({ cls: "mtg-thumb-set-badge" });
		void this.plugin.getSetIconSvg(setCode).then((svg) => {
			if (!svg) {
				badge.remove();
				return;
			}
			setSvgMarkup(badge, svg);
			const svgEl = badge.querySelector("svg");
			if (svgEl) {
				svgEl.setAttribute("width", "13");
				svgEl.setAttribute("height", "13");
			}
			applySvgColor(badge, getRarityColor(rarity));
		});
	}

	return wrap;
}
