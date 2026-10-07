import { Platform } from "obsidian";
import { Finish } from "../core/card-model";
import { CardbaseDayChange, CardbaseFinish, CardbasePriceHistory, CardbasePricePoint, CardbaseVendor } from "../api/cardbase";
import { UsdEurRate, convertUsdEur } from "../api/frankfurter";
import { CardTextFace } from "../api/scryfall";
import { setSvgMarkup } from "./svg-markup";

// Ouvre une URL externe (colonnes cliquables de "Store Prices" : Card
// Kingdom/Mana Pool/TCGplayer — CardDetailModal/DeckCardDetailModal/
// WantlistCardDetailModal) en vérifiant d'abord le schéma. Ces URLs ne
// viennent jamais d'une saisie utilisateur, mais d'une réponse JSON d'une
// API tierce (card-kingdom.ts/manapool.ts/scryfall.ts purchase_uris) —
// aujourd'hui des partenaires de confiance, mais rien ne garantit qu'une
// réponse malformée/compromise ne contienne jamais autre chose qu'un vrai
// lien produit http(s). Défense en profondeur bon marché plutôt qu'un
// window.open(url) aveugle sur une chaîne d'origine externe.
export function openExternalUrl(url: string | null | undefined): void {
	if (!url || !/^https:\/\//i.test(url)) return;
	window.open(url, "_blank");
}

// Calque de fond flouté (art crop) + voile d'un modal de détail de carte,
// avec un fondu enchaîné entre deux illustrations lors de la navigation
// précédent/suivant plutôt qu'un fondu vers le noir puis vers la nouvelle
// image. Partagé par les trois modales de détail (Collection/Deck/Wantlist),
// qui reconstruisent tout leur contenu à chaque draw() : ce calque doit être
// explicitement préservé (voir clearSiblingsIn) pour que la transition en
// cours ne soit pas interrompue par la reconstruction du reste.
// Empile un nouveau calque par carte plutôt que de faire va-et-vient entre
// deux calques réutilisés : chaque calque ne fait jamais qu'une seule chose,
// une seule fois — apparaître en fondu — et n'est plus jamais retouché
// ensuite. Une version précédente réutilisait deux calques (dessus/dessous)
// et "rendait la main" de l'un à l'autre à la fin de chaque transition ; ce
// passage de relais (changer l'image du calque du dessous puis masquer celui
// du dessus, même sur la fin réelle de la transition CSS et une frame
// d'attente supplémentaire) restait perceptible comme un voile qui
// s'estompe puis réapparaît d'un coup. En empilant simplement les calques
// (le voile, lui, n'est créé qu'une fois et jamais touché), il n'y a plus
// aucune étape de "remise à zéro" susceptible de produire cet artefact.
export class BackgroundCrossfader {
	el: HTMLElement | null = null;
	private lastUrl: string | null = null;
	private token = 0;
	private layers: HTMLElement[] = [];
	// Les calques recouverts par un plus récent sont invisibles mais pas
	// gratuits (chacun porte un flou de 45px) : on n'en garde qu'un nombre
	// borné pour ne pas les laisser s'accumuler indéfiniment sur une session
	// où l'utilisateur parcourt beaucoup de cartes dans la même fenêtre.
	private static readonly MAX_LAYERS = 10;

	// Retire tous les enfants de `container` SAUF ce calque, pour que draw()
	// puisse reconstruire le reste du contenu (panneau, header…) sans détruire
	// le fond et sa transition en cours. Équivalent de contentEl.empty() qui
	// épargne ce seul élément.
	clearSiblingsIn(container: HTMLElement) {
		Array.from(container.children).forEach((child) => {
			if (child !== this.el) child.remove();
		});
	}

	update(container: HTMLElement, url: string) {
		const token = ++this.token;
		if (!this.el) {
			this.el = container.createDiv();
			container.prepend(this.el);
			// Le voile est créé une bonne fois pour toutes ici et n'est plus
			// jamais recréé ni modifié ensuite — son z-index (voir CSS) le
			// maintient au-dessus de tous les calques d'image ajoutés par la
			// suite, peu importe leur ordre d'insertion à eux.
			this.el.createDiv({ cls: "mtg-card-detail-scrim" });
		}

		if (url === this.lastUrl) return;
		this.lastUrl = url;

		const preload = new Image();
		preload.onload = () => {
			if (token !== this.token) return;
			const layer = this.el!.createDiv({ cls: "mtg-card-detail-bg" });
			layer.style.backgroundImage = `url("${url}")`;
			this.layers.push(layer);
			// Deux requestAnimationFrame imbriqués (même idiome que l'ouverture
			// du modal) pour garantir que le navigateur peint bien l'état
			// initial opacity:0 avant de déclencher la transition vers l'état
			// visible — sans quoi les deux changements peuvent être regroupés
			// dans la même frame et sauter la transition.
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					if (token !== this.token) return;
					layer.addClass("mtg-card-detail-bg-loaded");
				});
			});
			while (this.layers.length > BackgroundCrossfader.MAX_LAYERS) {
				this.layers.shift()!.remove();
			}
		};
		preload.src = url;
	}

	// Aucune image pour la carte affichée : retire tout plutôt que de laisser
	// une illustration obsolète visible.
	clear() {
		this.el?.remove();
		this.el = null;
		this.layers = [];
		this.lastUrl = null;
	}
}

// La colonne de droite du détail carte (.mtg-card-detail-panel) défile en
// interne plutôt que de laisser la fenêtre entière grandir avec le contenu
// (voir max-height sur .mtg-card-detail-modal). Le fondu haut/bas (mask-image
// en CSS, voir styles.css) n'est affiché que du côté où il reste vraiment du
// contenu caché — pas un dégradé permanent — d'où ce bascule de classes sur
// scroll plutôt qu'un mask statique.
export function setupPanelScrollFade(panel: HTMLElement) {
	const update = () => {
		const atTop = panel.scrollTop <= 0;
		const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
		panel.toggleClass("mtg-panel-fade-top", !atTop);
		panel.toggleClass("mtg-panel-fade-bottom", !atBottom);
	};
	panel.addEventListener("scroll", update);
	update();
}

// Rayon de coin responsive (--mtg-card-radius, consommée par
// .mtg-card-detail-tilt/.mtg-card-detail-image dans styles.css, plus la
// variante Alpha dérivée par calc()) — un radius fixe en px reste bien
// rond (contrairement à un %, qui se résout par axe et déforme en ovale
// sur une carte non carrée, voir la note historique de ces deux classes)
// mais ne rétrécissait pas avec la carte elle-même — retour explicite :
// "si ma fenêtre devient plus petite, le radius devient trop grand".
// RATIO calibré pour valoir exactement MAX à la largeur maximale réelle
// de la carte (~402px, une fois .mtg-card-detail-modal-frame plafonnée à
// 1100px de large — voir le calcul dans l'historique CLAUDE.md de ce
// changement) : aucun changement visible sur un écran normal/large, seule
// une fenêtre étroite voit désormais le radius rétrécir. MIN empêche la
// carte de devenir presque carrée sur un écran mobile très étroit.
// Bump explicite (2026-09-10) : "le radius ne semble pas assez important",
// à la fois ici et pour --mtg-card-tile-radius plus bas — MAX/MIN augmentés
// proportionnellement (14→20 / 6→8) en gardant la même largeur de référence
// (~402px, calcul ci-dessus inchangé) pour ne rien changer d'autre au
// mécanisme lui-même : sur un écran normal/large (déjà plafonné à MAX avant
// ce changement, comme documenté ci-dessus) c'est ce nouveau MAX qui se voit
// directement ; le ratio Alpha (*29/14, styles.css) s'applique à la valeur
// LIVE de --mtg-card-radius, donc l'Alpha grandit lui aussi proportionnellement
// sans avoir besoin d'être retouché séparément.
const CARD_RADIUS_RATIO = 0.05;
const CARD_RADIUS_MIN = 8;
const CARD_RADIUS_MAX = 20;

