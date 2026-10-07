import { Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { ListIcon } from "../core/data-model";
import {
	applySvgColor,
	dedupeSetsByIcon,
	getSetGroupLabel,
	SET_GROUP_ORDER,
	ScryfallSetSummary,
} from "../api/scryfall";
import { MANA_ICON_LETTERS, OTHER_ICON_SYMBOLS } from "./entity-icon-options";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  Sous-écrans communs aux modales de réglages (liste / wantlist / deck)     */
/*  — List/Wantlist/DeckSettingsModal, et InboxSettingsModal pour la          */
/*  confirmation                                                              */
/* -------------------------------------------------------------------------- */
// Chaque modale de réglages remplace tout son contenu par un « sous-écran » (confirmation, choix de la cible
// d'une fusion, de la couverture, de l'icône) puis revient à l'écran principal. Ces sous-écrans étaient copiés
// trois fois, identiques aux noms près ; ce qui change vraiment d'une section à l'autre est un paramètre :
// le nom de l'entité ("list"/"wantlist"/"deck"), ses cartes et la clé qui les identifie (CollectionCard.id,
// DeckCard.scryfallId), les candidats à la fusion (l'Inbox exclue côté liste), et quelle méthode du plugin
// enregistre le résultat.
//
// La modale garde ses drapeaux (confirmingDelete, pickingIcon…) et son draw() : elle appelle la fonction
// d'écran, qui construit le contenu et rappelle `onCancel` / `onDone` — c'est la modale qui bascule le drapeau
// et redessine.

// Écran de confirmation plein-format (Delete / Clear) : titre, message, « Yes, … » en rouge, « No, cancel ».
// Pas le swap Delete/Cancel en place de la barre d'actions groupées — cohérent entre les actions destructives
// de ces fenêtres.
export function renderConfirmScreen(
	contentEl: HTMLElement,
	c: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }
) {
	contentEl.createEl("h2", { text: c.title });
	contentEl.createEl("p", { text: c.message, cls: "mtg-status" });
	const row = contentEl.createDiv({ cls: "mtg-svg-btn-row" });
	const yesBtn = row.createEl("button", {
		text: c.confirmLabel,
		cls: "mtg-remove-btn",
	});
	yesBtn.addEventListener("click", c.onConfirm);
	const noBtn = row.createEl("button", { text: "No, cancel" });
	noBtn.addEventListener("click", c.onCancel);
}

// Choix de la 2ᵉ entité d'une fusion (« Merge with another … »). Ne fait que choisir : le reste (nom éditable,
// confirmation, mutation) est délégué à MergeListsModal/MergeWantlistsModal/MergeDecksModal (merge-modals.ts) par
// `onChoose`. Même mécanique que le Merge groupé d'une galerie, demandé explicitement : une NOUVELLE entité est
// créée avec les deux, et LES DEUX originales (y compris celle-ci) sont supprimées — pas une simple absorption.
// Les candidats sont fournis par la modale, déjà filtrés (côté listes, l'Inbox est exclue : mergeLists l'ignore
// silencieusement, la proposer mènerait à un « merge » qui ne fait rien de visible) et dans l'ordre voulu.
// Présenté comme « Move to »/« Copy to » (CopyCardModal) — demandé explicitement, à la place du <select> texte
// d'avant : même galerie de tuiles (couverture/nom/« N cards »), même barre de recherche, même apparition
// échelonnée des premières tuiles (revealTile). Cliquer une tuile choisit directement la 2ᵉ entité, comme cliquer
// une tuile de CopyCardModal déclenche directement le copy/move — pas de bouton « Merge » séparé. Pas d'onglets
// (une seule destination possible) ni de tuile « + New X » (la fusion suppose une entité existante) ; mêmes
// classes .mtg-copy-card-gallery-* que CopyCardModal, aucune scopée sous .mtg-copy-card-modal.
export interface MergeCandidate {
	id: string;
	name: string;
	coverImage?: string;
	totalQty: number;
}

