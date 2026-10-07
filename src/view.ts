import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type MTGCollectionPlugin from "./plugin";
import {
	CollectionCard,
	WantlistCard,
} from "./core/card-model";
import {
	CardViewMode,
	GroupByOption,
	SortByOption,
	CardGroup,
	RENDER_BATCH_SIZE,
} from "./core/card-sorting";
import {
	DeckCard,
	DeckBoardTab,
	VIEW_TYPE_MTG_COLLECTION,
} from "./core/data-model";
import { NewDeckModal, NewListModal, NewWantlistModal } from "./modals/new-entity-modals";
import * as sharedRenderHelpers from "./view/shared-render-helpers";
import * as filterChips from "./view/filter-chips";
import * as groupSortBar from "./view/group-sort-bar";
import * as groupCollapse from "./view/group-collapse";
import * as cardThumbnails from "./view/card-thumbnails";
import * as downloads from "./view/downloads";
import * as homeRender from "./view/home-render";
import * as collectionRender from "./view/collection-render";
import * as deckRender from "./view/deck-render";
import * as wantlistRender from "./view/wantlist-render";
import * as mobileBars from "./view/mobile-bars";

export class MTGCollectionView extends ItemView {
	plugin: MTGCollectionPlugin;
	mainEl!: HTMLElement;
	backToTopBtn!: HTMLElement;
	bodyEl!: HTMLElement;
	collectionHeaderEl!: HTMLElement;
	headerTitleEl!: HTMLElement;
	headerStatsEl!: HTMLElement;
	// Rangée épinglée "Inbox"/"All Cards" de la grille My Collection — voir
	// son commentaire à la création (onOpen) et renderListGrid.
	collectionPinnedEl!: HTMLElement;
	collectionToolbarEl!: HTMLElement;
	decksToolbarEl!: HTMLElement;
	wantlistsToolbarEl!: HTMLElement;
	newListBtn!: HTMLElement;
	newDeckBtn!: HTMLElement;
	newWantlistBtn!: HTMLElement;
	listGallerySelectBtn!: HTMLElement;
	deckGallerySelectBtn!: HTMLElement;
	wantlistGallerySelectBtn!: HTMLElement;
	filterEl!: HTMLInputElement;
	deckFilterEl!: HTMLInputElement;
	wantlistFilterEl!: HTMLInputElement;
	navHomeBtn!: HTMLElement;
	navCollectionBtn!: HTMLElement;
	navDecksBtn!: HTMLElement;
	navWantlistsBtn!: HTMLElement;
	navEl!: HTMLElement;
	navIndicatorEl!: HTMLElement;
	private navIndicatorPlaced = false;

	// Place la capsule sur l'item actif. Sans transition au tout premier placement (et quand la nav est
	// masquée, offsetWidth = 0) pour qu'elle n'arrive pas en glissant depuis le coin de la pilule.
	updateNavIndicator(animate = true) {
		const active = this.navEl?.querySelector<HTMLElement>(".mtg-nav-item.is-active");
		if (!active || !this.navIndicatorEl || active.offsetWidth === 0) {
			this.navIndicatorPlaced = false;
			return;
		}
		const el = this.navIndicatorEl;
		el.toggleClass("is-instant", !animate || !this.navIndicatorPlaced);
		// getBoundingClientRect (pas offsetLeft/Width, arrondis à l'entier) : la capsule reste alignée au
		// sous-pixel près sur l'item.
		const a = active.getBoundingClientRect();
		const n = this.navEl.getBoundingClientRect();
		el.style.width = `${a.width}px`;
		el.style.height = `${a.height}px`;
		el.style.transform = `translate(${a.left - n.left}px, ${a.top - n.top}px)`;
		this.navIndicatorPlaced = true;
	}
	// Aperçu flottant au survol du nom d'une carte en mode Tableau — voir
	// showCardNamePreview/hideCardNamePreview et le commentaire sur
	// .mtg-card-name-preview (styles.css) pour le raisonnement complet.
	cardNamePreviewEl!: HTMLElement;
	cardNamePreviewImgEl!: HTMLImageElement;

	activeSection: "home" | "collection" | "decks" | "wantlists" = "home";
	// "Voir plus" du bloc Market Trends de Home (2026-09-23, top 5 → top 20,
	// voir renderHomeMarketTrends) : sur la VUE plutôt qu'en variable locale
	// de la fermeture comme period/vendor l'étaient (eux sont désormais dans
	// les réglages, voir MTGCollectionSettings.homeMoversPeriod) — Home est
	// reconstruit en entier à chaque render() (vue ouverte/fermée, modale qui
	// modifie des données...), et une liste dépliée qui se replie toute seule
	// à cause d'un re-rendu sans rapport serait pénible. Pas persisté sur
	// disque : un dépliage est un choix de session, pas une préférence.
	homeMoversExpanded = false;
	// Désabonnement de la ligne d'état GitHub de Home (une seule à la fois : chaque rendu de Home remplace la précédente).
	homeSyncUnsub: (() => void) | null = null;
	openListId: string | null = null;
	openDeckId: string | null = null;
	openWantlistId: string | null = null;
	// Identifie "où" on se trouve (section + liste/deck/wantlist ouvert) au
	// dernier render() : sert à ne PAS conserver le défilement d'une vue
	// quand on change de vue.
	lastRenderedViewKey: string | null = null;

	// Nombre de lignes actuellement rendues dans chaque liste (voir
	// RENDER_BATCH_SIZE) : remis à la valeur de départ à chaque changement de
	// contexte (ouverture d'une autre liste, filtre, tri, groupement...) pour
	// ne jamais repartir d'une limite déjà agrandie par une session de
	// défilement précédente.
	listRenderLimit = RENDER_BATCH_SIZE;
	deckRenderLimit = RENDER_BATCH_SIZE;
	wantlistRenderLimit = RENDER_BATCH_SIZE;
	// "Signature" du contexte affiché la dernière fois (liste ouverte, filtre,
	// tri, groupement, mode d'affichage) : comparée à chaque rendu pour
	// détecter un changement de contexte et remettre la limite de rendu à
	// zéro, sans avoir à instrumenter individuellement chaque déclencheur
	// possible (frappe dans le filtre, clic sur trier/grouper...).
	// "Charger plus" via le défilement ne change, lui, aucun de ces éléments
	// — la limite déjà agrandie survit donc correctement au re-rendu qu'il
	// déclenche.
	lastListRenderSignature: string | null = null;
	lastDeckRenderSignature: string | null = null;
	lastWantlistRenderSignature: string | null = null;