// Factorisé hors de setupCardTilt (qui reste le seul appelant) le jour où la
// vue Carte a eu besoin du même mécanisme pour son propre radius — voir
// computeCardTileRadius plus bas pour pourquoi la vue Carte n'utilise PAS
// cette fonction elle-même (elle a besoin d'observer un élément persistant
// plutôt qu'une tuile individuelle, pour des raisons propres à view.ts).
// ResizeObserver (pas un simple listener resize sur window) : se
// redéclenche pour toute cause de changement de taille (le conteneur
// change de largeur au redimensionnement du panneau, pas seulement de la
// fenêtre), et sert aussi de mesure initiale en se déclenchant
// immédiatement à l'observation. Pas de disconnect() explicite : `tilt`
// (le seul appelant) est toujours recréé à chaque draw() par ses
// appelants (jamais réutilisé), donc une fois l'ancien élément détaché
// sans autre référence, cet observer devient lui aussi éligible au
// ramasse-miettes — même raisonnement déjà appliqué aux écouteurs
// mousemove/mouseleave de setupCardTilt plus bas.
function setupResponsiveRadius(el: HTMLElement, ratio: number, min: number, max: number, cssVar: string) {
	const observer = new ResizeObserver((entries) => {
		const width = entries[0]?.contentRect.width;
		if (!width) return;
		const radius = Math.min(max, Math.max(min, width * ratio));
		el.style.setProperty(cssVar, `${radius}px`);
	});
	observer.observe(el);
}

const CARD_TILE_RADIUS_RATIO = 16 / 320;
const CARD_TILE_RADIUS_MIN = 5;
const CARD_TILE_RADIUS_MAX = 16;

export function computeCardTileRadius(width: number): number {
	return Math.min(CARD_TILE_RADIUS_MAX, Math.max(CARD_TILE_RADIUS_MIN, width * CARD_TILE_RADIUS_RATIO));
}

// Effet "holo" façon carte Pokémon (inclinaison 3D + reflet qui suit la
// souris), réservé aux finitions foil/etched — une carte "regular" ne
// scintille pas physiquement, elle ne le fait pas non plus ici.
// `anchor` (l'élément dont on lit la position de la souris) et `tilt`
// (l'élément qu'on incline réellement) sont volontairement deux éléments
// distincts : suivre la souris sur le MÊME élément qu'on transforme créerait
// une boucle de rétroaction (la boîte suivie bouge légèrement à chaque
// inclinaison, donc les coordonnées de la souris qu'on en déduit ensuite
// deviennent legèrement fausses). `anchor` reste également libre pour porter
// le transform du carrousel Cover Flow (animateCardNav) sans jamais entrer
// en conflit avec celui-ci, posé ici sur `tilt`, imbriqué à l'intérieur.
export function setupCardTilt(anchor: HTMLElement, tilt: HTMLElement) {
	// Mesure la largeur RÉELLEMENT RENDUE de `tilt` (voir setupResponsiveRadius
	// plus haut) — sans rapport avec l'inclinaison 3D ci-dessous, mais posé
	// dans ce même setup puisque les deux ont besoin du même élément `tilt`
	// et sont appelés depuis les 3 mêmes sites d'appel (Card/Deck/Wantlist
	// detail) — une fonction, un seul appel par modale, plutôt que deux.
	setupResponsiveRadius(tilt, CARD_RADIUS_RATIO, CARD_RADIUS_MIN, CARD_RADIUS_MAX, "--mtg-card-radius");

	// 12 (pas 6, puis 8) : deuxième renforcement demandé — l'angle
	// précédent était encore jugé trop discret.
	const maxTiltDeg = 12;
	const handleMove = (evt: MouseEvent) => {
		const rect = anchor.getBoundingClientRect();
		const px = (evt.clientX - rect.left) / rect.width;
		const py = (evt.clientY - rect.top) / rect.height;
		const rotateY = (px - 0.5) * maxTiltDeg * 2;
		const rotateX = (0.5 - py) * maxTiltDeg * 2;
		if (!Platform.isMobile) {
			tilt.style.transform = `perspective(1400px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
		}
		tilt.style.setProperty("--holo-x", `${px * 100}%`);
		tilt.style.setProperty("--holo-y", `${py * 100}%`);
		// Position du reflet arc-en-ciel (.mtg-card-detail-holo-shine) :
		// amortie sur une plage resserrée (20-80%) plutôt que la position
		// brute du curseur (--holo-x/-y, 0-100%, utilisée par le spot blanc
		// .mtg-card-detail-holo-sweep) — la bande colorée dérive doucement
		// sur la carte au lieu de suivre sèchement la souris jusqu'aux
		// bords, comme un vrai reflet holographique physique. Cf. le projet
		// de référence pokemon-cards-css (Card.svelte, `adjust(percent, 0,
		// 100, 37, 63)`), qui sépare de la même façon la position du reflet
		// coloré (amortie) de celle du glare net (brute).
		tilt.style.setProperty("--holo-bg-x", `${20 + px * 60}%`);
		tilt.style.setProperty("--holo-bg-y", `${20 + py * 60}%`);
		// Rotation de teinte (--holo-hue, lue par le filter: hue-rotate() de
		// .mtg-card-detail-holo-shine) dérivée des MÊMES angles rotateX/
		// rotateY que l'inclinaison : sans ça, le dégradé ne fait que
		// glisser en gardant toujours les mêmes couleurs aux mêmes endroits
		// (un pur effet de parallaxe) — une vraie carte holographique change
		// de COULEUR à un endroit donné selon l'angle de vue (réseau de
		// diffraction), pas seulement de position. hue-rotate recolore tout
		// le calque uniformément, donc une même zone affichée à l'écran voit
		// sa teinte varier au fur et à mesure qu'on incline la carte.
		// Facteur *8 (pas *5, encore jugé trop discret) : sur l'amplitude
		// réelle de rotateX/rotateY (±16deg chacun avec maxTiltDeg=8), ça
		// couvre jusqu'à ~512deg de variation de teinte sur l'ensemble du
		// geste — hue-rotate étant cyclique (mod 360), ça ne "saute" jamais,
		// ça balaie juste une bonne partie de la roue chromatique plus d'une
		// fois entre deux positions opposées de la souris.
		const hueShift = (rotateX - rotateY) * 8;
		tilt.style.setProperty("--holo-hue", `${hueShift}deg`);
		// Intensité du reflet arc-en-ciel (--holo-intensity, lue par
		// l'opacité de .mtg-card-detail-holo-shine) modulée par la distance
		// du curseur au CENTRE de la carte — 0 pile au centre (carte à plat,
		// face à l'écran), jusqu'à 1 en s'approchant des bords. Sans ça, le
		// reflet restait pleinement visible même carte à plat, ce qui n'a
		// pas de sens physiquement : un vrai film holographique ne change
		// de couleur qu'à angle de vue oblique, pas de face (signalé). /0.5
		// (pas /0.7071, la distance jusqu'au coin) : on veut déjà une
		// intensité pleine en s'approchant d'un BORD, pas seulement des
		// coins, sinon l'effet resterait atténué sur la majeure partie de
		// la carte.
		const distFromCenter = Math.min(1, Math.hypot(px - 0.5, py - 0.5) / 0.5);
		tilt.style.setProperty("--holo-intensity", `${distFromCenter}`);
		tilt.addClass("is-tilting");
	};
	const handleLeave = () => {
		tilt.style.removeProperty("transform");
		tilt.removeClass("is-tilting");
	};
	anchor.addEventListener("mousemove", handleMove);
	anchor.addEventListener("mouseleave", handleLeave);
}

// Anime la navigation précédent/suivant façon Cover Flow : l'ancienne et la
// nouvelle carte sont toutes deux visibles et animées EN MÊME TEMPS (pas
// l'une après l'autre) — l'ancienne glisse/tourne hors du cadre du côté vers
// lequel on navigue pendant que la nouvelle glisse/tourne depuis le côté
// opposé jusqu'au centre. Ceci nécessite de garder l'ancien
// .mtg-card-detail-image-wrap en vie à travers le redessin de draw() (qui le
// détruirait sinon avec le reste du panneau) : on le détache AVANT d'appeler
// update(), puis on le réinsère dans le nouveau "viewport" (voir
// .mtg-card-detail-nav-viewport, styles.css) juste après, pour qu'il partage
// exactement le même cadre découpé (overflow:hidden) que la nouvelle carte —
// c'est ce qui garde l'animation dans les limites de la colonne plutôt que de
// déborder sur le panneau voisin.
// Les deux cartes passent en position:absolute (mtg-card-nav-animating) le
// temps de la transition, pour pouvoir se superposer — hors de ce court
// instant, la carte reste en flux normal (voir styles.css) pour que sa
// hauteur réelle (celle de l'image, pas une approximation) détermine celle
// du viewport. Comme deux cartes en position:absolute ne participent plus du
// tout au calcul de hauteur du parent, la hauteur du viewport est figée en
// px juste avant (capturée sur l'ancien, pendant qu'il est encore en flux
// normal) et reportée sur le nouveau, sans quoi cette boîte s'effondrerait
// pendant l'animation. onDone signale le lancement (pas la fin visuelle) de
// la transition — suffisant pour lever le verrou anti-double-clic sans
// bloquer inutilement longtemps.
export function animateCardNav(
	contentEl: HTMLElement,
	direction: "prev" | "next",
	update: () => void,
	onDone?: () => void
) {
	const oldWrap = contentEl.querySelector(".mtg-card-detail-image-wrap");
	if (!oldWrap) {
		update();
		onDone?.();
		return;
	}
	const oldViewport = oldWrap.closest(".mtg-card-detail-nav-viewport");
	const frozenHeight = oldViewport ? `${oldViewport.getBoundingClientRect().height}px` : null;
	oldWrap.addClass("mtg-card-nav-animating");
	oldWrap.remove();
	update();
	const newViewport = contentEl.querySelector<HTMLElement>(".mtg-card-detail-nav-viewport");
	const newWrap = newViewport?.querySelector(".mtg-card-detail-image-wrap");
	if (!newViewport || !newWrap) {
		onDone?.();
		return;
	}
	if (frozenHeight) newViewport.style.height = frozenHeight;
	newWrap.addClass("mtg-card-nav-animating");
	const outClass = direction === "next" ? "mtg-card-nav-out-left" : "mtg-card-nav-out-right";
	const inClass = direction === "next" ? "mtg-card-nav-in-right" : "mtg-card-nav-in-left";

	newViewport.appendChild(oldWrap);
	newWrap.addClass("mtg-card-nav-no-transition");
	newWrap.addClass(inClass);
	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			newWrap.removeClass("mtg-card-nav-no-transition");
			newWrap.removeClass(inClass);
			oldWrap.addClass(outClass);
			onDone?.();
		});
	});
	window.setTimeout(() => {
		oldWrap.remove();
		newWrap.removeClass("mtg-card-nav-animating");
		newViewport.style.removeProperty("height");
	}, 420);
}