export function renderMergeTargetScreen(
	contentEl: HTMLElement,
	s: {
		// "list" | "wantlist" | "deck"
		noun: string;
		// Nom de l'entité dont on ouvre les réglages (citée dans le texte d'aide).
		currentName: string;
		candidates: MergeCandidate[];
		onChoose: (targetId: string) => void;
		onCancel: () => void;
	}
) {
	contentEl.createEl("h2", { text: `Merge with another ${s.noun}` });
	if (s.candidates.length === 0) {
		contentEl.createEl("p", {
			text: `There's no other ${s.noun} to merge with.`,
			cls: "mtg-status",
		});
		const backBtn = contentEl.createEl("button", { text: "Back" });
		backBtn.addEventListener("click", s.onCancel);
		return;
	}
	contentEl.createEl("p", {
		text: `Choose another ${s.noun} to merge with "${s.currentName}". This creates one new ${s.noun} with every card from both, then deletes the two originals.`,
		cls: "mtg-status",
	});

	const searchWrap = contentEl.createDiv({ cls: "mtg-copy-card-search" });
	const searchInput = searchWrap.createEl("input", {
		cls: "mtg-copy-card-search-input",
		type: "text",
		attr: { placeholder: `Search ${s.noun}s…` },
	});
	const galleryEl = contentEl.createDiv({ cls: "mtg-copy-card-gallery" });

	let tileStaggerIndex = 0;
	const revealTile = (tile: HTMLElement, stagger: boolean) => {
		if (!stagger) {
			tile.addClass("is-visible");
			return;
		}
		const delay = Math.min(tileStaggerIndex, 8) * 40;
		tileStaggerIndex++;
		window.setTimeout(() => tile.addClass("is-visible"), delay);
	};

	const renderMergeGallery = (stagger: boolean) => {
		galleryEl.empty();
		tileStaggerIndex = 0;
		const query = searchInput.value.trim().toLowerCase();
		const matches = s.candidates.filter((g) => !query || g.name.toLowerCase().includes(query));
		matches.forEach((g) => {
			const tile = galleryEl.createDiv({ cls: "mtg-copy-card-gallery-tile" });
			const bg = tile.createDiv({ cls: "mtg-copy-card-gallery-tile-bg" });
			if (g.coverImage) bg.style.backgroundImage = `url("${g.coverImage}")`;
			const overlay = tile.createDiv({ cls: "mtg-copy-card-gallery-overlay" });
			overlay.createDiv({ cls: "mtg-copy-card-gallery-name", text: g.name });
			overlay.createDiv({ cls: "mtg-copy-card-gallery-meta", text: `${g.totalQty} cards` });
			tile.addEventListener("click", () => s.onChoose(g.id));
			revealTile(tile, stagger);
		});
		if (matches.length === 0) {
			galleryEl.createEl("p", { text: `No ${s.noun} found.`, cls: "mtg-status" });
		}
	};
	// Ne reconstruit QUE la galerie à chaque frappe, jamais tout
	// contentEl via this.draw() — reconstruire ce <input> lui-même
	// couperait le focus au milieu de la saisie (même risque déjà
	// documenté pour CopyCardModal.searchInputEl).
	searchInput.addEventListener("input", () => renderMergeGallery(false));
	renderMergeGallery(true);

	const cancelRow = contentEl.createDiv({ cls: "mtg-svg-btn-row" });
	const cancelBtn = cancelRow.createEl("button", { text: "Cancel" });
	cancelBtn.addEventListener("click", s.onCancel);
}