	// Cache du résultat de groupAndSortCards (tri + regroupement), coûteux à
	// refaire sur une grosse collection : un "charger plus" au défilement ne
	// change ni le filtre, ni le tri, ni le groupement, ni les données elles-
	// mêmes (this.plugin.dataVersion), donc rien ne justifie de recalculer —
	// seule sliceGroupsForRender doit refaire son travail, avec une nouvelle
	// limite. La signature ici inclut dataVersion (contrairement à
	// lastXRenderSignature ci-dessus, qui ne sert qu'à réinitialiser la
	// limite d'affichage) : une mutation ailleurs (changer une quantité...)
	// doit invalider ce cache sans pour autant réduire ce qui est déjà
	// affiché.
	cachedListCardGroups: CardGroup<CollectionCard>[] | null = null;
	lastListDataSignature: string | null = null;
	cachedDeckCardGroups: CardGroup<DeckCard>[] | null = null;
	lastDeckDataSignature: string | null = null;
	cachedWantlistCardGroups: CardGroup<WantlistCard>[] | null = null;
	lastWantlistDataSignature: string | null = null;

	// Cache des éléments DOM de chaque ligne de carte (contenu de
	// .mtg-card-row, pas son .mtg-card-row-outer — celui-ci reste toujours
	// reconstruit à neuf, voir renderListDetail, car il porte l'état de
	// pliage de groupe manipulé directement par toggleGroupRows). render()
	// reconstruit tout le corps à chaque interaction (frappe dans le filtre,
	// case cochée...) même quand la grande majorité des lignes déjà chargées
	// n'ont, elles, pas changé — sur une collection de 10 000 cartes après un
	// défilement profond, refaire ce travail (icônes async, écouteurs...)
	// pour des centaines/milliers de lignes identiques à chaque frappe
	// devient sensible. Une ligne est réutilisée telle quelle si sa
	// "signature" (voir collectionCardRowSignature) n'a pas changé depuis le dernier
	// rendu ; sinon reconstruite et le cache mis à jour. Purgé en fin de
	// rendu des entrées qui ne correspondent plus au filtre courant, pour ne
	// pas grossir sans borne au fil d'une session avec beaucoup de filtres
	// différents.
	cachedListRowElements: Map<string, { signature: string; el: HTMLElement }> = new Map();
	// Toujours à jour au moment du clic (contrairement à une variable locale
	// capturée par la fermeture du gestionnaire de clic d'une ligne réutilisée
	// depuis un rendu précédent, qui référencerait alors un navOrder périmé —
	// voir buildCollectionCardRow).
	navOrderForListClick: CollectionCard[] = [];
	// Même principe que cachedListRowElements/navOrderForListClick, pour Decks et
	// Wantlists. Clé composite deckId:scryfallId (pas juste scryfallId) pour
	// Decks : la même carte peut apparaître dans plusieurs decks distincts,
	// avec un statut owned/quantité qui leur est propre.
	cachedDeckRowElements: Map<string, { signature: string; el: HTMLElement }> = new Map();
	navOrderForDeckClick: DeckCard[] = [];
	cachedWantlistRowElements: Map<string, { signature: string; el: HTMLElement }> = new Map();
	navOrderForWantlistClick: WantlistCard[] = [];

	listGroupBy: GroupByOption = "none";
	listSortBy: SortByOption = "name";
	sortReverse = false;
	groupReverse = false;
	listViewMode: CardViewMode = "list";

	deckGroupBy: GroupByOption = "none";
	deckSortBy: SortByOption = "name";
	deckSortReverse = false;
	deckGroupReverse = false;
	deckViewMode: CardViewMode = "list";
	// Onglet "board" actif au-dessus de la liste des cartes d'un deck (voir
	// renderDeckBoardTabs, src/view/deck-render.ts) — global comme le reste de l'état
	// d'affichage de My Decks ci-dessus, pas propre à un deck précis.
	deckActiveBoard: DeckBoardTab = "mainboard";
	// Id de la carte glissée dans la vue Stacks (renderDeckStacksView,
	// src/view/deck-render.ts, 2026-09-12) — lu directement depuis ce champ
	// plutôt que via dataTransfer.getData() pendant "dragover" : la norme
	// HTML5 drag-and-drop n'expose la vraie valeur transportée que dans le
	// handler "drop" lui-même (restriction de sécurité standard, pas un
	// bug), donc un champ d'instance est le seul moyen fiable de savoir,
	// pendant le survol d'une pile, quelle carte est en train d'être
	// déposée.
	draggingDeckStackCardId: string | null = null;

	wantlistGroupBy: GroupByOption = "none";
	wantlistSortBy: SortByOption = "name";
	wantlistSortReverse = false;
	wantlistGroupReverse = false;
	wantlistViewMode: CardViewMode = "list";

	listCardFilterTokens: string[] = [];
	listCardFilterDraft = "";
	deckCardFilterTokens: string[] = [];
	deckCardFilterDraft = "";
	wantlistCardFilterTokens: string[] = [];
	wantlistCardFilterDraft = "";
	lastFocusedFilterKey: string | null = null;
	lastFocusedFilterCursor: number | null = null;
	// Renseigné par renderChipFilter (construit hors DOM, avant l'échange
	// atomique de render()) et exécuté par render() juste après l'échange,
	// dans le même passage synchrone — restaurer le focus via setTimeout()
	// laissait une brève fenêtre sans aucun élément focus (l'ancien vient
	// d'être détaché, le nouveau ne l'est pas encore) : une frappe tombant
	// pile dans cette fenêtre était perdue, ce qui donnait l'impression de
	// ne "parfois" plus pouvoir taper du tout.
	pendingFocusRestore: (() => void) | null = null;
	// Debounce du render() déclenché par la frappe dans un filtre texte : le
	// filtrage tourne sur la liste/deck/wantlist ENTIÈRE (pas seulement la
	// portion actuellement affichée), et render() reconstruit tout le DOM
	// chargé jusque-là — sur une collection de 10 000 cartes, appeler ça à
	// chaque touche pressée devient sensible. Ne retarde que le render() lui-
	// même : onDraftChange() reste synchrone (mise à jour d'état immédiate,
	// peu coûteuse), donc taper puis valider tout de suite (Entrée, espace)
	// voit toujours le dernier caractère tapé. L'input lui-même n'est jamais
	// démonté pendant le délai (aucun DOM reconstruit tant que le minuteur
	// n'a pas déclenché), donc pas de risque de perdre le focus au milieu
	// d'une frappe — contrairement à un debounce qui aurait porté sur la
	// restauration du focus elle-même (voir pendingFocusRestore ci-dessus).
	filterRenderDebounceTimer: number | null = null;
	suggestionHighlightIndex = -1;
	listCollapsedGroups: Set<string> = new Set();
	lastRenderedListGroupLabels: string[] = [];
	deckCollapsedGroups: Set<string> = new Set();
	lastRenderedDeckGroupLabels: string[] = [];
	wantlistCollapsedGroups: Set<string> = new Set();
	lastRenderedWantlistGroupLabels: string[] = [];