/* -------------------------------------------------------------------------- */
/*  Boîte "Price History" (cardbase.dev) — graphique fait main, sans          */
/*  librairie de charts (voir CLAUDE.md/Conventions : ce plugin n'en a        */
/*  jamais eu besoin ailleurs). Partagé par les trois modales de détail       */
/*  (Collection/Deck/Wantlist) — chacune construit sa propre boîte (même      */
/*  convention que renderStorePricesBox, dupliqué par modale) mais délègue    */
/*  tout le calcul/dessin du graphique lui-même ici, comme setupCardTilt/     */
/*  animateCardNav plus haut dans ce fichier.                                */
/* -------------------------------------------------------------------------- */

// "surged" n'a pas de champ dédié chez cardbase (comme chez Scryfall/Card
// Kingdom/Mana Pool ailleurs dans ce plugin) — traité comme "foil". "proxy"
// n'a pas d'équivalent ici : les appelants doivent déjà exclure les cartes
// Proxy avant d'appeler getCardbasePriceHistory (même exclusion que pour
// Store Prices), donc jamais passé à cette fonction.
export function toCardbaseFinish(finish: Finish): CardbaseFinish {
	if (finish === "etched") return "etched";
	if (finish === "foiled" || finish === "surged") return "foil";
	return "normal";
}

// 4 des 5 vendeurs cardbase — cardhoarder (Magic Online, pas du papier) reste
// exclu, voir cardbase.ts. cardsphere a une entrée ici alors que sa
// couverture semble actuellement vide en pratique (voir cardbase.ts) — câblé
// quand même, `series` filtre déjà les séries sans point plus bas, donc une
// courbe sans donnée ne s'affiche simplement pas plutôt que de planter.
const PRICE_HISTORY_VENDOR_LABELS: Partial<Record<CardbaseVendor, string>> = {
	cardkingdom: "Card Kingdom",
	tcgplayer: "TCGplayer",
	cardmarket: "Cardmarket",
	cardsphere: "Cardsphere",
};

// 4 teintes Obsidian standard bien distinguables, disponibles dans tout
// thème — pas var(--text-accent)/var(--text-success) déjà chargées de sens
// ailleurs dans ce panneau (prix courant, format légal).
const PRICE_HISTORY_VENDOR_COLORS: Partial<Record<CardbaseVendor, string>> = {
	cardkingdom: "var(--color-blue)",
	tcgplayer: "var(--color-orange)",
	cardmarket: "var(--color-green)",
	cardsphere: "var(--color-pink)",
};

// Cardmarket est le seul des 4 vendeurs affichés ici à répondre en EUR (voir
// cardbase.ts/fetchCardbasePriceHistory) — tous les autres, en USD. Mélanger
// les deux sur un seul axe Y afficherait un nombre à la mauvaise hauteur
// (un "10" EUR n'est pas la même vraie valeur qu'un "10" USD) sans
// conversion. Depuis l'ajout de frankfurter.ts, un taux de change réel est
// disponible : renderPriceHistoryChart convertit alors Cardmarket vers
// settings.priceCurrency et affiche un seul axe unifié (plus lisible qu'un
// double axe, signalé explicitement — voir la discussion menant à ce
// fichier). Si le taux n'est pas disponible (échec réseau frankfurter.dev),
// repli sur l'ancien double axe indépendant ci-dessous plutôt que perdre la
// courbe Cardmarket — voir renderPriceHistoryChart.
const CARDBASE_VENDOR_CURRENCY: Partial<Record<CardbaseVendor, "usd" | "eur">> = {
	cardkingdom: "usd",
	tcgplayer: "usd",
	cardsphere: "usd",
	cardmarket: "eur",
};

// Séparateurs de milliers (Intl, pas formatMoney/price.ts — resterait
// "$150000.00" sinon, dur à lire sur une carte comme Black Lotus qui peut
// dépasser 150 000$). "en-US" pour les deux devises (pas juste USD) — même
// raisonnement que formatHistoryDate plus bas : l'anglais partout, pas la
// locale système. Local à ce graphique uniquement : ne touche pas le
// formatage partagé utilisé ailleurs dans le plugin (boîte Store Prices,
// totaux de collection, etc.), pas demandé là et hors de portée ici.
const CHART_PRICE_FORMATTERS: Record<"usd" | "eur", Intl.NumberFormat> = {
	usd: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
	eur: new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }),
};
function formatChartPrice(amount: number, currency: "usd" | "eur" = "usd"): string {
	return CHART_PRICE_FORMATTERS[currency].format(amount);
}

function formatHistoryDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface DrawnPriceSeries {
	vendor: CardbaseVendor;
	color: string;
	currency: "usd" | "eur";
	// true si cette série a été convertie depuis sa devise native (voir
	// convertUsdEur ci-dessous) pour rejoindre l'axe unifié — jamais vrai en
	// mode double-axe (repli sans taux). Pilote le tracé en pointillé + la
	// mention "(converted)" partout où cette série est affichée, pour ne
	// jamais confondre un prix converti avec le vrai prix natif du magasin.
	converted: boolean;
	points: CardbasePricePoint[];
	toY: (price: number) => number;
	d: string;
	lastX: number;
	lastY: number;
	lastPrice: number;
}

interface YAxis {
	currency: "usd" | "eur";
	yMax: number;
	toY: (price: number) => number;
}