// « Choose cover image » : une carte de CETTE entité, dont l'illustration remplace le choix automatique (la plus
// chère, voir pickCoverImage/resolveCoverImage, core/price.ts) partout où ce groupe est affiché (grille de la
// section, galerie de CopyCardModal… — tout passe par groupByList/groupByWantlist/resolveDeckCoverImage, donc rien
// d'autre à toucher). Grille de 3 colonnes d'illustrations SEULES (artCropUrl — le crop Scryfall de l'art seul,
// pas le scan complet de la carte, demandé explicitement) avec juste le nom en dessous, en discret. Sélection par
// contour (même recette que .mtg-set-tile-selected de la grille principale : outline, pas border, pour ne jamais
// décaler la boîte au clic) plutôt qu'un bouton « Use this » par tuile — un seul choix à la fois, validé par un
// unique « Save » en bas ; naviguer dans la grille ne touche donc pas encore la couverture enregistrée. Pas de
// barre de recherche (volontairement proportionné à ce qui a été demandé).
// « Automatic » est toujours la 1ʳᵉ tuile (pas seulement quand un choix manuel est déjà fait) — sans elle, rien
// n'indiquerait que c'est l'état actif tant qu'aucune carte n'a jamais été choisie.
// `key` identifie une carte pour cette section (CollectionCard.id / WantlistCard.id côté listes et wantlists,
// DeckCard.scryfallId côté deck, qui n'a pas d'id propre) ; `currentKey` est la couverture actuelle.
export interface CoverCard {
	key: string;
	name: string;
	artCropUrl: string;
	imageUrl: string;
}

export function renderCoverPickerScreen(
	contentEl: HTMLElement,
	s: {
		noun: string;
		cards: CoverCard[];
		currentKey: string | undefined;
		// Enregistre le choix (undefined = automatique) — c'est la modale qui appelle la bonne méthode du plugin.
		save: (key: string | undefined) => void;
		// Après l'enregistrement (la modale quitte le sous-écran et redessine).
		onDone: () => void;
		onCancel: () => void;
	}
) {
	contentEl.createEl("h2", { text: "Choose cover image" });
	if (s.cards.length === 0) {
		contentEl.createEl("p", {
			text: `This ${s.noun} has no cards yet.`,
			cls: "mtg-status",
		});
		const backBtn = contentEl.createEl("button", { text: "Cancel" });
		backBtn.addEventListener("click", s.onCancel);
		return;
	}
	contentEl.createEl("p", {
		text: `Pick a card to use its illustration as this ${s.noun}'s cover in the grid.`,
		cls: "mtg-status",
	});

	// État local à cet écran, validé seulement par "Save" plus bas —
	// naviguer dans la grille ne touche pas encore list.coverCardId,
	// contrairement à l'ancienne version qui appliquait chaque clic
	// immédiatement.
	let selectedKey: string | undefined = s.currentKey;

	const grid = contentEl.createDiv({ cls: "mtg-cover-picker-grid" });

	const selectTile = (tile: HTMLElement, key: string | undefined) => {
		grid
			.querySelectorAll(".mtg-cover-picker-tile.is-selected")
			.forEach((el) => el.removeClass("is-selected"));
		tile.addClass("is-selected");
		selectedKey = key;
	};

	// "Automatic" toujours en 1ʳᵉ tuile (pas seulement quand un choix
	// manuel est déjà fait) — sans elle, rien n'indique que c'est
	// l'état actif tant qu'aucune carte n'a jamais été choisie.
	const autoTile = grid.createDiv({
		cls: "mtg-cover-picker-tile mtg-cover-picker-tile-auto" + (!s.currentKey ? " is-selected" : ""),
	});
	const autoBox = autoTile.createDiv({ cls: "mtg-cover-picker-tile-img mtg-cover-picker-tile-auto-box" });
	setIcon(autoBox, "sparkles");
	autoTile.createDiv({ cls: "mtg-cover-picker-tile-title", text: "Automatic" });
	autoTile.addEventListener("click", () => selectTile(autoTile, undefined));

	s.cards.forEach((card) => {
		const tile = grid.createDiv({
			cls: "mtg-cover-picker-tile" + (card.key === s.currentKey ? " is-selected" : ""),
		});
		const art = card.artCropUrl || card.imageUrl;
		if (art) {
			tile.createEl("img", {
				cls: "mtg-cover-picker-tile-img",
				attr: { src: art, loading: "lazy" },
			});
		} else {
			tile.createDiv({ cls: "mtg-cover-picker-tile-img mtg-no-image" });
		}
		tile.createDiv({ cls: "mtg-cover-picker-tile-title", text: card.name });
		tile.addEventListener("click", () => selectTile(tile, card.key));
	});

	const row = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-list-actions-save-row" });
	const saveBtn = row.createEl("button", { text: "Save", cls: "mtg-search-add-btn" });
	saveBtn.addEventListener("click", () => {
		const label = selectedKey
			? `"${s.cards.find((c) => c.key === selectedKey)?.name ?? ""}"`
			: "automatic";
		s.save(selectedKey);
		new Notice(`Cover image set to ${label}.`);
		s.onDone();
	});
	const cancelBtn = row.createEl("button", { text: "Cancel" });
	cancelBtn.addEventListener("click", s.onCancel);
}

