import { setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { Finish } from "../core/card-model";
import { ScryfallCard, getImageUrl, applySvgColor, getRarityColor } from "../api/scryfall";
import { ListGroup, WantlistGroup, formatScryfallPrice } from "../core/price";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  Search modal                                                              */
/* -------------------------------------------------------------------------- */

export interface AddCardOptions {
	finish: Finish;
	language: string;
	condition: string;
}

export interface AddCardsModalOptions {
	// Renvoie l'entrée résultante (id + count + listId réel) quand l'appelant
	// peut la fournir (addCardToCollection/addCardToWantlist/addCardToDeck
	// la renvoient toutes les trois — CollectionCard/WantlistCard ont un
	// champ id propre, DeckCard n'en a pas et le call site utilise
	// scryfallId à sa place, voir openDeckCardDetailById/le call site
	// "+ Add cards" du deck dans view.ts — la signature ne fait qu'exposer
	// un identifiant qui existait déjà en pratique dans chaque cas) —
	// AddCardsModal s'en sert, avec onChangeQuantity, pour transformer le
	// bouton "Add" d'une tuile en stepper +/- juste après l'ajout, et
	// (listId) pour savoir à quelle destination une contribution à
	// l'historique d'ajouts appartient (voir onUndoAdd plus bas — utile
	// surtout pour le flux listGallery, où la destination n'est connue
	// qu'après ce tout premier ajout réussi). void reste possible pour un
	// futur appelant qui ne pourrait pas fournir cette forme — aucun des 3
	// flux actuels (Collection/Wantlist/Deck) n'a plus besoin de cette
	// branche depuis l'uniformisation du flux Deck, mais le type reste
	// permissif plutôt que resserré à { id, count, listId } seul.
	onAdd: (
		card: ScryfallCard,
		options: AddCardOptions,
		listId?: string
	) => { id: string; count: number; listId: string } | void;
	// Change la quantité d'une entrée déjà ajoutée (voir onAdd ci-dessus) —
	// fourni par les 3 flux (changeCollectionCardCount/changeWantlistCardCount/
	// changeDeckCardCount). Absent = pas de stepper, le bouton "Add" reste
	// "Add" même si onAdd a renvoyé une entrée.
	onChangeQuantity?: (entryId: string, delta: number, onDone: () => void) => void;
	// Ouvre la fenêtre de détail de la carte une fois ajoutée — demandé
	// explicitement : une tuile devenue stepper (voir onChangeQuantity
	// ci-dessus, qui doit donc être fourni aussi pour que ce callback ait un
	// sens) devient cliquable et ouvre CardDetailModal/WantlistCardDetail-
	// Modal/DeckCardDetailModal (le call site connaît lequel, pas cette
	// interface générique — c'est pour ça que AddCardsModal ne construit
	// jamais lui-même une fenêtre de détail, il se contente de relayer l'id
	// de l'entrée ajoutée).
	// `onDetailClosed` — bug signalé : modifier la quantité (ou supprimer la
	// carte) depuis cette fenêtre de détail, puis revenir dans "Add cards",
	// laissait la tuile du carrousel affichée avec son ancienne valeur, rien
	// ne la resynchronisait après coup. Le call site (qui construit la
	// fenêtre de détail et sait donc quand elle se ferme) DOIT rappeler ce
	// callback à ce moment-là avec la ligne réelle à jour (ou undefined si
	// supprimée) — AddCardsModal s'en sert pour rejouer exactement la même
	// logique de resynchronisation que le panneau "Add history" (voir
	// syncFromHistory, add-cards-modal.ts), qui accepte déjà cette forme de
	// retour.
	onOpenDetail?: (
		entryId: string,
		onDetailClosed: (currentRow: { id: string; count: number } | undefined) => void
	) => void;
	// Annule `delta` exemplaires ajoutés avec CES options précises, à cette
	// destination — utilisé par le panneau "Add history" (voir search-
	// modal.ts) pour désactiver/supprimer une tuile d'historique. Symétrique
	// d'onAdd : le call site retrouve la ligne par la même clé de
	// dédoublonnage qu'addCardToCollection/addCardToWantlist/addCardToDeck
	// utilisent déjà pour FUSIONNER un ajout, plutôt que de faire remonter un
	// id de ligne qui pourrait devenir invalide entre-temps (ligne supprimée
	// par un undo précédent, puis recréée par un redo — voir AddCardsModal.
	// toggleHistoryEntry). Renvoie la ligne résultante (ou undefined si
	// supprimée) pour que AddCardsModal puisse resynchroniser l'affichage
	// de la tuile carrousel correspondante sur l'état réel. Fourni par les 3
	// flux depuis l'uniformisation du flux Deck (undoAddToDeck, plugin.ts) —
	// absent seulement pour un éventuel futur appelant qui n'aurait
	// vraiment aucun moyen d'annuler un ajout.
	onUndoAdd?: (
		card: ScryfallCard,
		options: AddCardOptions,
		listId: string,
		delta: number
	) => { id: string; count: number } | undefined;
	// Nom de la destination fixe (ex. "Deck 1"), affiché sur chaque tuile du
	// panneau "Add history" — seulement pour les 2 flux à destination fixe
	// (openAddCollectionCardsModal/openAddWantlistCardsModal) ; les 2 flux listGallery
	// résolvent plutôt le nom par listId depuis listGallery.summaries (la
	// destination n'y est pas fixe, elle varie tuile par tuile).
	destinationName?: string;
	titleText?: string;
	// Quelle donnée cette modale ajoute réellement — demandé explicitement,
	// pour que les tuiles du panneau "Add history" puissent ouvrir
	// ChangePrintingModal/CopyCardModal("move") sur la ligne réellement
	// ajoutée (voir renderHistoryTile, add-cards-modal.ts). Les deux n'acceptent
	// QUE "collection"/"wantlist" (aucune des deux ne connaît DeckCard — voir
	// "Data model notes" dans CLAUDE.md) : les tuiles du flux Deck
	// (sourceKind === "deck") n'affichent donc ni l'un ni l'autre lien,
	// contrairement aux 2 autres flux. Optionnel plutôt que requis : un
	// appelant qui ne le fournit pas se contente simplement de ne jamais
	// afficher ces 2 liens (comme le flux Deck), pas une erreur.
	sourceKind?: "collection" | "wantlist" | "deck";
	listGallery?: {
		summaries: (ListGroup | WantlistGroup)[];
		// ListGroup et WantlistGroup ont la même forme — rien ne permet de les
		// distinguer au runtime une fois dans ce tableau. SelectListModal en a
		// besoin pour son libellé ("+ New list" vs "+ New wantlist") et pour
		// savoir quelle modale de création ouvrir.
		kind: "list" | "wantlist";
		// Id de la liste "Inbox" (voir CollectionList.isInbox) quand fourni
		// par l'appelant (aujourd'hui : seulement openAddCardsModalWithList-
		// Picker, My Collection — jamais le flux Wantlist, qui n'a pas
		// d'équivalent). Quand défini, "Add"/"Add all" ajoutent directement
		// à cette liste au lieu d'ouvrir SelectListModal — voir
		// buildAddButton/performAddAll, add-cards-modal.ts. SelectListModal
		// reste utilisable telle quelle quand ce champ est absent (fallback
		// défensif si Inbox n'existe pas, et comportement inchangé côté
		// Wantlist).
		defaultListId?: string;
	};
}

// Piste de résultats défilante horizontalement (carousel), partagée par
// AddCardsModal (ajout de carte) et ChangePrintingModal (choix d'une autre
// version) : flèches gauche/droite + molette (par page) pour naviguer.
export function setupResultsCarousel(container: HTMLElement): HTMLElement {
	const carousel = container.createDiv({ cls: "mtg-search-carousel" });

	const leftArrow = carousel.createDiv({ cls: "mtg-search-carousel-arrow mtg-search-carousel-arrow-left" });
	setIcon(leftArrow, "chevron-left");

	const resultsEl = carousel.createDiv({ cls: "mtg-search-results" });

	const rightArrow = carousel.createDiv({ cls: "mtg-search-carousel-arrow mtg-search-carousel-arrow-right" });
	setIcon(rightArrow, "chevron-right");

	const scrollByPage = (dir: number) => {
		resultsEl.scrollBy({ left: dir * resultsEl.clientWidth, behavior: "smooth" });
	};

	// Plus rien à faire défiler dans cette direction -> pas d'effet de survol
	// (is-disabled, voir styles.css) — demandé explicitement. 2px de marge
	// plutôt qu'une égalité stricte : scrollWidth/scrollLeft/clientWidth sont
	// des valeurs flottantes en zoom fractionnel, et scroll-snap-type peut
	// laisser le point de repos réel à 1-2px de 0 plutôt que pile dessus
	// (constaté empiriquement) — une comparaison trop stricte le raterait.
	const updateArrowState = () => {
		leftArrow.toggleClass("is-disabled", resultsEl.scrollLeft <= 2);
		rightArrow.toggleClass(
			"is-disabled",
			resultsEl.scrollLeft + resultsEl.clientWidth >= resultsEl.scrollWidth - 2
		);
	};
	// "scroll" seul ne suffit pas ici : avec scroll-snap-type: x mandatory +
	// scroll-behavior: smooth (voir mtg-search-results, styles.css), l'événement
	// se déclenche à chaque frame de l'animation ET du réajustement au point
	// d'ancrage qui suit — mais la toute dernière frame, une fois le point de
	// snap réellement atteint, n'est pas garantie de porter la valeur finale
	// exacte selon le moteur (bug initialement rapporté : la flèche gauche
	// restait survolable une fois revenu à la toute première carte). "scrollend"
	// se déclenche une seule fois, une fois le défilement ET le réajustement au
	// snap totalement terminés — support natif Chromium ≥114, largement inclus
	// dans l'Electron d'Obsidian. Gardé en plus de "scroll" (pas à sa place) :
	// "scroll" garde l'affichage réactif pendant le défilement lui-même,
	// "scrollend" garantit l'état final correct une fois le mouvement retombé.
	resultsEl.addEventListener("scroll", updateArrowState, { passive: true });
	resultsEl.addEventListener("scrollend", updateArrowState, { passive: true });
	// Les tuiles sont ajoutées par l'appelant (renderResult/renderPrintingTile)
	// après le retour de cette fonction, jamais via un callback qu'elle
	// pourrait invoquer elle-même — un MutationObserver sur les enfants est
	// donc le seul point central pour retrouver un état d'activation correct
	// à chaque nouvelle recherche, sans dupliquer cette logique dans les 2
	// call sites (AddCardsModal + ChangePrintingModal). Un ResizeObserver
	// couvre en plus un redimensionnement de la fenêtre elle-même (clientWidth/
	// scrollWidth changent tous les deux, mais pas forcément dans le même
	// rapport). Ni l'un ni l'autre n'est explicitement déconnecté : resultsEl
	// est détruit avec la modale à sa fermeture, les deux observers deviennent
	// alors éligibles au GC — même raisonnement que setupCardTilt ailleurs
	// dans ce plugin (voir card-detail-fx.ts).
	new MutationObserver(updateArrowState).observe(resultsEl, { childList: true });
	new ResizeObserver(updateArrowState).observe(resultsEl);
	updateArrowState();

	leftArrow.addEventListener("click", () => scrollByPage(-1));
	rightArrow.addEventListener("click", () => scrollByPage(1));

	let wheelCooldown = false;
	resultsEl.addEventListener(
		"wheel",
		(evt) => {
			if (Math.abs(evt.deltaY) < 4 && Math.abs(evt.deltaX) < 4) return;
			evt.preventDefault();
			if (wheelCooldown) return;
			wheelCooldown = true;
			scrollByPage(evt.deltaY + evt.deltaX > 0 ? 1 : -1);
			window.setTimeout(() => {
				wheelCooldown = false;
			}, 550);
		},
		{ passive: false }
	);

	return resultsEl;
}

// Tuiles "squelette" affichées pendant le chargement (recherche en cours /
// résultats par défaut) — même structure/classes de boîte qu'une vraie tuile
// (renderScryfallResultTile ci-dessous : image ratio 5/7, footer, zone
// d'action), contenu vide et pulsant à la place. Corrige un saut visuel
// signalé : avant, un simple texte "Searching…"/"Loading recent cards…" (une
// ligne) tenait lieu de contenu pendant le chargement, donc la piste
// (mtg-search-results, sans hauteur fixe — seulement une min-height que les
// vraies tuiles dépassent largement une fois chargées, voir styles.css)
// s'affaissait puis re-grandissait d'un coup à l'arrivée des résultats.
// Réutiliser le même gabarit de boîte élimine le saut par construction (même
// hauteur des deux côtés) plutôt que de deviner/mesurer une valeur px à
// figer. `count` = le nombre de tuiles visibles à la fois dans le carrousel
// (4, voir .mtg-result-card-tile) — au-delà, le nombre exact n'a aucune
// influence sur la hauteur d'une rangée flex nowrap, seule la largeur/hauteur
// PAR tuile compte.
export function renderResultSkeletons(resultsEl: HTMLElement, count = 4) {
	for (let i = 0; i < count; i++) {
		const tile = resultsEl.createDiv({ cls: "mtg-result-card-tile mtg-result-card-tile-skeleton" });

		const imgWrap = tile.createDiv({ cls: "mtg-result-card-image-wrap" });
		// mtg-no-image hérite déjà de mtg-result-card-image son aspect-ratio
		// 5/7 (même classes que renderScryfallResultTile utilise pour une
		// carte réellement sans image) — c'est ce ratio, pas une hauteur fixe
		// devinée, qui garantit une hauteur identique à une vraie tuile quelle
		// que soit la largeur réelle du carrousel.
		imgWrap.createDiv({ cls: "mtg-result-card-image mtg-no-image mtg-skeleton-pulse" });

		const footer = tile.createDiv({ cls: "mtg-result-card-footer" });
		const footerLeft = footer.createDiv({ cls: "mtg-result-card-footer-left" });
		footerLeft.createSpan({ cls: "mtg-result-card-set-badge mtg-skeleton-pulse" });
		// Espace insécable comme texte, plutôt qu'un span vide : un élément
		// sans aucun contenu texte peut perdre la hauteur de ligne que son
		// font-size lui donnerait sinon — un espace insécable réserve cette
		// hauteur exactement comme le ferait le vrai texte ("#123"/"2.50 $")
		// une fois chargé, sans rien afficher de lisible entre-temps (color:
		// transparent, voir styles.css).
		footerLeft.createSpan({ cls: "mtg-result-card-number mtg-skeleton-pulse", text: " " });
		footer.createSpan({ cls: "mtg-result-card-price mtg-skeleton-pulse", text: " " });

		const addControl = tile.createDiv({ cls: "mtg-result-card-add-control" });
		addControl.createDiv({ cls: "mtg-result-card-add-btn mtg-skeleton-pulse", text: " " });
	}
}

/* -------------------------------------------------------------------------- */
/*  Sortie/entrée animées des tuiles de résultat (AddCardsModal uniquement — */
/*  ChangePrintingModal charge une seule fois par ouverture, pas à chaque    */
/*  frappe, donc rien à animer là-bas)                                       */
/* -------------------------------------------------------------------------- */

// Nombre de tuiles réellement visibles à la fois dans le carrousel (voir
// .mtg-result-card-tile — "exactement 4 cartes visibles") : au-delà, une
// tuile est hors champ au moment de la transition, pas la peine de
// l'animer — ni à la sortie (animateResultTilesOut) ni à l'entrée
// (applyResultTileStaggerEntrance), qui partagent cette même limite.
const RESULT_TILE_STAGGER_MAX = 4;
// ×2.5 (étaient 40ms/180ms) — demandé explicitement ("2x à 3x plus lent"),
// milieu de la fourchette. RESULT_TILE_EXIT_TRANSITION_MS doit rester égal
// à la durée de transition déclarée sur .mtg-result-card-tile dans
// styles.css (0.45s) — les deux pilotent la même animation depuis deux
// endroits différents (délai JS entre tuiles + durée CSS par tuile), et
// doivent donc être changés ensemble.
const RESULT_TILE_STAGGER_DELAY_MS = 100;
const RESULT_TILE_EXIT_TRANSITION_MS = 450;

// Anime la sortie des tuiles ACTUELLEMENT affichées (fondu + léger
// glissement, décalées de gauche à droite — ordre DOM = ordre visuel dans
// le carrousel) avant qu'un nouveau lot ne les remplace — demandé
// explicitement, plutôt qu'un remplacement instantané. Résout une fois
// l'animation terminée (immédiatement s'il n'y avait rien à animer) ; rien
// n'attend cette Promise dans l'usage principal (AddCardsModal.
// triggerSearch, fire-and-forget — voir son propre commentaire), mais la
// garder disponible en Promise laisse un futur appelant enchaîner dessus
// sans changer la signature plus tard.
export function animateResultTilesOut(resultsEl: HTMLElement): Promise<void> {
	const tiles = Array.from(resultsEl.children).slice(0, RESULT_TILE_STAGGER_MAX) as HTMLElement[];
	if (tiles.length === 0) return Promise.resolve();
	tiles.forEach((tile, i) => {
		window.setTimeout(() => tile.addClass("mtg-result-tile-exit"), i * RESULT_TILE_STAGGER_DELAY_MS);
	});
	const totalMs = (tiles.length - 1) * RESULT_TILE_STAGGER_DELAY_MS + RESULT_TILE_EXIT_TRANSITION_MS;
	return new Promise((resolve) => window.setTimeout(resolve, totalMs));
}

// Réapparition en vague d'une tuile fraîchement insérée, décalée de gauche à
// droite selon son index parmi le lot de résultats — même idiome que
// CopyCardModal.revealTile/tileStaggerIndex (voir CLAUDE.md) : la tuile
// démarre masquée (mtg-result-tile-enter, posée ici avant tout paint
// puisqu'appelée juste après renderScryfallResultTile) puis
// mtg-result-tile-visible est ajoutée après un délai croissant, ce qui
// laisse au navigateur une image "départ" (masquée) distincte de l'arrivée
// à animer — sans ce délai initial, rien n'aurait de transition à jouer.
export function applyResultTileStaggerEntrance(tile: HTMLElement, index: number) {
	if (index >= RESULT_TILE_STAGGER_MAX) return;
	tile.addClass("mtg-result-tile-enter");
	window.setTimeout(() => tile.addClass("mtg-result-tile-visible"), index * RESULT_TILE_STAGGER_DELAY_MS);
}

// Tuile "carte" d'un résultat (image + symbole d'édition teinté selon la
// rareté / numéro / prix), avec une zone d'action laissée au call site :
// bouton "Add" pour la recherche d'ajout, "Select"/"Current" pour le choix
// d'impression. "caption" (nom de l'édition en toutes lettres) n'est utile
// que pour ce second cas — plusieurs éditions du même nom existent parfois
// dans des produits différents, le code seul ne suffit pas à les distinguer.
export function renderScryfallResultTile(
	plugin: MTGCollectionPlugin,
	resultsEl: HTMLElement,
	card: ScryfallCard,
	renderAction: (tile: HTMLElement) => void,
	caption?: string
): HTMLElement {
	const tile = resultsEl.createDiv({ cls: "mtg-result-card-tile" });

	const imgWrap = tile.createDiv({ cls: "mtg-result-card-image-wrap" });
	const img = getImageUrl(card);
	if (img) {
		imgWrap.createEl("img", { cls: "mtg-result-card-image", attr: { src: img, loading: "lazy" } });
	} else {
		imgWrap.createDiv({ cls: "mtg-result-card-image mtg-no-image" });
	}

	if (caption) {
		tile.createDiv({ cls: "mtg-result-card-caption", text: caption });
	}

	const footer = tile.createDiv({ cls: "mtg-result-card-footer" });

	// Gauche : symbole d'édition teinté selon la rareté + numéro de collection.
	const footerLeft = footer.createDiv({ cls: "mtg-result-card-footer-left" });
	const setBadge = footerLeft.createDiv({ cls: "mtg-result-card-set-badge" });
	// Ne demande l'icône (getSetIconSvg, plugin.ts) qu'une fois la tuile
	// visible — ou sur le point de l'être, rootMargin donne une marge de
	// pré-chargement dans le sens du défilement pour éviter un flash d'icône
	// manquante au moment où elle apparaît — dans la piste défilante, pas dès
	// le rendu initial. getSetIconSvg sérialise déjà les nouveaux fetches
	// (voir setIconFetchQueue, plugin.ts), mais un carrousel de 175 résultats
	// n'a de toute façon aucune raison de réclamer l'icône des ~170 tuiles
	// hors champ dès l'ouverture — cette garde réduit directement la taille
	// de la rafale initiale, en plus de la file d'attente qui protège tous
	// les autres appelants (listes/grilles, panneaux de détail, etc.). `root:
	// resultsEl` (pas la fenêtre) : l'intersection doit être calculée par
	// rapport à la piste elle-même, seul élément qui défile réellement ici.
	const io = new IntersectionObserver(
		(entries) => {
			if (!entries.some((e) => e.isIntersecting)) return;
			io.disconnect();
			void plugin.getSetIconSvg(card.set).then((svg) => {
				if (!svg) {
					setBadge.remove();
					return;
				}
				setSvgMarkup(setBadge, svg);
				const svgEl = setBadge.querySelector("svg");
				if (svgEl) {
					svgEl.setAttribute("width", "16");
					svgEl.setAttribute("height", "16");
				}
				applySvgColor(setBadge, getRarityColor(card.rarity));
			});
		},
		{ root: resultsEl, rootMargin: "0px 300px 0px 300px" }
	);
	io.observe(tile);
	footerLeft.createSpan({
		cls: "mtg-result-card-number",
		text: `#${card.collector_number}`,
	});

	// Droite : dernier prix enregistré par Scryfall.
	footer.createSpan({
		cls: "mtg-result-card-price",
		text: formatScryfallPrice(card, plugin.settings.priceCurrency) || "—",
	});

	renderAction(tile);
	return tile;
}