// Axe ancré à 0 (demandé explicitement) plutôt qu'un plancher
// padded-autour-du-minimum — un vrai zéro en bas garde l'échelle honnête, pas
// de fausse impression de grosse variation sur un écart en réalité petit. La
// marge au-dessus du maximum observé combine deux termes et garde le plus
// grand des deux : une fraction de l'amplitude RÉELLEMENT observée (pour
// qu'un vrai mouvement de prix garde une marge proportionnée à son ampleur,
// sans être artificiellement écrasé) et une fraction du prix lui-même (pour
// qu'une carte quasi plate — peu d'amplitude à exploiter — garde tout de
// même une marge visible plutôt que de coller au plafond). Jamais de valeur
// ronde arbitraire type "100$" qui écraserait une carte à 1$.
function buildYAxis(seriesForAxis: { currency: "usd" | "eur"; points: CardbasePricePoint[] }[], H: number): YAxis | null {
	if (seriesForAxis.length === 0) return null;
	let maxPrice = -Infinity;
	let minPrice = Infinity;
	for (const s of seriesForAxis) {
		for (const p of s.points) {
			if (p.price > maxPrice) maxPrice = p.price;
			if (p.price < minPrice) minPrice = p.price;
		}
	}
	const priceRange = maxPrice - minPrice;
	const pad = Math.max(priceRange * 0.4, maxPrice * 0.3, 0.05);
	const yMax = maxPrice + pad;
	const yScale = yMax || 1;
	return {
		currency: seriesForAxis[0].currency,
		yMax,
		toY: (price: number) => H - (price / yScale) * H,
	};
}