	selectedListCardIds: Set<string> = new Set();
	listSelectMode = false;
	selectedDeckCardIds: Set<string> = new Set();
	deckSelectMode = false;
	selectedWantlistCardIds: Set<string> = new Set();
	wantlistSelectMode = false;
	listBulkBarWasVisible = false;
	deckBulkBarWasVisible = false;
	wantlistBulkBarWasVisible = false;
	// Position de défilement de la barre d'actions du mode Sélection, PAR type de barre (clé
	// = `kind` de createBulkActionsBar : "list-cards", "deck-gallery"…). La barre est
	// reconstruite à chaque render() ; sans ça, chaque tap de sélection ou action appliquée la
	// ramènerait à gauche. Une clé par barre et pas un champ unique : le mode Sélection d'une
	// section peut rester actif pendant qu'on visite une autre, et sa barre (qui ne repart donc
	// pas de 0, `animate` étant faux) hériterait alors de la position d'une barre sans rapport.
	bulkBarScrollLeft: Map<string, number> = new Map();

	// Mode sélection "galerie" — un cran au-dessus de selectMode/
	// deckSelectMode/wantlistSelectMode ci-dessus : ceux-ci sélectionnent des
	// CARTES à l'intérieur d'une liste/deck/wantlist déjà ouvert(e), celui-ci
	// sélectionne des LISTES/DECKS/WANTLISTS entières depuis la grille de
	// présentation (avant ouverture). États totalement indépendants — les
	// deux peuvent coexister sans conflit puisqu'ils ne sont jamais actifs au
	// même endroit de l'écran (la grille n'affiche jamais les boutons "+
	// Add cards"/select-cartes d'une liste ouverte, et inversement).
	listGallerySelectMode = false;
	selectedListIds: Set<string> = new Set();
	deckGallerySelectMode = false;
	selectedDeckIds: Set<string> = new Set();
	wantlistGallerySelectMode = false;
	selectedWantlistIds: Set<string> = new Set();
	listGalleryBulkBarWasVisible = false;
	deckGalleryBulkBarWasVisible = false;
	wantlistGalleryBulkBarWasVisible = false;
	// Champs déplacés depuis la zone des méthodes lors du découpage Phase 5b (2026-09-10)
	// -- restent des champs d'instance réels, juste relocalisés ici pour rester groupés avec les autres.
	tableFadeTimeouts = new WeakMap<HTMLElement, number>();
	groupCollapseTimeouts = new WeakMap<HTMLElement, number>();

	constructor(leaf: WorkspaceLeaf, plugin: MTGCollectionPlugin) {
		super(leaf);
		this.plugin = plugin;
	}


	getViewType() {
		return VIEW_TYPE_MTG_COLLECTION;
	}


	getDisplayText() {
		return "MTG Collection";
	}


	getIcon() {
		return "library";
	}


	applyAccentColor() {
		if (this.plugin.settings.accentColor) {
			this.containerEl.style.setProperty("--mtg-accent", this.plugin.settings.accentColor);
		} else {
			this.containerEl.style.removeProperty("--mtg-accent");
		}
	}


	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("mtg-collection-view");
		this.applyAccentColor();

		this.listGroupBy = this.plugin.settings.collectionGroupBy;
		this.listSortBy = this.plugin.settings.collectionSortBy;
		this.sortReverse = this.plugin.settings.collectionSortReverse;
		this.groupReverse = this.plugin.settings.collectionGroupReverse;
		this.listViewMode = this.plugin.settings.collectionViewMode;
		// "category" (jamais réécrit en dur nulle part, `as GroupByOption` pour
		// le comparer malgré tout) : ancienne valeur persistée par une session
		// antérieure à ce même 2026-09-07 (retirée de GroupByOption, voir
		// card-sorting.ts) — repliée sur "none" au chargement plutôt que
		// laissée telle quelle, ce qui afficherait un "Group by " sans libellé
		// et grouperait tout sous une étiquette vide (default: return "" dans
		// groupSortValue/groupLabelFor). Un choix utilisateur normal ne peut
		// plus jamais produire cette valeur, donc ce repli ne s'exécute
		// concrètement qu'une fois par vault.
		const loadedDeckGroupBy = this.plugin.settings.deckGroupBy;
		this.deckGroupBy = (loadedDeckGroupBy as GroupByOption | "category") === "category" ? "none" : loadedDeckGroupBy;
		this.deckSortBy = this.plugin.settings.deckSortBy;
		this.deckSortReverse = this.plugin.settings.deckSortReverse;
		this.deckGroupReverse = this.plugin.settings.deckGroupReverse;
		this.deckViewMode = this.plugin.settings.deckViewMode;
		this.deckActiveBoard = this.plugin.settings.deckActiveBoard;
		this.wantlistGroupBy = this.plugin.settings.wantlistGroupBy;
		this.wantlistSortBy = this.plugin.settings.wantlistSortBy;
		this.wantlistSortReverse = this.plugin.settings.wantlistSortReverse;
		this.wantlistGroupReverse = this.plugin.settings.wantlistGroupReverse;
		this.wantlistViewMode = this.plugin.settings.wantlistViewMode;

		const layout = container.createDiv({ cls: "mtg-layout" });

		/* ---- Side nav ---- */
		const nav = layout.createDiv({ cls: "mtg-nav" });
		this.navEl = nav;
		if (this.plugin.settings.navCollapsed) nav.addClass("is-collapsed");

		const toggleRow = nav.createDiv({ cls: "mtg-nav-toggle-row" });
		const toggleBtn = toggleRow.createDiv({ cls: "mtg-nav-toggle" });
		const renderToggleIcon = () =>
			setIcon(
				toggleBtn,
				this.plugin.settings.navCollapsed ? "panel-left-open" : "panel-left-close"
			);
		renderToggleIcon();
		toggleBtn.setAttribute("title", "Collapse/expand menu");
		const toggleNav = async () => {
			this.plugin.settings.navCollapsed = !this.plugin.settings.navCollapsed;
			nav.toggleClass("is-collapsed", this.plugin.settings.navCollapsed);
			renderToggleIcon();
			await this.plugin.saveSettings();
		};
		toggleBtn.addEventListener("click", () => void toggleNav());

		// Capsule qui glisse derrière l'item actif (téléphone seulement, masquée ailleurs en CSS) : un seul
		// élément déplacé par left/width plutôt qu'un fond par item, sinon rien à animer entre deux items.
		this.navIndicatorEl = nav.createDiv({ cls: "mtg-nav-indicator" });
		new ResizeObserver(() => this.updateNavIndicator(false)).observe(nav);