// État du sélecteur d'icône, porté par la modale (un CHAMP D'INSTANCE plutôt qu'une variable locale à draw())
// pour survivre à un changement d'onglet (Mana Symbol/Set Symbol/Other symbol) : le corps de l'écran est
// reconstruit à chaque changement d'onglet, une variable locale y serait réinitialisée depuis l'entité, perdant un
// choix pas encore sauvegardé au moment de simplement changer d'onglet pour regarder l'autre.
//  - pendingIcon : choix en cours, pas encore enregistré (validé seulement par « Save ») ;
//  - tab : onglet affiché ;
//  - dedupedSets : liste des éditions dédupliquées par symbole, mémorisée une fois calculée (dedupeSetsByIcon sur
//    ~1000 entrées, pas gratuit) plutôt que recalculée à chaque ouverture — getAllScryfallSets() lui-même est déjà
//    mis en cache côté plugin, mais la déduplication ne l'était pas.
export interface IconPickerState {
	pendingIcon: ListIcon | undefined;
	tab: "mana" | "set" | "other";
	dedupedSets: ScryfallSetSummary[] | null;
}

export function newIconPickerState(): IconPickerState {
	return { pendingIcon: undefined, tab: "mana", dedupedSets: null };
}

// À appeler au clic sur « Choose icon » de l'écran principal : reprend le choix depuis l'icône actuelle de
// l'entité et ouvre l'onglet qui la contient (set → « Set Symbol », symbole de OTHER_ICON_SYMBOLS → « Other
// symbol », sinon « Mana Symbol »).
export function openIconPicker(state: IconPickerState, icon: ListIcon | undefined) {
	state.pendingIcon = icon;
	state.tab =
		icon?.kind === "set"
			? "set"
			: icon && OTHER_ICON_SYMBOLS.some((s) => s.letter === icon.value)
				? "other"
				: "mana";
}