// `history` peut être undefined (échec réseau après retentative) ou avoir
// une `series` vide (succès confirmé, mais aucun des 4 magasins n'a
// d'historique pour cette impression/finition) — les deux cas affichent le
// même message neutre, la distinction n'intéresse pas l'utilisateur final.
export function renderPriceHistoryChart(
	container: HTMLElement,
	history: CardbasePriceHistory | undefined,
	targetCurrency: "usd" | "eur",
	exchangeRate: UsdEurRate | undefined
) {
	container.empty();
	// Le conteneur porte la classe/l'icône de chargement (voir les appelants
	// dans modals/*.ts) jusqu'ici — plus nécessaire une fois le vrai contenu
	// (graphique ou message "aucun historique") sur le point d'être construit.
	container.removeClass("mtg-price-history-loading");
	const rawSeries = (history?.series ?? [])
		.filter((s) => s.points.length > 0 && CARDBASE_VENDOR_CURRENCY[s.vendor] !== undefined)
		.map((s) => ({ ...s, currency: CARDBASE_VENDOR_CURRENCY[s.vendor]! }));
	if (rawSeries.length === 0) {
		container.createDiv({ cls: "mtg-price-history-empty", text: "No price history available yet." });
		return;
	}

	// Axe unique si un taux de change est disponible (voir frankfurter.ts,
	// getUsdEurRate) : toute série pas déjà dans `targetCurrency` (en
	// pratique Cardmarket, seul vendeur en EUR — voir CARDBASE_VENDOR_
	// CURRENCY) est convertie et marquée `converted`, pour un tracé en
	// pointillé + une infobulle "(converted)" plutôt que de se confondre
	// avec un vrai prix affiché par ce magasin (voir DrawnPriceSeries). Un
	// seul taux "aujourd'hui" s'applique à tout l'historique de la série
	// (voir convertUsdEur) — approximation assumée, précisée dans
	// l'infobulle. Sans taux (échec réseau frankfurter.dev), repli explicite
	// sur l'ancien double axe indépendant plutôt que de perdre la courbe
	// Cardmarket.
	const series = exchangeRate
		? rawSeries.map((s) => {
				const converted = s.currency !== targetCurrency;
				return {
					...s,
					currency: targetCurrency,
					converted,
					points: converted
						? s.points.map((p) => ({
								date: p.date,
								price: convertUsdEur(p.price, s.currency, targetCurrency, exchangeRate),
						  }))
						: s.points,
				};
		  })
		: rawSeries.map((s) => ({ ...s, converted: false }));

	// Repère commun (dates uniquement) partagé par toutes les courbes, pour
	// qu'elles se comparent sur le même axe X — l'axe des prix, lui, dépend
	// de la disponibilité d'un taux de change (voir juste au-dessus).
	let minDate = Infinity;
	let maxDate = -Infinity;
	for (const s of series) {
		for (const p of s.points) {
			const t = new Date(`${p.date}T00:00:00Z`).getTime();
			if (t < minDate) minDate = t;
			if (t > maxDate) maxDate = t;
		}
	}
	const dateRange = maxDate - minDate || 1;

	const W = 300;
	const H = 80;
	const toX = (t: number) => ((t - minDate) / dateRange) * W;

	// Avec un taux (exchangeRate défini) : toutes les séries partagent déjà
	// `targetCurrency` (voir plus haut), un seul axe suffit, pas de colonne
	// secondaire. Sans taux : repli sur l'ancien partage USD (colonne de
	// gauche, primaire — c'est le cas pour la quasi-totalité des cartes,
	// Card Kingdom/TCGplayer étant les vendeurs les mieux couverts par
	// cardbase) / EUR (colonne de droite, optionnelle) ; dans le cas rare où
	// SEUL Cardmarket a des données pour cette carte, l'EUR devient l'axe
	// primaire plutôt que de laisser la colonne de gauche vide.
	let primaryAxis: YAxis;
	let secondaryAxis: YAxis | null;
	if (exchangeRate) {
		primaryAxis = buildYAxis(series, H)!;
		secondaryAxis = null;
	} else {
		const usdSeries = series.filter((s) => s.currency === "usd");
		const eurSeries = series.filter((s) => s.currency === "eur");
		const primarySeries = usdSeries.length > 0 ? usdSeries : eurSeries;
		const secondarySeries = usdSeries.length > 0 ? eurSeries : [];
		primaryAxis = buildYAxis(primarySeries, H)!;
		secondaryAxis = buildYAxis(secondarySeries, H);
	}
	const axisFor = (currency: "usd" | "eur") => (currency === primaryAxis.currency ? primaryAxis : secondaryAxis!);

	const drawn: DrawnPriceSeries[] = series.map((s) => {
		// Filet de sécurité seulement — `series` est déjà restreint aux 4
		// vendeurs de CARDBASE_VENDOR_CURRENCY juste au-dessus, cette clé
		// existe toujours en pratique ; le fallback évite juste de propager
		// un `undefined` dans le SVG si ce filtre changeait un jour sans
		// mettre ces maps à jour.
		const color = PRICE_HISTORY_VENDOR_COLORS[s.vendor] ?? "var(--text-muted)";
		const toY = axisFor(s.currency).toY;
		const d = s.points
			.map((p, i) => {
				const x = toX(new Date(`${p.date}T00:00:00Z`).getTime());
				const y = toY(p.price);
				return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(" ");
		const last = s.points[s.points.length - 1];
		const lastX = toX(new Date(`${last.date}T00:00:00Z`).getTime());
		const lastY = toY(last.price);
		return {
			vendor: s.vendor,
			color,
			currency: s.currency,
			converted: s.converted,
			points: s.points,
			toY,
			d,
			lastX,
			lastY,
			lastPrice: last.price,
		};
	});

	// Colonnes d'étiquettes Y (0 / milieu / max) en HTML de part et d'autre du
	// SVG, pas en <text> SVG : le SVG a preserveAspectRatio="none" (il
	// s'étire pour remplir sa boîte, X et Y dans des proportions
	// différentes), ce qui déformerait horizontalement un texte SVG — même
	// raisonnement déjà appliqué à dateRow plus bas. Largeur des colonnes
	// volontairement NON fixée (voir styles.css) — une carte comme Black
	// Lotus peut dépasser 150 000$, une largeur figée coupait ce genre
	// d'étiquette (signalé) ; chaque colonne se dimensionne sur son propre
	// contenu, quelle que soit sa longueur.
	const chartRow = container.createDiv({ cls: "mtg-price-history-chart-row" });
	const yLabelsLeft = chartRow.createDiv({ cls: "mtg-price-history-y-labels" });
	yLabelsLeft.createSpan({ text: formatChartPrice(primaryAxis.yMax, primaryAxis.currency) });
	yLabelsLeft.createSpan({ text: formatChartPrice(primaryAxis.yMax / 2, primaryAxis.currency) });
	yLabelsLeft.createSpan({ text: formatChartPrice(0, primaryAxis.currency) });

	const plot = chartRow.createDiv({ cls: "mtg-price-history-plot" });
	// Tout ce qui est STATIQUE (grille, courbes, point final) construit comme
	// une chaîne puis injecté via setSvgMarkup (ui/svg-markup.ts) — même
	// convention que tous les autres SVG de ce plugin. Le curseur interactif (ligne verticale + points
	// survolés) est ajouté PAR-DESSUS ensuite via l'API DOM (voir
	// setupPriceHistoryCrosshair), puisqu'il doit être mis à jour en continu
	// au mousemove sans reconstruire tout le graphique à chaque frame.
	setSvgMarkup(plot, `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
		// Grille horizontale (0 / milieu / max) — un même triplet de lignes
		// sert de repère aux DEUX axes à la fois (chacun va de son propre 0 à
		// son propre max sur la même hauteur en pixels, donc la ligne du haut
		// représente à la fois le max primaire ET le max secondaire, chacun
		// avec sa propre étiquette de part et d'autre) ; les valeurs exactes
		// sont déjà données par les étiquettes HTML, donc pas besoin
		// d'étiqueter la grille elle-même.
		`<line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--background-modifier-border)" stroke-width="1" vector-effect="non-scaling-stroke" />` +
		`<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="var(--background-modifier-border)" stroke-width="1" stroke-dasharray="3,3" vector-effect="non-scaling-stroke" />` +
		`<line x1="0" y1="0" x2="${W}" y2="0" stroke="var(--background-modifier-border)" stroke-width="1" vector-effect="non-scaling-stroke" />` +
		drawn
			.map(
				(p) =>
					// stroke-dasharray uniquement sur une série convertie (voir
					// DrawnPriceSeries) — distingue au premier coup d'œil un prix
					// estimé (converti au taux du jour) d'un vrai prix natif, sans
					// attendre un survol de la légende/infobulle.
					`<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="2"${
						p.converted ? ' stroke-dasharray="4,3"' : ""
					} vector-effect="non-scaling-stroke" />` +
					`<circle cx="${p.lastX.toFixed(1)}" cy="${p.lastY.toFixed(1)}" r="2.5" fill="${p.color}" />`
			)
			.join("") +
		`</svg>`);

	// Colonne de droite optionnelle — seulement si une devise secondaire a
	// vraiment des données pour cette carte (voir secondaryAxis ci-dessus),
	// pas un axe vide affiché par défaut.
	if (secondaryAxis) {
		const yLabelsRight = chartRow.createDiv({ cls: "mtg-price-history-y-labels mtg-price-history-y-labels-right" });
		yLabelsRight.createSpan({ text: formatChartPrice(secondaryAxis.yMax, secondaryAxis.currency) });
		yLabelsRight.createSpan({ text: formatChartPrice(secondaryAxis.yMax / 2, secondaryAxis.currency) });
		yLabelsRight.createSpan({ text: formatChartPrice(0, secondaryAxis.currency) });
	}

	const dateRow = container.createDiv({ cls: "mtg-price-history-dates" });
	dateRow.createSpan({ text: formatHistoryDate(minDate) });
	dateRow.createSpan({ text: formatHistoryDate(maxDate) });

	const legend = container.createDiv({ cls: "mtg-price-history-legend" });
	for (const p of drawn) {
		const item = legend.createDiv({ cls: "mtg-price-history-legend-item" });
		if (p.converted) item.addClass("is-converted");
		item.createSpan({ cls: "mtg-price-history-legend-dot" }).style.background = p.color;
		item.createSpan({
			cls: "mtg-price-history-legend-label",
			text: `${PRICE_HISTORY_VENDOR_LABELS[p.vendor] ?? p.vendor} · ${formatChartPrice(p.lastPrice, p.currency)}${
				p.converted ? " *" : ""
			}`,
		});
		if (p.converted) {
			// Devise d'origine déduite plutôt que stockée à part : seules
			// USD/EUR existent ici (voir CARDBASE_VENDOR_CURRENCY), donc
			// "convertie vers targetCurrency" détermine sans ambiguïté
			// laquelle des deux était la devise native.
			const originalCurrency = targetCurrency === "usd" ? "EUR" : "USD";
			item.setAttribute(
				"title",
				`Converted from ${originalCurrency} to ${targetCurrency.toUpperCase()} using today's exchange rate (frankfurter.dev) — the whole history uses today's rate, not the rate on each specific day.`
			);
		}
	}

	setupPriceHistoryCrosshair(plot, drawn, toX, minDate, dateRange, W, H);
}

// Ligne verticale + un point par courbe qui suivent la souris, avec une
// infobulle date/prix — ajoutés par-dessus le SVG statique (voir
// renderPriceHistoryChart ci-dessus) via l'API DOM plutôt que reconstruits en
// chaîne à chaque mousemove, pour rester fluide. `allTimestamps` est l'union
// des dates de toutes les courbes (pas juste une seule) au cas où un magasin
// manquerait un jour que l'autre a — le point exact au jour survolé est
// cherché indépendamment par courbe, une courbe sans donnée ce jour-là cache
// juste son propre point plutôt que d'interpoler une valeur inventée. Chaque
// courbe porte déjà son propre `toY` (voir DrawnPriceSeries) — plus besoin
// qu'une fonction ici sache quel axe/devise correspond à quel vendeur.
function setupPriceHistoryCrosshair(
	plot: HTMLElement,
	drawn: DrawnPriceSeries[],
	toX: (t: number) => number,
	minDate: number,
	dateRange: number,
	W: number,
	H: number
) {
	const svgEl = plot.querySelector("svg");
	if (!svgEl) return;
	const svgNS = "http://www.w3.org/2000/svg";

	const allTimestamps = Array.from(
		new Set(drawn.flatMap((s) => s.points.map((p) => new Date(`${p.date}T00:00:00Z`).getTime())))
	).sort((a, b) => a - b);
	if (allTimestamps.length === 0) return;

	const crosshairLine = document.createElementNS(svgNS, "line");
	crosshairLine.setAttribute("y1", "0");
	crosshairLine.setAttribute("y2", String(H));
	crosshairLine.setAttribute("stroke", "var(--text-muted)");
	crosshairLine.setAttribute("stroke-width", "1");
	crosshairLine.setAttribute("vector-effect", "non-scaling-stroke");
	crosshairLine.addClass("mtg-hidden");
	svgEl.appendChild(crosshairLine);

	const crosshairDots = drawn.map((s) => {
		const dot = document.createElementNS(svgNS, "circle");
		dot.setAttribute("r", "3");
		dot.setAttribute("fill", s.color);
		dot.addClass("mtg-hidden");
		svgEl.appendChild(dot);
		return dot;
	});

	const tooltip = plot.createDiv({ cls: "mtg-price-history-tooltip" });

	const update = (clientX: number) => {
		const rect = svgEl.getBoundingClientRect();
		if (rect.width === 0) return;
		const cursorFrac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		const targetT = minDate + cursorFrac * dateRange;

		let nearest = allTimestamps[0];
		let bestDiff = Infinity;
		for (const t of allTimestamps) {
			const diff = Math.abs(t - targetT);
			if (diff < bestDiff) {
				bestDiff = diff;
				nearest = t;
			}
		}

		const x = toX(nearest);
		crosshairLine.setAttribute("x1", String(x));
		crosshairLine.setAttribute("x2", String(x));
		crosshairLine.removeClass("mtg-hidden");

		const lines = [formatHistoryDate(nearest)];
		drawn.forEach((s, i) => {
			const point = s.points.find((p) => new Date(`${p.date}T00:00:00Z`).getTime() === nearest);
			const dot = crosshairDots[i];
			if (point) {
				dot.setAttribute("cx", String(x));
				dot.setAttribute("cy", String(s.toY(point.price)));
				dot.removeClass("mtg-hidden");
				lines.push(
					`${PRICE_HISTORY_VENDOR_LABELS[s.vendor] ?? s.vendor}: ${formatChartPrice(point.price, s.currency)}${
						s.converted ? " (converted)" : ""
					}`
				);
			} else {
				dot.addClass("mtg-hidden");
			}
		});

		tooltip.empty();
		lines.forEach((line) => tooltip.createDiv({ text: line }));
		tooltip.addClass("is-visible");
		// Ancré sur la position RÉELLEMENT dessinée du curseur (x/W, le point
		// accroché le plus proche), pas la fraction brute de la souris — sans
		// ça l'infobulle et la ligne verticale peuvent légèrement diverger sur
		// un graphique à faible résolution de points. Bascule à gauche du
		// curseur passé 75% de la largeur pour ne jamais déborder à droite.
		const snappedFrac = x / W;
		const nearRightEdge = snappedFrac > 0.75;
		tooltip.style.left = nearRightEdge ? "" : `${snappedFrac * 100}%`;
		tooltip.style.right = nearRightEdge ? `${(1 - snappedFrac) * 100}%` : "";
	};

	const hide = () => {
		crosshairLine.addClass("mtg-hidden");
		crosshairDots.forEach((d) => d.addClass("mtg-hidden"));
		tooltip.removeClass("is-visible");
	};

	plot.addEventListener("mousemove", (evt) => update(evt.clientX));
	plot.addEventListener("mouseleave", hide);
}

// Attribution de la source — un élément STATIQUE, à part de `body` (voir
// renderPriceHistoryChart ci-dessus), ajouté une seule fois à la boîte
// elle-même par chaque modale (voir renderPriceHistoryBox) plutôt que
// reconstruit à chaque résolution du fetch : reste donc visible dès le tout
// premier paint (pendant le chargement) et pas seulement une fois les
// données arrivées, ce qui répond au passage à la demande "peut-on afficher
// la source" même pendant l'attente plutôt que seulement après.
export function renderPriceHistorySourceFooter(box: HTMLElement): HTMLElement {
	const footer = box.createDiv({ cls: "mtg-price-history-source" });
	footer.setText("Source: cardbase.dev");
	footer.addEventListener("click", () => window.open("https://cardbase.dev", "_blank"));
	return footer;
}

// Complète le pied de page une fois l'historique résolu, avec la date de
// fraîcheur des données cardbase (CardbasePriceHistory.asOf — voir
// cardbase.ts pour pourquoi ça vient de la même réponse déjà récupérée,
// aucun appel GET /status séparé). Appelé depuis le .then() de
// renderPriceHistoryBox (les 3 modales), après renderPriceHistoryChart —
// séparé de renderPriceHistorySourceFooter ci-dessus plutôt que fusionné,
// puisque cette info n'est connue qu'après le fetch alors que le pied de
// page lui-même doit exister dès le premier paint (voir son propre
// commentaire). Un asOf absent (échec réseau, ou réponse mal formée) laisse
// le texte "Source: cardbase.dev" existant tel quel plutôt que d'ajouter
// une date manquante.
export function appendAsOfToSourceFooter(footer: HTMLElement, asOf: string | undefined) {
	if (!asOf) return;
	footer.setText(`Source: cardbase.dev · Data as of ${asOf}`);
}

export function renderLoadingDots(container: HTMLElement) {
	container.addClass("mtg-loading-dots");
	container.createSpan();
	container.createSpan();
	container.createSpan();
}

// Petit badge "▲ +2.1%"/"▼ -1.3%" sous le prix Card Kingdom/TCGplayer/
// Cardmarket, veille→aujourd'hui — voir getCardbaseDayChange (cardbase.ts)
// pour le calcul. Glyphe Unicode plutôt qu'une icône Lucide/setIcon : ce
// fichier n'a par ailleurs aucune dépendance à "obsidian" (voir son en-tête
// de fichier — helpers de rendu purs), et un triangle plein coloré via
// `color` suffit largement pour un indicateur aussi petit, pas besoin
// d'introduire cette dépendance pour si peu. `undefined`/"flat" (0% exact —
// les deux derniers points sont identiques) ne rendent rien du tout plutôt
// qu'un badge gris "0.0%" : un jour sans mouvement n'est pas une donnée
// intéressante à mettre en avant ici, et beaucoup de cartes n'auront tout
// simplement pas bougé d'un jour à l'autre. Le conteneur est vidé/recoloré
// à chaque appel (pas seulement rempli une fois) pour rester correct si
// jamais appelé plusieurs fois sur le même élément (pas le cas aujourd'hui,
// mais évite un piège silencieux si un futur appelant réutilise l'élément).
export function renderDayChangeBadge(container: HTMLElement, change: CardbaseDayChange | undefined) {
	container.empty();
	container.removeClass("is-up", "is-down");
	if (!change || change.direction === "flat") return;
	container.addClass(change.direction === "up" ? "is-up" : "is-down");
	container.createSpan({ cls: "mtg-store-price-col-change-arrow", text: change.direction === "up" ? "▲" : "▼" });
	const sign = change.changePct > 0 ? "+" : "";
	container.createSpan({ text: `${sign}${change.changePct.toFixed(1)}%` });
}

// Construit une icône pour un seul symbole de mana ("W", "2", "T", "2/W"...),
// partagée par renderManaCostIcons (coût complet) et
// renderTextWithManaSymbols (symboles isolés au milieu d'un texte de règles)
// ci-dessous — même lookup asynchrone (`getSymbolSvg`, en pratique
// `plugin.getManaSymbolSvg` côté appelant, déjà utilisé pour les icônes de
// regroupement par couleur dans view.ts — même endpoint /symbology, mêmes
// clés "{X}"), seule la taille de rendu diffère entre les deux usages. Chaque
// symbole non reconnu (rarissime : un tout nouveau symbole pas encore
// synchronisé côté cache) retombe sur son propre texte brut ("{W}") plutôt
// qu'une case vide silencieuse.
function buildManaSymbolIcon(
	container: HTMLElement,
	letter: string,
	rawToken: string,
	getSymbolSvg: (letter: string) => Promise<string | null>,
	size: number
): HTMLElement {
	const iconEl = container.createSpan({ cls: "mtg-mana-symbol-icon" });
	void getSymbolSvg(letter).then((svg) => {
		if (!svg) {
			iconEl.setText(rawToken);
			return;
		}
		setSvgMarkup(iconEl, svg);
		const svgEl = iconEl.querySelector("svg");
		svgEl?.setAttribute("width", String(size));
		svgEl?.setAttribute("height", String(size));
	});
	return iconEl;
}

// Découpe un coût de mana Scryfall ("{2}{W}{W}") en icônes officielles, un
// <span> par symbole — cette fonction reste pure (pas de dépendance à
// MTGCollectionPlugin, contrairement au reste de ce fichier) en recevant le
// lookup en paramètre, voir buildManaSymbolIcon ci-dessus.
export function renderManaCostIcons(
	container: HTMLElement,
	manaCost: string,
	getSymbolSvg: (letter: string) => Promise<string | null>
) {
	const symbols = manaCost.match(/\{[^}]+\}/g);
	if (!symbols) return;
	symbols.forEach((sym) => {
		buildManaSymbolIcon(container, sym.slice(1, -1), sym, getSymbolSvg, 16).addClass(
			"mtg-card-description-mana-symbol"
		);
	});
}