		const makeNavItem = (icon: string, label: string) => {
			const item = nav.createDiv({ cls: "mtg-nav-item" });
			item.setAttribute("title", label);
			const iconEl = item.createSpan({ cls: "mtg-nav-icon" });
			setIcon(iconEl, icon);
			item.createSpan({ cls: "mtg-nav-label", text: label });
			return item;
		};

		this.navHomeBtn = makeNavItem("home", "Home");
		this.navHomeBtn.addEventListener("click", () => {
			this.activeSection = "home";
			this.render();
		});

		this.navCollectionBtn = makeNavItem("layers", "Collection");
		this.navCollectionBtn.addEventListener("click", () => {
			this.activeSection = "collection";
			this.render();
		});

		this.navDecksBtn = makeNavItem("swords", "Decks");
		this.navDecksBtn.addEventListener("click", () => {
			this.activeSection = "decks";
			this.render();
		});

		this.navWantlistsBtn = makeNavItem("heart", "Wantlists");
		this.navWantlistsBtn.addEventListener("click", () => {
			this.activeSection = "wantlists";
			this.render();
		});

		nav.createDiv({ cls: "mtg-nav-divider" });

		// mtg-nav-item-settings : classe dédiée (en plus de mtg-nav-item) pour que .is-phone .mtg-nav
		// puisse cacher CE bouton précis sans toucher aux 4 autres — voir styles.css.
		const navSettings = makeNavItem("settings", "Settings");
		navSettings.addClass("mtg-nav-item-settings");
		navSettings.addEventListener("click", () => this.openPluginSettings());

		// Barres d'Obsidian sur téléphone (la barre flottante du bas et le .view-header du haut) : masquées
		// tant que cette vue est active ET que settings.hideObsidianMobileBars est vrai — voir
		// src/view/mobile-bars.ts et le réglage "Hide Obsidian's mobile bars" (Interface, setting-tab.ts).
		// Plus de bouton dédié dans la rampe depuis 2026-09-27 (voir mobile-bars.ts) : la pilule flottante du
		// menu sur téléphone n'a de la place que pour les 5 items ci-dessus.
		this.setupMobileBars();

		/* ---- Main area ---- */
		const main = layout.createDiv({ cls: "mtg-main" });
		this.mainEl = main;

		// Enfant de layout (pas de main) : main défile en interne
		// (overflow-y:auto), donc un position:absolute posé DEDANS se
		// positionnerait par rapport à toute la hauteur défilable du contenu,
		// pas par rapport à la zone visible — le bouton se retrouverait hors
		// champ selon la position de défilement au lieu de rester fixé dans le
		// coin. layout, lui, ne défile jamais (seul main défile en son sein,
		// voir .mtg-layout/.mtg-main dans styles.css), donc un enfant positionné
		// en absolu par rapport à layout (position:relative) reste visuellement
		// fixé dans le coin quelle que soit la position de défilement de main.
		this.backToTopBtn = layout.createDiv({ cls: "mtg-back-to-top-btn" });
		setIcon(this.backToTopBtn, "arrow-up");
		this.backToTopBtn.setAttribute("title", "Back to top");
		// getActiveScrollEl() plutôt que main directement : depuis l'ajout de
		// .mtg-detail-scroll-area (voir son propre commentaire dans styles.css
		// et handleScrollAreaScroll, src/view/shared-render-helpers.ts), c'est CETTE zone-là qui défile
		// réellement une fois une liste/un deck/une wantlist ouvert(e), pas
		// main lui-même — résolu au moment du clic, pas à l'enregistrement
		// (fixe, ce dernier ne verrait jamais la bonne zone une fois le mode
		// changé).
		this.backToTopBtn.addEventListener("click", () => {
			this.getActiveScrollEl().scrollTo({ top: 0, behavior: "smooth" });
		});
		// Un seul listener pour toute la durée de vie de la vue — main est un
		// élément persistant (jamais détruit/reconstruit, contrairement à
		// this.bodyEl plus bas), donc pas besoin de le rattacher à chaque
		// render(). Générique (n'importe quelle section/vue), pas seulement le
		// détail d'une liste — une grille avec beaucoup de lignes peut tout
		// autant justifier ce raccourci. L'aperçu de nom de carte (mode
		// Tableau) profite du même listener plutôt que d'en ajouter un
		// second : sa position est calculée une fois à l'ouverture (voir
		// showCardNamePreview) et ne suit pas le défilement, donc le
		// masquer ici évite qu'il reste figé au-dessus d'une ligne qui a
		// bougé sous lui. Ne fait jamais rien tant qu'une vue de détail est
		// ouverte : main lui-même ne déborde alors plus jamais (voir
		// .mtg-collection-body-detail) — handleScrollAreaScroll couvre ce cas
		// séparément, rattaché à .mtg-detail-scroll-area à chaque render().
		main.addEventListener("scroll", () => this.handleScrollAreaScroll(main));
		// Même raisonnement pour le radius responsive de la vue Carte — voir
		// setupCardTileRadiusObserver.
		this.setupCardTileRadiusObserver();
		// Même raisonnement encore, pour la répartition en pistes de la vue
		// Stacks (My Decks) — voir setupDeckStacksLayoutObserver,
		// src/view/deck-render.ts.
		this.setupDeckStacksLayoutObserver();

		// Élément persistant unique (jamais recréé) — voir le commentaire sur
		// .mtg-card-name-preview (styles.css) pour le raisonnement complet
		// (position:fixed, ajouté à document.body plutôt qu'à un ancêtre du
		// plugin, même précédent que .mtg-picker-menu/openPickerMenu).
		this.cardNamePreviewEl = document.body.createDiv({ cls: "mtg-card-name-preview" });
		this.cardNamePreviewImgEl = this.cardNamePreviewEl.createEl("img");