// « Choose icon » : un pictogramme affiché devant les 3 lignes de texte de l'entité (grille de la section ET
// galerie de CopyCardModal — tout part de group.icon, posé une seule fois via setListIcon/setWantlistIcon/
// setDeckIcon). 3 onglets, même langage visuel ET même mécanique que « My Collection »/« My Decks »/« My
// Wantlists » dans CopyCardModal : les boutons d'onglet + la barre glissante (.mtg-copy-card-tab-indicator) sont
// construits UNE SEULE FOIS ci-dessous (jamais recréés par un changement d'onglet), exactement comme
// CopyCardModal.buildChrome — un changement d'onglet appelle switchIconTab (repositionne juste la barre +
// reconstruit le corps), jamais un redessin complet, qui détruirait ces boutons et ferait réapparaître la barre déjà
// en place sans glissement. state.pendingIcon garde le choix en cours d'un onglet à l'autre.
export function renderIconPickerScreen(
	contentEl: HTMLElement,
	ctx: {
		plugin: MTGCollectionPlugin;
		noun: string;
		state: IconPickerState;
		// Enregistre le choix (undefined = aucune icône) — c'est la modale qui appelle la bonne méthode du plugin.
		save: (icon: ListIcon | undefined) => void;
		onDone: () => void;
		onCancel: () => void;
	}
) {
	const { state } = ctx;
	const noun = ctx.noun.charAt(0).toUpperCase() + ctx.noun.slice(1);
	contentEl.createEl("h2", { text: "Choose icon" });
	contentEl.createEl("p", {
		text: `Shown to the left of the ${ctx.noun}'s name, wherever it appears.`,
		cls: "mtg-status",
	});

	const tabsEl = contentEl.createDiv({ cls: "mtg-copy-card-tabs" });
	const tabDefs: { key: "mana" | "set" | "other"; label: string }[] = [
		{ key: "mana", label: "Mana symbol" },
		{ key: "set", label: "Set symbol" },
		{ key: "other", label: "Other symbol" },
	];
	const tabButtons: Partial<Record<"mana" | "set" | "other", HTMLElement>> = {};
	tabDefs.forEach((t) => {
		const btn = tabsEl.createDiv({
			cls: "mtg-copy-card-tab-btn" + (state.tab === t.key ? " is-active" : ""),
			text: t.label,
		});
		btn.addEventListener("click", () => switchIconTab(t.key));
		tabButtons[t.key] = btn;
	});
	const tabIndicatorEl = tabsEl.createDiv({ cls: "mtg-copy-card-tab-indicator" });
	const positionIndicator = (btn: HTMLElement) => {
		tabIndicatorEl.style.transform = `translateX(${btn.offsetLeft}px)`;
		tabIndicatorEl.style.width = `${btn.offsetWidth}px`;
	};
	// Positionnement initial SYNCHRONE, dans le même tick que la
	// création de la barre — rien n'a encore été peint à une autre
	// position dont il faudrait glisser, elle apparaît donc déjà au
	// bon endroit sans glissement non désiré à l'ouverture (même
	// raisonnement que CopyCardModal.buildChrome).
	positionIndicator(tabButtons[state.tab]!);

	// Hauteur minimale fixe pour que la fenêtre ne change pas de
	// taille selon l'onglet actif (demandé explicitement) — bornée à
	// la même valeur que le plafond de la grille "Set Symbol"
	// (.mtg-icon-picker-grid, max-height:45vh) puisque c'est
	// l'onglet le plus haut des 3 ; les onglets plus courts (Mana/
	// Other) laissent juste de l'espace vide en dessous plutôt que
	// de faire varier la hauteur totale de la fenêtre.
	const body = contentEl.createDiv({ cls: "mtg-icon-picker-body" });

	// Mana Symbol/Other symbol : même grille de 5 colonnes que Set
	// Symbol (demandé explicitement) — .mtg-icon-picker-grid partagée
	// par les 3 onglets (voir styles.css) est ce qui garantit à la
	// fois la présentation identique ET la hauteur identique d'un
	// onglet à l'autre (même conteneur, même max-height/overflow-y,
	// juste moins de tuiles à faire défiler).
	const renderSymbolGrid = (symbols: { letter: string; label: string; recolor?: boolean }[]) => {
		const grid = body.createDiv({ cls: "mtg-icon-picker-grid" });
		const selectTile = (tile: HTMLElement, icon: ListIcon | undefined) => {
			grid.querySelectorAll(".mtg-icon-picker-tile.is-selected").forEach((el) =>
				el.removeClass("is-selected")
			);
			tile.addClass("is-selected");
			state.pendingIcon = icon;
		};
		// La tuile "None" (effacer le pictogramme) a été retirée du 1er
		// onglet (demandé explicitement) — le bouton "Choose icon" de la
		// fenêtre principale porte déjà sa propre petite croix pour ça
		// une fois une icône choisie (voir plus bas, removeIconBtn), donc
		// une case vide en tête de grille faisait doublon.
		symbols.forEach(({ letter, label, recolor }) => {
			const tile = grid.createDiv({
				cls:
					"mtg-icon-picker-tile" +
					(state.pendingIcon?.kind === "mana" && state.pendingIcon.value === letter
						? " is-selected"
						: ""),
			});
			tile.setAttribute("title", label);
			void ctx.plugin.getManaSymbolSvg(letter).then((svg) => {
				if (!svg) return;
				setSvgMarkup(tile, svg);
				// Seuls les symboles "Other symbol" mono-couleur (#000 pur,
				// sans arrière-plan) demandent ce recolorage — voir le
				// commentaire de OTHER_ICON_SYMBOLS pour le détail vérifié
				// symbole par symbole. Jamais appliqué à un symbole de mana
				// (recolor toujours absent sur MANA_ICON_LETTERS), qui doit
				// garder sa vraie couleur.
				if (recolor) applySvgColor(tile, "var(--text-muted)");
			});
			tile.addEventListener("click", () => selectTile(tile, { kind: "mana", value: letter }));
		});
	};

	// Onglet "Set Symbol" : recherche + grille de 5 colonnes, le
	// symbole seul — le nom du set en infobulle plutôt qu'en texte
	// sous chaque tuile (demandé explicitement). dedupeSetsByIcon
	// (api/scryfall.ts) évite de lister séparément plusieurs sets qui
	// partagent le même symbole (tokens/promos/art series d'une même
	// édition, très fréquent — 987 éditions non-numériques mais
	// seulement 337 symboles distincts, vérifié en direct sur
	// l'API — voir le commentaire de cette fonction). Toutes les
	// tuiles sont construites UNE SEULE FOIS (dès que la liste de
	// sets arrive) ; la recherche ne fait plus que masquer/afficher
	// les tuiles déjà en place plutôt que les détruire/recréer à
	// chaque frappe — une tuile reconstruite exactement sous un
	// curseur resté immobile ne redéclenche pas l'infobulle native du
		// navigateur tant qu'aucun nouvel événement mouseover n'arrive
	// dessus (bug signalé : "l'infobulle n'apparaît pas tout le
	// temps"), alors qu'une tuile qui reste le même nœud DOM tout du
	// long garde son survol continu.
	//
	// Groupée par catégorie (Core Sets/Expansion Sets/Commander &
	// Multiplayer/etc. — demandé explicitement, sur le modèle de la
	// page de référence Keyrune) via getSetGroupLabel/SET_GROUP_ORDER
	// (api/scryfall.ts), dérivés du champ set_type de Scryfall plutôt
	// que d'une liste de sets écrite à la main — voir le commentaire de
	// ces deux exports pour le raisonnement complet. La recherche
	// reste globale, à travers tous les groupes à la fois (choisi
	// explicitement plutôt qu'un repli/dépli par groupe) : un en-tête
	// de groupe (grid-column:1/-1, comme .mtg-status juste en dessous)
	// se masque simplement si plus aucune de ses tuiles n'est visible,
	// exactement le même mécanisme que noResultsEl.
	const renderSetTab = () => {
		const searchInput = body.createEl("input", {
			type: "text",
			cls: "mtg-icon-picker-search",
			attr: { placeholder: "Search sets…" },
		});
		const setGridEl = body.createDiv({ cls: "mtg-icon-picker-grid" });
		const loadingEl = setGridEl.createEl("p", { text: "Loading sets…", cls: "mtg-status" });
		const noResultsEl = setGridEl.createEl("p", { text: "No set found.", cls: "mtg-status" });
		noResultsEl.addClass("mtg-hidden");
		let tiles: { el: HTMLElement; name: string }[] = [];
		let groupSections: { headerEl: HTMLElement; tileEls: HTMLElement[] }[] = [];

		const applyFilter = () => {
			const q = searchInput.value.trim().toLowerCase();
			let anyVisible = false;
			tiles.forEach(({ el, name }) => {
				const match = !q || name.includes(q);
				el.style.display = match ? "" : "none";
				if (match) anyVisible = true;
			});
			groupSections.forEach(({ headerEl, tileEls }) => {
				headerEl.style.display = tileEls.some((t) => t.style.display !== "none") ? "" : "none";
			});
			noResultsEl.toggleClass("mtg-hidden", !(tiles.length > 0 && !anyVisible));
		};
		searchInput.addEventListener("input", applyFilter);

		const buildTiles = (sets: ScryfallSetSummary[]) => {
			loadingEl.remove();
			tiles = [];
			groupSections = [];
			SET_GROUP_ORDER.forEach((groupLabel) => {
				// sets est déjà trié alphabétiquement dans son ensemble
				// (voir state.dedupedSets ci-dessous) — un simple filter()
				// préserve cet ordre relatif à l'intérieur du groupe,
				// aucun second tri n'est nécessaire ici.
				const groupSets = sets.filter((s) => getSetGroupLabel(s.set_type) === groupLabel);
				if (groupSets.length === 0) return;
				const headerEl = setGridEl.createDiv({
					cls: "mtg-icon-picker-group-header",
					text: groupLabel,
				});
				const tileEls: HTMLElement[] = [];
				groupSets.forEach((s) => {
					const tile = setGridEl.createDiv({
						cls:
							"mtg-icon-picker-tile" +
							(state.pendingIcon?.kind === "set" && state.pendingIcon.value === s.code
								? " is-selected"
								: ""),
					});
					tile.setAttribute("title", s.name);
					void ctx.plugin.getSetIconSvg(s.code).then((svg) => {
						if (!svg) return;
						setSvgMarkup(tile, svg);
						applySvgColor(tile, "var(--text-muted)");
					});
					tile.addEventListener("click", () => {
						setGridEl
							.querySelectorAll(".mtg-icon-picker-tile.is-selected")
							.forEach((el) => el.removeClass("is-selected"));
						tile.addClass("is-selected");
						state.pendingIcon = { kind: "set", value: s.code };
					});
					tileEls.push(tile);
					tiles.push({ el: tile, name: s.name.toLowerCase() });
				});
				groupSections.push({ headerEl, tileEls });
			});
			applyFilter();
		};

		if (state.dedupedSets) {
			buildTiles(state.dedupedSets);
		} else {
			void ctx.plugin.getAllScryfallSets().then((sets) => {
				// Plus récent en premier (demandé explicitement) — released_at
				// est une chaîne ISO (YYYY-MM-DD), donc comparable lexicalement
				// sans parsing ; vérifié en direct que les 987 éditions
				// non-numériques l'ont toutes renseignée (le repli sur ""
				// ci-dessous n'est donc là que par prudence, jamais réellement
				// atteint aujourd'hui). Trié une seule fois ici, globalement —
				// buildTiles ne fait plus que filtrer par groupe (voir plus
				// haut), donc l'ordre "plus récent d'abord" se retrouve tout
				// seul à l'intérieur de chaque groupe sans second tri.
				state.dedupedSets = dedupeSetsByIcon(sets).sort((a, b) =>
					(b.released_at ?? "").localeCompare(a.released_at ?? "")
				);
				buildTiles(state.dedupedSets);
			});
		}
	};

	const renderBody = () => {
		body.empty();
		if (state.tab === "mana") renderSymbolGrid(MANA_ICON_LETTERS);
		else if (state.tab === "other") renderSymbolGrid(OTHER_ICON_SYMBOLS);
		else renderSetTab();
	};

	// Référencée par les clics d'onglet plus haut (fermeture, résolue
	// seulement au moment du clic — jamais avant ce point du code, donc
	// pas de souci d'ordre malgré la déclaration const plus bas, même
	// convention que noneTile/setSelect ailleurs dans ce fichier).
	const switchIconTab = (tab: "mana" | "set" | "other") => {
		if (state.tab === tab) return;
		state.tab = tab;
		Object.values(tabButtons).forEach((btn) => btn.removeClass("is-active"));
		tabButtons[tab]!.addClass("is-active");
		positionIndicator(tabButtons[tab]!);
		renderBody();
	};
	renderBody();

	const saveCancelRow = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-icon-picker-save-row" });
	const cancelIconBtn = saveCancelRow.createEl("button", {
		text: "Cancel",
		cls: "mtg-icon-picker-cancel-btn",
	});
	cancelIconBtn.addEventListener("click", ctx.onCancel);
	const saveBtn = saveCancelRow.createEl("button", { text: "Save", cls: "mtg-search-add-btn" });
	saveBtn.addEventListener("click", () => {
		ctx.save(state.pendingIcon);
		new Notice(state.pendingIcon ? `${noun} icon updated.` : `${noun} icon removed.`);
		ctx.onDone();
	});
}