// Rend un texte de règles en remplaçant chaque symbole de mana isolé qu'il
// contient (ex. "{T}: Add {W}.") par son icône officielle, comme
// renderManaCostIcons ci-dessus mais avec du texte normal entre les
// symboles — contrairement à un coût de mana ("{2}{W}{W}"), oracle_text
// mélange texte brut et symboles. La regex capturante (parenthèses autour du
// motif) fait que String.split conserve les délimiteurs dans le tableau
// résultat, contrairement à match() utilisé par renderManaCostIcons — c'est
// ce qui permet de reconstruire texte et icônes dans le bon ordre. Chaque
// fragment de texte est ajouté en tant que vrai nœud texte (pas de
// setText/balisage) pour ne jamais interpréter un `<`/`&` du texte de règles
// comme du HTML.
export function renderTextWithManaSymbols(
	container: HTMLElement,
	text: string,
	getSymbolSvg: (letter: string) => Promise<string | null>
) {
	const parts = text.split(/(\{[^}]+\})/g);
	parts.forEach((part) => {
		if (/^\{[^}]+\}$/.test(part)) {
			buildManaSymbolIcon(container, part.slice(1, -1), part, getSymbolSvg, 14).addClass(
				"mtg-card-description-inline-mana-symbol"
			);
		} else if (part) {
			container.appendChild(document.createTextNode(part));
		}
	});
}