		const header = main.createDiv({ cls: "mtg-collection-header mtg-deck-title-row" });
		this.collectionHeaderEl = header;
		const headerTitleInfo = header.createDiv({ cls: "mtg-title-info" });
		this.headerTitleEl = headerTitleInfo.createEl("h3", { cls: "mtg-detail-title" });
		this.headerStatsEl = headerTitleInfo.createDiv({
			cls: "mtg-collection-stats mtg-detail-title-stats",
		});
		// Boutons "+ New X" de la grille (My Collection/My Decks/My
		// Wantlists), chacun suivi de son propre bouton "Select" — demandé
		// explicitement à droite de "+ New X" (l'ordre inverse d'ici a été
		// essayé en premier, corrigé sur retour). Les deux partagent déjà la
		// même hauteur (34px, mtg-search-add-btn / mtg-tile-menu-btn-large) et
		// le même parent flex à align-items:center (mtg-deck-title-row), donc
		// aucun CSS supplémentaire n'était nécessaire pour les centrer
		// verticalement l'un par rapport à l'autre — déjà garanti par cette
		// mise en page existante. Même icône/bascule (square-mouse-pointer ↔
		// x) que selectModeBtn (une variable locale à l'intérieur de
		// renderListDetail/etc., src/view/collection-render.ts — sélection de
		// CARTES à l'intérieur d'une liste déjà ouverte), juste un cran plus haut dans la
		// hiérarchie. Éléments persistants (comme newListBtn etc.) : leur
		// icône/état actif est resynchronisé à chaque render() plutôt que
		// reconstruit, voir syncGallerySelectBtn.
		this.newListBtn = header.createEl("button", {
			text: "+ New list",
			cls: "mtg-search-add-btn",
		});
		this.newListBtn.addEventListener("click", () => {
			new NewListModal(this.app, this.plugin, (list) => {
				this.openListId = list.id;
				this.render();
			}).open();
		});
		this.listGallerySelectBtn = header.createDiv({
			cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
		});
		this.listGallerySelectBtn.addEventListener("click", () => {
			this.listGallerySelectMode = !this.listGallerySelectMode;
			if (!this.listGallerySelectMode) {
				this.selectedListIds.clear();
				this.listGalleryBulkBarWasVisible = false;
			}
			this.render();
		});
		this.newDeckBtn = header.createEl("button", {
			text: "+ New deck",
			cls: "mtg-search-add-btn",
		});
		this.newDeckBtn.addEventListener("click", () => {
			new NewDeckModal(this.app, this.plugin, (deck) => {
				this.openDeckId = deck.id;
				this.render();
			}).open();
		});
		this.deckGallerySelectBtn = header.createDiv({
			cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
		});
		this.deckGallerySelectBtn.addEventListener("click", () => {
			this.deckGallerySelectMode = !this.deckGallerySelectMode;
			if (!this.deckGallerySelectMode) {
				this.selectedDeckIds.clear();
				this.deckGalleryBulkBarWasVisible = false;
			}
			this.render();
		});
		this.newWantlistBtn = header.createEl("button", {
			text: "+ New wantlist",
			cls: "mtg-search-add-btn",
		});
		this.newWantlistBtn.addEventListener("click", () => {
			new NewWantlistModal(this.app, this.plugin, (wantlist) => {
				this.openWantlistId = wantlist.id;
				this.render();
			}).open();
		});
		this.wantlistGallerySelectBtn = header.createDiv({
			cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
		});
		this.wantlistGallerySelectBtn.addEventListener("click", () => {
			this.wantlistGallerySelectMode = !this.wantlistGallerySelectMode;
			if (!this.wantlistGallerySelectMode) {
				this.selectedWantlistIds.clear();
				this.wantlistGalleryBulkBarWasVisible = false;
			}
			this.render();
		});

		// Rangée épinglée "Inbox"/"All Cards" de My Collection (remplie par
		// renderListGrid) — placée AVANT la barre de filtre ci-dessous, demandé
		// explicitement (la recherche et le tri passent après ces deux
		// tuiles). C'est cette rangée qui monte au-dessus de la barre, pas
		// l'inverse : la barre de filtre est un élément persistant que
		// render() ne reconstruit jamais (sa saisie perdrait le focus, et une
		// composition IME/touche morte serait annulée, à chaque frappe), alors
		// que celle-ci est reconstruite à chaque render(), par le même
		// échange détaché que this.bodyEl — voir render().
		this.collectionPinnedEl = main.createDiv({ cls: "mtg-collection-pinned" });

		// Toolbar "My Collection" : filtre
		this.collectionToolbarEl = main.createDiv({ cls: "mtg-collection-toolbar" });
		const filterWrap = this.collectionToolbarEl.createDiv({ cls: "mtg-filter-chip-row" });
		const filterInner = filterWrap.createDiv({ cls: "mtg-filter-chip-row-inner" });
		this.filterEl = filterInner.createEl("input", {
			cls: "mtg-filter-chip-input",
			type: "text",
			placeholder: "Filter by name or list…",
		});
		this.filterEl.addEventListener("input", () => this.render());

		// Toolbar "My Decks" : filtre
		this.decksToolbarEl = main.createDiv({ cls: "mtg-collection-toolbar" });
		const deckFilterWrap = this.decksToolbarEl.createDiv({ cls: "mtg-filter-chip-row" });
		const deckFilterInner = deckFilterWrap.createDiv({ cls: "mtg-filter-chip-row-inner" });
		this.deckFilterEl = deckFilterInner.createEl("input", {
			cls: "mtg-filter-chip-input",
			type: "text",
			placeholder: "Filter decks…",
		});
		this.deckFilterEl.addEventListener("input", () => this.render());

		// Toolbar "My Wantlists" : filtre
		this.wantlistsToolbarEl = main.createDiv({ cls: "mtg-collection-toolbar" });
		const wantlistFilterWrap = this.wantlistsToolbarEl.createDiv({ cls: "mtg-filter-chip-row" });
		const wantlistFilterInner = wantlistFilterWrap.createDiv({ cls: "mtg-filter-chip-row-inner" });
		this.wantlistFilterEl = wantlistFilterInner.createEl("input", {
			cls: "mtg-filter-chip-input",
			type: "text",
			placeholder: "Filter wantlists…",
		});
		this.wantlistFilterEl.addEventListener("input", () => this.render());

		this.bodyEl = main.createDiv({ cls: "mtg-collection-body" });