// Bloc "Card Text" d'une carte à plusieurs faces (split, adventure, flip,
// transform, modal_dfc...) — voir CardTextInfo.faces (scryfall.ts) pour le
// raisonnement complet. Une section par face (nom, type+coût de mana,
// texte de règles, stats), séparées d'une ligne discrète, plutôt que la
// version fusionnée d'origine ("Instant // Instant", les deux coûts de
// mana bout à bout) — retour explicite ("je préférerais que cela soit bien
// séparé pour chaque portion de la carte... une ligne horizontale discrète"
// plutôt qu'un "//" textuel). Réutilise renderManaCostIcons/
// renderTextWithManaSymbols tels quels, une fois par face plutôt qu'une
// seule fois sur la chaîne fusionnée — chaque face a son propre coût de
// mana/texte déjà séparé à la source (card_faces), donc plus besoin
// d'inventer une logique de découpage.
// Appelée par les 3 modales de détail à la place de leur propre
// header+textEl+stats habituels dès que CardTextInfo.faces est présent —
// voir CardDetailModal.renderCardDescriptionBox pour le point d'appel.
export function renderCardDescriptionFaces(
	container: HTMLElement,
	faces: CardTextFace[],
	getSymbolSvg: (letter: string) => Promise<string | null>
) {
	faces.forEach((face, i) => {
		if (i > 0) container.createDiv({ cls: "mtg-card-description-face-divider" });
		const faceEl = container.createDiv({ cls: "mtg-card-description-face" });
		faceEl.createDiv({ cls: "mtg-card-description-face-name", text: face.name });
		const header = faceEl.createDiv({ cls: "mtg-card-description-header" });
		if (face.typeLine) header.createDiv({ cls: "mtg-card-description-type", text: face.typeLine });
		if (face.manaCost) {
			const manaCostEl = header.createDiv({ cls: "mtg-card-description-mana-cost" });
			renderManaCostIcons(manaCostEl, face.manaCost, getSymbolSvg);
		}
		const textEl = faceEl.createDiv({ cls: "mtg-card-description-text" });
		renderTextWithManaSymbols(textEl, face.oracleText || "No rules text.", getSymbolSvg);
		if (face.loyalty !== undefined) {
			faceEl.createDiv({ cls: "mtg-card-description-stats", text: `Loyalty: ${face.loyalty}` });
		} else if (face.power !== undefined || face.toughness !== undefined) {
			faceEl.createDiv({
				cls: "mtg-card-description-stats",
				text: `${face.power ?? "?"}/${face.toughness ?? "?"}`,
			});
		}
	});
}

// Bouton "flip" 3D sous la carte, pour les vraies cartes double-face
// (transform/modal_dfc — voir getDoubleFacedImages, scryfall.ts) : partagé
// par les 3 modales de détail, mêmes DOM/CSS/interaction partout. Le guard
// de péremption (this.card.scryfallId === l'id demandé au lancement du
// fetch, contre une navigation prev/next pendant l'aller-retour Scryfall)
// reste côté appelant, même convention que renderPriceHistoryChart/
// renderDayChangeBadge plus haut dans ce fichier — cette fonction ne fait
// que construire le DOM une fois qu'on sait déjà qu'il y a un verso à
// montrer.
// `tilt` doit déjà contenir tout son contenu "recto" habituel (l'image +
// les calques foil/holo éventuels, construits par l'appelant exactement
// comme avant pour une carte non double-face) — cette fonction déplace ces
// enfants existants dans un nouveau conteneur de rotation plutôt que de les
// reconstruire, donc appeler ceci APRÈS que l'appelant a fini de peupler
// `tilt`, jamais avant. setupCardTilt (déjà appelé sur ce même `tilt` avant
// ceci, dans les 3 modales) ne lit/n'écrit que des propriétés sur `tilt`
// lui-même (style.transform, --holo-*, un ResizeObserver sur sa largeur) —
// aucune hypothèse sur ses enfants, donc les réorganiser après coup ne le
// perturbe pas.
// Pas de dépendance à setIcon/"obsidian" ici (voir l'en-tête de ce fichier —
// aucune des autres fonctions de rendu partagées n'en a, même raisonnement
// que renderDayChangeBadge pour son glyphe ▲/▼) : l'icône du bouton est un
// simple caractère Unicode plutôt qu'une icône Lucide.
export function setupDoubleFacedFlip(
	imageColumn: HTMLElement,
	tilt: HTMLElement,
	backImageUrl: string,
	initiallyFlipped: boolean,
	onToggle: (flipped: boolean) => void
): void {
	const flipStage = tilt.createDiv({ cls: "mtg-card-detail-flip-stage" });
	const frontFace = flipStage.createDiv({
		cls: "mtg-card-detail-flip-face mtg-card-detail-flip-face-front",
	});
	// Array.from copie la NodeList AVANT de la vider par déplacement —
	// appendChild retire chaque enfant de son parent d'origine (tilt) au fur
	// et à mesure, donc itérer directement la NodeList vivante de `tilt`
	// sauterait un enfant sur deux au fil du déplacement.
	Array.from(tilt.children)
		.filter((child) => child !== flipStage)
		.forEach((child) => frontFace.appendChild(child));

	const backFace = flipStage.createDiv({
		cls: "mtg-card-detail-flip-face mtg-card-detail-flip-face-back",
	});
	backFace.createEl("img", { cls: "mtg-card-detail-image", attr: { src: backImageUrl } });

	if (initiallyFlipped) flipStage.addClass("is-flipped");

	const btn = imageColumn.createDiv({ cls: "mtg-card-detail-flip-btn" });
	const updateLabel = () => {
		btn.empty();
		btn.createSpan({ cls: "mtg-card-detail-flip-btn-icon", text: "⇄" });
		btn.createSpan({ text: flipStage.hasClass("is-flipped") ? "Show front" : "Show back" });
	};
	updateLabel();
	btn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		const flipped = !flipStage.hasClass("is-flipped");
		flipStage.toggleClass("is-flipped", flipped);
		updateLabel();
		onToggle(flipped);
	});
}

// Ratio réel d'une image Scryfall "normal" (488×680 — voir "Card view" dans
// CLAUDE.md pour cette référence) : hauteur = largeur × ce ratio, en
// orientation portrait naturelle. Utilisé ici pour calculer, à une largeur
// de `stage` donnée, la hauteur paysage naturelle d'une carte tournée
// (largeur × 1/ce ratio) — `stage` lui-même garde toujours l'aspect-ratio
// 488/680 inverse (styles.css), donc ce nombre n'a besoin d'être défini
// qu'une fois ici plutôt que dupliqué des deux côtés.
const SCRYFALL_CARD_PORTRAIT_RATIO = 680 / 488;