		this.render();
	}


	render() {
		// Un render() qui arrive par un autre chemin (Entrée, puce retirée…)
		// rend caduc un debounce de frappe encore en attente (voir
		// scheduleFilterRender) : sans ça, ce minuteur périmé déclencherait un
		// second render() redondant juste après celui-ci.
		if (this.filterRenderDebounceTimer !== null) {
			window.clearTimeout(this.filterRenderDebounceTimer);
			this.filterRenderDebounceTimer = null;
		}
		// Masqué à chaque render() : une ligne survolée peut être détruite/
		// reconstruite par ce même render() (changement de tri/filtre/mode de
		// vue) sans qu'un mouseleave n'ait l'occasion de se déclencher sur un
		// nœud DOM déjà retiré — laisser l'aperçu affiché figerait sa position
		// au-dessus d'une ligne qui n'existe (ou n'est) plus là.
		this.hideCardNamePreview();
		this.navHomeBtn.toggleClass("is-active", this.activeSection === "home");
		this.navCollectionBtn.toggleClass(
			"is-active",
			this.activeSection === "collection"
		);
		this.navDecksBtn.toggleClass("is-active", this.activeSection === "decks");
		this.navWantlistsBtn.toggleClass("is-active", this.activeSection === "wantlists");
		this.updateNavIndicator();

		// this.collectionHeaderEl ("My Collection"/"My Decks"/"My Wantlists" +
		// stats + "+ New X") n'était jamais masqué en tant que conteneur — seuls
		// son texte (headerTitleEl/headerStatsEl, vidé via setText("") plus bas)
		// et ses 3 boutons "+ New X" l'étaient individuellement. Bug rapporté :
		// un petit espace visible au-dessus du bouton "Back to X" une fois une
		// liste/deck/wantlist ouvert(e) — même entièrement vide, ce conteneur
		// (display:flex, sans hauteur propre une fois son contenu vidé) garde
		// son margin-bottom: 0.75em, qui pousse quand même .mtg-back-row plus
		// bas. Masqué ici avec la même logique déjà utilisée par les 3 boutons
		// "+ New X" (un par section, réunis en un seul OR puisque ce conteneur
		// est partagé entre les 3 sections) plutôt que de dépendre uniquement
		// du texte vidé. "Back to X" vit désormais dans .mtg-detail-sticky-
		// header lui-même (voir renderListDetail/renderDeckDetail/
		// renderWantlistDetail, plus .mtg-detail-header-banner dans
		// styles.css) plutôt que dans un élément séparé — ce commentaire
		// référençait à l'origine ce second élément, mis à jour puisqu'il
		// n'existe plus.
		this.collectionHeaderEl.style.display =
			this.activeSection !== "home" && !this.isDetailViewOpen() ? "flex" : "none";
		// .mtg-main ne défile plus jamais lui-même une fois une vue de détail
		// ouverte — voir .mtg-collection-body-detail/.mtg-detail-scroll-area
		// (styles.css), qui prennent le relais du défilement réel à
		// l'intérieur de this.bodyEl. Sans cette classe, la gouttière de
		// scrollbar réservée par .mtg-main (scrollbar-gutter: stable)
		// resterait en plus de celle de .mtg-detail-scroll-area — deux
		// bandes vides côte à côte, la vraie scrollbar reculée d'autant par
		// rapport au bord réel du panneau.
		this.mainEl.toggleClass("mtg-main-detail-open", this.isDetailViewOpen());

		this.collectionPinnedEl.style.display =
			this.activeSection === "collection" && !this.openListId ? "" : "none";
		this.collectionToolbarEl.style.display =
			this.activeSection === "collection" && !this.openListId ? "flex" : "none";
		this.newListBtn.style.display =
			this.activeSection === "collection" && !this.openListId ? "" : "none";
		this.listGallerySelectBtn.style.display =
			this.activeSection === "collection" && !this.openListId ? "" : "none";
		this.syncGallerySelectBtn(this.listGallerySelectBtn, this.listGallerySelectMode, "Select lists");
		this.decksToolbarEl.style.display =
			this.activeSection === "decks" && !this.openDeckId ? "flex" : "none";
		this.newDeckBtn.style.display =
			this.activeSection === "decks" && !this.openDeckId ? "" : "none";
		this.deckGallerySelectBtn.style.display =
			this.activeSection === "decks" && !this.openDeckId ? "" : "none";
		this.syncGallerySelectBtn(this.deckGallerySelectBtn, this.deckGallerySelectMode, "Select decks");
		this.wantlistsToolbarEl.style.display =
			this.activeSection === "wantlists" && !this.openWantlistId ? "flex" : "none";
		this.newWantlistBtn.style.display =
			this.activeSection === "wantlists" && !this.openWantlistId ? "" : "none";
		this.wantlistGallerySelectBtn.style.display =
			this.activeSection === "wantlists" && !this.openWantlistId ? "" : "none";
		this.syncGallerySelectBtn(
			this.wantlistGallerySelectBtn,
			this.wantlistGallerySelectMode,
			"Select wantlists"
		);

		// Construit le nouveau contenu dans un élément détaché du DOM (le code
		// des render*Section — désormais dans src/view/*-render.ts — cible this.bodyEl sans le savoir), puis
		// l'échange d'un coup avec l'ancien une fois entièrement prêt — jamais
		// d'état intermédiaire "vide". Avec l'ancienne approche (vider puis
		// reconstruire en place), la hauteur défilable de .mtg-main s'effondrait
		// un instant à chaque rendu ; un défilement rapide en cours (inertie/
		// momentum) se faisait alors couper net par le navigateur à cet instant
		// précis — particulièrement visible avec le chargement incrémental
		// (renderLoadMoreSentinel), qui redéclenche un render() en pleine
		// action de défilement.
		// .mtg-detail-scroll-area (voir styles.css) est reconstruite à chaque
		// render() comme le reste de this.bodyEl — CONTRAIREMENT à this.mainEl,
		// rien ne préserve donc sa position de défilement "gratuitement" par le
		// simple fait de ne jamais la détruire. Capturée ici avant l'échange,
		// réappliquée juste après sur la nouvelle instance : couvre tout
		// déclencheur de render() (changement de tri/filtre/mode de sélection,
		// chargement incrémental via renderLoadMoreSentinel, etc.), pas
		// seulement ce dernier cas.
		const oldScrollArea = this.bodyEl.querySelector<HTMLElement>(".mtg-detail-scroll-area");
		const viewKey = `${this.activeSection}:${this.openListId ?? ""}:${this.openDeckId ?? ""}:${this.openWantlistId ?? ""}`;
		const viewChanged = this.lastRenderedViewKey !== null && this.lastRenderedViewKey !== viewKey;
		this.lastRenderedViewKey = viewKey;
		const preservedScrollTop = oldScrollArea && !viewChanged ? oldScrollArea.scrollTop : null;

		const oldBodyEl = this.bodyEl;
		const newBodyEl = oldBodyEl.cloneNode(false) as HTMLElement;
		// this.bodyEl n'accueille l'échafaudage flex-colonne des vues de détail
		// (.mtg-collection-body-detail, voir styles.css) que si la méthode
		// render*Detail appelée juste en dessous l'ajoute elle-même — jamais
		// hérité tel quel du rendu précédent via cloneNode(false), qui copie
		// pourtant l'attribut class de l'ancien nœud : sans ce reset explicite,
		// revenir du détail à la grille laisserait cette classe traîner sur le
		// nouveau bodyEl (auto-height/block attendu pour la grille).
		newBodyEl.removeClass("mtg-collection-body-detail");
		this.bodyEl = newBodyEl;
		// Même échange détaché pour la rangée épinglée de My Collection
		// (collectionPinnedEl, voir onOpen) : seule renderListGrid la remplit,
		// tout autre rendu la laisse vide — et masquée, son display ayant été
		// posé plus haut AVANT ce clone, que cloneNode(false) recopie.
		const oldPinnedEl = this.collectionPinnedEl;
		const newPinnedEl = oldPinnedEl.cloneNode(false) as HTMLElement;
		this.collectionPinnedEl = newPinnedEl;
		// Réinitialisé avant reconstruction : ne reste "en attente" ici que ce
		// que CE passage de rendu vient tout juste de programmer (voir
		// renderChipFilter) — jamais un callback périmé d'un rendu précédent.
		this.pendingFocusRestore = null;

		if (this.activeSection === "home") {
			this.renderHomeSection();
		} else if (this.activeSection === "collection") {
			this.renderCollectionSection();
		} else if (this.activeSection === "decks") {
			this.renderDecksSection();
		} else {
			this.renderWantlistsSection();
		}

		oldBodyEl.replaceWith(newBodyEl);
		oldPinnedEl.replaceWith(newPinnedEl);
		if (viewChanged) this.mainEl.scrollTop = 0;
		if (preservedScrollTop !== null) {
			const newScrollArea = newBodyEl.querySelector<HTMLElement>(".mtg-detail-scroll-area");
			if (newScrollArea) newScrollArea.scrollTop = preservedScrollTop;
		}
		// Exécuté ici, tout de suite après l'échange, dans le même passage
		// synchrone que la construction ci-dessus : le nouvel élément à
		// focus est déjà dans le document à cet instant (replaceWith() est
		// une mutation DOM synchrone), donc aucune fenêtre où rien n'a le
		// focus ne s'intercale entre le retrait de l'ancien contenu et la
		// restauration du focus.
		this.runPendingFocusRestore();
		this.updateDeckStacksLayout();
		// Même raison d'être que le commentaire d'updateDeckStacksLayout
		// ci-dessus : à cet instant précis, une tuile de la vue Carte tout
		// juste construite (si le rendu en affiche une) est déjà dans le
		// document — voir updateCardTileRadius, qui a justement besoin de ça
		// pour mesurer une largeur réelle plutôt que celle d'un nœud détaché.
		// Couvre le cas "on vient d'ouvrir/changer la vue Carte" ; le
		// ResizeObserver posé une fois dans onOpen() (setupCardTileRadiusObserver)
		// couvre l'autre cas, un redimensionnement du panneau sans render().
		this.updateCardTileRadius();
	}

	// Vrai si une liste/un deck/une wantlist est actuellement ouvert(e) (peu
	// importe la section) — c'est-à-dire si .mtg-detail-scroll-area existe
	// dans le rendu courant plutôt que la grille d'ensemble. Centralisé ici :
	// plusieurs mécanismes (visibilité de collectionHeaderEl, gouttière de
	// .mtg-main, zone de défilement active) posent exactement la même
	// question.

	async onClose() {
		// cardNamePreviewEl est ajouté à document.body (voir onOpen), pas à un
		// descendant de cette vue — sans ce retrait explicite, il survivrait à
		// la fermeture de la vue.
		this.cardNamePreviewEl?.remove();
		this.homeSyncUnsub?.();
		this.homeSyncUnsub = null;
	}

	// -------------------------------------------------------------------
	// Method implementations below live in src/view/*.ts (split out on
	// 2026-09-10, "Phase 5b" -- see CLAUDE.md's "Architecture notes") --
	// each field is still called exactly as before everywhere else in the
	// codebase, unchanged; only WHERE the implementation lives moved. This
	// block is a manifest/index of the whole class's surface.
	// -------------------------------------------------------------------

	// -- Shared view helpers: settings link, scroll area, table header, gallery select button, load-more sentinel (src/view/shared-render-helpers.ts) --
	openPluginSettings = sharedRenderHelpers.openPluginSettings;
	renderTableHeader = sharedRenderHelpers.renderTableHeader;
	isDetailViewOpen = sharedRenderHelpers.isDetailViewOpen;
	getActiveScrollEl = sharedRenderHelpers.getActiveScrollEl;
	handleScrollAreaScroll = sharedRenderHelpers.handleScrollAreaScroll;
	syncGallerySelectBtn = sharedRenderHelpers.syncGallerySelectBtn;
	renderLoadMoreSentinel = sharedRenderHelpers.renderLoadMoreSentinel;

	// -- Filter chip search bar: chips, numeric builder, keyword suggestions, focus restore (src/view/filter-chips.ts) --
	scheduleFilterRender = filterChips.scheduleFilterRender;
	renderChipFilter = filterChips.renderChipFilter;
	renderNumericFilterBuilder = filterChips.renderNumericFilterBuilder;
	getKeywordSuggestions = filterChips.getKeywordSuggestions;
	runPendingFocusRestore = filterChips.runPendingFocusRestore;

	// -- Group by / Sort by / view mode toolbar (src/view/group-sort-bar.ts) --
	persistSortSettings = groupSortBar.persistSortSettings;
	renderGroupSortBar = groupSortBar.renderGroupSortBar;

	// -- Collapsing and FLIP animation of card groups (src/view/group-collapse.ts) --
	setRowCollapsed = groupCollapse.setRowCollapsed;
	toggleGroupRows = groupCollapse.toggleGroupRows;
	flipListChange = groupCollapse.flipListChange;

	// -- Card thumbnails with badge, name preview, tile corner radius (src/view/card-thumbnails.ts) --
	showCardNamePreview = cardThumbnails.showCardNamePreview;
	hideCardNamePreview = cardThumbnails.hideCardNamePreview;
	setupCardTileRadiusObserver = cardThumbnails.setupCardTileRadiusObserver;
	updateCardTileRadius = cardThumbnails.updateCardTileRadius;
	renderThumbWithBadge = cardThumbnails.renderThumbWithBadge;

	// -- File downloads (src/view/downloads.ts) --
	downloadTextFile = downloads.downloadTextFile;
	downloadZip = downloads.downloadZip;

	// -- Home (src/view/home-render.ts) --
	renderHomeSection = homeRender.renderHomeSection;
	renderHomeOverview = homeRender.renderHomeOverview;
	renderHomeRecentCarousel = homeRender.renderHomeRecentCarousel;
	renderHomeColorBreakdown = homeRender.renderHomeColorBreakdown;
	renderHomeRarityBreakdown = homeRender.renderHomeRarityBreakdown;
	renderHomeDecksToFinish = homeRender.renderHomeDecksToFinish;
	renderHomeMarketTrends = homeRender.renderHomeMarketTrends;

	// -- My Collection (src/view/collection-render.ts) --
	triggerImportCollection = collectionRender.triggerImportCollection;
	openAddCollectionCardsModal = collectionRender.openAddCollectionCardsModal;
	openCollectionCardDetailById = collectionRender.openCollectionCardDetailById;
	openAddCollectionCardsModalWithListPicker = collectionRender.openAddCollectionCardsModalWithListPicker;
	renderCollectionSection = collectionRender.renderCollectionSection;
	renderListGrid = collectionRender.renderListGrid;
	renderListTile = collectionRender.renderListTile;
	renderListGalleryBulkActionsBar = collectionRender.renderListGalleryBulkActionsBar;
	renderListDetail = collectionRender.renderListDetail;
	collectionCardRowSignature = collectionRender.collectionCardRowSignature;
	buildCollectionCardRow = collectionRender.buildCollectionCardRow;
	buildCollectionCardTile = collectionRender.buildCollectionCardTile;
	renderCollectionBulkActionsBar = collectionRender.renderCollectionBulkActionsBar;
	exportListCsv = collectionRender.exportListCsv;
	listTxtLines = collectionRender.listTxtLines;
	exportListTxt = collectionRender.exportListTxt;
	copyListTxt = collectionRender.copyListTxt;
	exportListSelectionCsv = collectionRender.exportListSelectionCsv;
	listSelectionTxtLines = collectionRender.listSelectionTxtLines;
	exportListSelectionTxt = collectionRender.exportListSelectionTxt;
	copyListSelectionTxt = collectionRender.copyListSelectionTxt;
	buildListCsvString = collectionRender.buildListCsvString;
	downloadListCsv = collectionRender.downloadListCsv;
	listGroupsToTxtLines = collectionRender.listGroupsToTxtLines;
	triggerImportIntoList = collectionRender.triggerImportIntoList;
	triggerImportTxtIntoList = collectionRender.triggerImportTxtIntoList;
	openList = collectionRender.openList;
	closeListIfOpen = collectionRender.closeListIfOpen;

	// -- My Decks (src/view/deck-render.ts) --
	openDeckCardDetailById = deckRender.openDeckCardDetailById;
	renderDeckBoardTabs = deckRender.renderDeckBoardTabs;
	renderDeckBulkActionsBar = deckRender.renderDeckBulkActionsBar;
	deckSelectionTxtLines = deckRender.deckSelectionTxtLines;
	exportDeckSelectionTxt = deckRender.exportDeckSelectionTxt;
	copyDeckSelectionTxt = deckRender.copyDeckSelectionTxt;
	exportDeckSelectionCsv = deckRender.exportDeckSelectionCsv;
	decksToTxtLines = deckRender.decksToTxtLines;
	buildDeckCsvString = deckRender.buildDeckCsvString;
	downloadDeckCsv = deckRender.downloadDeckCsv;
	exportDeckCsv = deckRender.exportDeckCsv;
	deckTxtLines = deckRender.deckTxtLines;
	exportDeckTxt = deckRender.exportDeckTxt;
	copyDeckTxt = deckRender.copyDeckTxt;
	triggerImportIntoDeck = deckRender.triggerImportIntoDeck;
	triggerImportTxtIntoDeck = deckRender.triggerImportTxtIntoDeck;
	openDeck = deckRender.openDeck;
	closeDeckIfOpen = deckRender.closeDeckIfOpen;
	renderDecksSection = deckRender.renderDecksSection;
	renderDeckGrid = deckRender.renderDeckGrid;
	renderDeckGalleryBulkActionsBar = deckRender.renderDeckGalleryBulkActionsBar;
	renderDeckDetail = deckRender.renderDeckDetail;
	renderDeckStacksView = deckRender.renderDeckStacksView;
	updateDeckStacksLayout = deckRender.updateDeckStacksLayout;
	setupDeckStacksLayoutObserver = deckRender.setupDeckStacksLayoutObserver;
	deckCardRowSignature = deckRender.deckCardRowSignature;
	renderDeckLegalityBadge = deckRender.renderDeckLegalityBadge;
	buildDeckCardRow = deckRender.buildDeckCardRow;
	buildDeckCardTile = deckRender.buildDeckCardTile;

	// -- My Wantlists (src/view/wantlist-render.ts) --
	triggerImportWantlist = wantlistRender.triggerImportWantlist;
	openAddWantlistCardsModal = wantlistRender.openAddWantlistCardsModal;
	openWantlistCardDetailById = wantlistRender.openWantlistCardDetailById;
	openAddWantlistCardsModalWithListPicker = wantlistRender.openAddWantlistCardsModalWithListPicker;
	renderWantlistBulkActionsBar = wantlistRender.renderWantlistBulkActionsBar;
	wantlistSelectionTxtLines = wantlistRender.wantlistSelectionTxtLines;
	exportWantlistSelectionTxt = wantlistRender.exportWantlistSelectionTxt;
	copyWantlistSelectionTxt = wantlistRender.copyWantlistSelectionTxt;
	exportWantlistCsv = wantlistRender.exportWantlistCsv;
	wantlistTxtLines = wantlistRender.wantlistTxtLines;
	exportWantlistTxt = wantlistRender.exportWantlistTxt;
	copyWantlistTxt = wantlistRender.copyWantlistTxt;
	exportWantlistSelectionCsv = wantlistRender.exportWantlistSelectionCsv;
	buildWantlistCsvString = wantlistRender.buildWantlistCsvString;
	downloadWantlistCsv = wantlistRender.downloadWantlistCsv;
	wantlistGroupsToTxtLines = wantlistRender.wantlistGroupsToTxtLines;
	triggerImportIntoWantlist = wantlistRender.triggerImportIntoWantlist;
	triggerImportTxtIntoWantlist = wantlistRender.triggerImportTxtIntoWantlist;
	openWantlist = wantlistRender.openWantlist;
	closeWantlistIfOpen = wantlistRender.closeWantlistIfOpen;
	renderWantlistsSection = wantlistRender.renderWantlistsSection;
	renderWantlistGrid = wantlistRender.renderWantlistGrid;
	renderWantlistTile = wantlistRender.renderWantlistTile;
	renderWantlistGalleryBulkActionsBar = wantlistRender.renderWantlistGalleryBulkActionsBar;
	renderWantlistDetail = wantlistRender.renderWantlistDetail;
	wantlistCardRowSignature = wantlistRender.wantlistCardRowSignature;
	buildWantlistCardRow = wantlistRender.buildWantlistCardRow;
	buildWantlistCardTile = wantlistRender.buildWantlistCardTile;

	// -- Barres d'Obsidian sur téléphone, bas et haut (src/view/mobile-bars.ts) --
	setupMobileBars = mobileBars.setupMobileBars;
	syncMobileBars = mobileBars.syncMobileBars;

}