// Bouton "rotation" pour les cartes split (Fire // Ice, Never // Return...
// — voir getSplitCardInfo, scryfall.ts) : contrairement à setupDoubleFaced-
// Flip ci-dessus, il n'y a ici qu'UN SEUL visuel imprimé — c'est son
// AFFICHAGE qu'il faut tourner à 90°, pas un second visuel à révéler.
// Mêmes conventions d'appel que setupDoubleFacedFlip : `tilt` doit déjà
// contenir tout son contenu habituel (image + calques foil/holo éventuels),
// cette fonction déplace ces enfants existants dans un calque de rotation
// plutôt que de les reconstruire — appeler APRÈS que l'appelant a fini de
// peupler `tilt`, et après setupCardTilt (qui ne lit/n'écrit que des
// propriétés sur `tilt` lui-même, aucune hypothèse sur ses enfants — même
// raisonnement déjà établi pour setupDoubleFacedFlip). Le guard de
// péremption (this.card.scryfallId === l'id demandé) reste côté appelant,
// même convention que les autres boîtes async de ce panneau.
//
// **Refonte (2026-08-17)** suite à deux retours : le bouton "Rotate to
// read"/"Reset rotation" se déplaçait verticalement selon l'état (la toute
// première version ne réservait la hauteur paysage, plus courte, que
// pendant qu'on était tourné), et la rotation semblait "brusque" (pas
// animée du tout, par prudence — voir l'ancienne version de ce commentaire
// dans l'historique git). Voir styles.css pour le détail complet du
// nouveau calcul : `stage` garde maintenant TOUJOURS l'aspect-ratio
// portrait (488/680), donc sa hauteur réservée ne bouge plus jamais — ce
// qui fixe le bouton d'un coup — et `rotateLayer` est maintenant TOUJOURS
// position:absolute + centré dans les deux états (jamais un `position` qui
// bascule, propriété non interpolable), ce qui rend l'animation possible :
// resize() lui fixe, en JS, une largeur/hauteur explicites dans les DEUX
// états désormais (pas seulement quand tourné) — au repos, la taille
// portrait naturelle de `stage` à sa largeur actuelle ; tourné, ces deux
// valeurs inversées, pour que le rectangle peint après rotate(90deg) fasse
// toute la largeur de `stage` à sa hauteur paysage naturelle (plus courte
// que `stage` lui-même, désormais toujours portrait — d'où l'espace vide
// centré au-dessus/en dessous de la carte tournée, le compromis délibéré
// qui achète la stabilité du bouton). ResizeObserver sur `stage`, même
// technique que setupCardTileRadiusObserver/computeCardTileRadius (view.ts,
// voir "Card view" dans CLAUDE.md) — pas de disconnect() explicite, même
// raisonnement déjà établi pour l'observer de setupCardTilt sur ce même
// `tilt` : `stage` est reconstruit à neuf à chaque draw(), jamais réutilisé,
// donc une fois l'ancien élément détaché et sans autre référence, son
// observer devient éligible au GC de lui-même.
// Transition animée cette fois (contrairement à la version précédente,
// prudemment non animée par analogie avec le bug de désynchronisation de
// .mtg-card-detail-grading-wrapper, voir "v13" dans CLAUDE.md) : ce risque
// concernait deux ÉLÉMENTS/mécanismes de rendu distincts qui devaient
// rester en phase (grid-template-rows d'un côté, margin d'un élément
// voisin de l'autre) — ici tout change sur le MÊME élément
// (`rotateLayer`), dans le MÊME batch synchrone (classe + style.width/
// height posés dans le même tick, voir applyState ci-dessous), donc le
// navigateur n'a qu'un seul état "avant"/"après" à interpoler, sans cette
// classe de risque.
export function setupSplitCardRotation(
	imageColumn: HTMLElement,
	tilt: HTMLElement,
	initiallyRotated: boolean,
	onToggle: (rotated: boolean) => void
): void {
	const stage = tilt.createDiv({ cls: "mtg-card-detail-split-stage" });
	const rotateLayer = stage.createDiv({ cls: "mtg-card-detail-split-rotate" });
	Array.from(tilt.children)
		.filter((child) => child !== stage)
		.forEach((child) => rotateLayer.appendChild(child));

	let rotated = initiallyRotated;

	// offsetWidth, PAS getBoundingClientRect().width (bug rapporté : la
	// carte suivante s'affichait "en plus petit" en naviguant d'une carte
	// tournée vers une autre carte split) — getBoundingClientRect() reflète
	// la géométrie VISUELLE, donc TOUT transform CSS porté par un ANCÊTRE,
	// y compris transitoire. `stage` vit sous `.mtg-card-detail-image-wrap`,
	// qui porte pendant ~1-2 frames le transform d'entrée du carrousel
	// Cover Flow (animateCardNav, translateX + rotateY, voir styles.css) —
	// si la promesse getSplitCardInfo de la carte suivante se résout très
	// vite (cache déjà chaud, ex. carte déjà visitée cette session : le
	// callback .then() s'exécute en microtâche, AVANT le premier
	// requestAnimationFrame qui retire ce transform), resize() mesurait
	// alors la carte encore rétrécie par la perspective 3D du carrousel
	// (rotateY déforme la largeur perçue), figeant cette taille trop
	// petite pour de bon puisque rien ne redéclenche resize() une fois le
	// transform retiré (un transform ne change jamais la taille de MISE EN
	// PAGE, seulement le rendu visuel — ResizeObserver, qui observe la
	// boîte de mise en page, ne se redéclenche donc pas quand ce transform
	// disparaît). offsetWidth renvoie la largeur de mise en page réelle,
	// insensible à tout transform (le sien ou celui d'un ancêtre) — la
	// bonne mesure ici, quel que soit le moment où elle a lieu.
	const resize = () => {
		const width = stage.offsetWidth;
		if (width === 0) return;
		if (rotated) {
			// Pré-rotation : largeur/hauteur inversées pour qu'après
			// rotate(90deg) le rectangle peint fasse toute la largeur de
			// `stage`, à sa hauteur paysage naturelle.
			rotateLayer.style.width = `${width / SCRYFALL_CARD_PORTRAIT_RATIO}px`;
			rotateLayer.style.height = `${width}px`;
		} else {
			rotateLayer.style.width = `${width}px`;
			rotateLayer.style.height = `${width * SCRYFALL_CARD_PORTRAIT_RATIO}px`;
		}
	};

	const applyState = () => {
		stage.toggleClass("is-rotated", rotated);
		resize();
	};
	applyState();

	const observer = new ResizeObserver(() => resize());
	observer.observe(stage);

	// Réutilise .mtg-card-detail-flip-btn/-btn-icon tel quel (même pilule
	// accent-outline sous l'image que le bouton "flip" 3D) plutôt qu'une
	// classe dédiée — les deux boutons ne coexistent jamais (une carte est
	// soit une vraie double-face, soit split, jamais les deux à la fois, voir
	// getDoubleFacedImages/getSplitCardInfo), et le style visuel est
	// générique — même raisonnement de réutilisation que .mtg-card-detail-
	// backdrop/-close-btn ailleurs dans ce plugin (le nom ne colle pas
	// exactement à chaque usage, mais la règle CSS elle-même est générique).
	const btn = imageColumn.createDiv({ cls: "mtg-card-detail-flip-btn" });
	const updateLabel = () => {
		btn.empty();
		btn.createSpan({ cls: "mtg-card-detail-flip-btn-icon", text: "↻" });
		btn.createSpan({ text: rotated ? "Reset rotation" : "Rotate to read" });
	};
	updateLabel();
	btn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		rotated = !rotated;
		// La géométrie animée (transform + width/height tous trois en
		// transition, voir styles.css) fait transitoirement déborder le
		// rectangle peint au-delà de sa taille de repos — le "renflement"
		// naturel d'un rectangle qui tourne ET change de taille en même
		// temps, maximal autour de 45° (mesuré ~1.45× la largeur de repos
		// dans un test isolé) — que le clip de `tilt` (dimensionné pour les
		// DEUX états de repos, pas pour ce pic transitoire) rognait
		// visiblement pendant la rotation (bug rapporté). Désactivé le
		// temps de la transition (même durée que le CSS, 450ms) : à
		// l'arrêt, le clip se réapplique proprement sur la forme finale
		// exacte — `.mtg-card-detail-nav-viewport`, plus large que la carte
		// et jamais touché ici, continue de contenir tout débordement dans
		// les limites de la colonne pendant cette fenêtre.
		tilt.addClass("mtg-card-detail-tilt-rotating");
		window.setTimeout(() => tilt.removeClass("mtg-card-detail-tilt-rotating"), 450);
		applyState();
		updateLabel();
		onToggle(rotated);
	});
}

export function renderLegalityColorLegend(box: HTMLElement) {
	const legend = box.createDiv({ cls: "mtg-legal-formats-legend" });
	const items: { cls: string; label: string }[] = [
		{ cls: "is-legal", label: "Legal" },
		{ cls: "is-restricted", label: "Restricted" },
		{ cls: "is-banned", label: "Banned" },
		{ cls: "is-not-legal", label: "Not legal" },
	];
	items.forEach(({ cls, label }) => {
		const item = legend.createDiv({ cls: "mtg-legal-formats-legend-item" });
		item.createDiv({ cls: `mtg-legal-formats-legend-swatch ${cls}` });
		item.createSpan({ text: label });
	});
}
