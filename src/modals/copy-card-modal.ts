import { App, Modal, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { CollectionCard, WantlistCard } from "../core/card-model";
import { DeckCard, getDeckCardCategory, ListIcon } from "../core/data-model";
import { NewListModal, NewDeckModal, NewWantlistModal } from "./new-entity-modals";
import { groupByList, groupByWantlist, formatMoney, resolveDeckCoverImage } from "../core/price";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import { applySvgColor } from "../api/scryfall";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  Copy card modal (duplicate a card into another list/deck/wantlist,       */
/*  without removing it from where it already is)                           */
/* -------------------------------------------------------------------------- */

type TabKey = "collection" | "decks" | "wantlists";

const TAB_DEFS: { key: TabKey; label: string }[] = [
	{ key: "collection", label: "Collection" },
	{ key: "decks", label: "Decks" },
	{ key: "wantlists", label: "Wantlists" },
];

export class CopyCardModal extends Modal {
	private plugin: MTGCollectionPlugin;
	// Toujours un tableau, même pour une seule carte (voir les sites d'appel
	// dans card-detail-modal.ts/wantlist-card-detail-modal.ts, qui passent
	// un tableau à 1 élément) — un seul chemin de code pour le cas simple
	// (panneau de détail) et le cas multiple (barre d'actions groupées de
	// My Collection, "Move to…"/"Copy to…") plutôt que deux implémentations
	// parallèles à maintenir séparément.
	private cards: (CollectionCard | WantlistCard | DeckCard)[];
	// D'où viennent les cartes copiées/déplacées : détermine quelle méthode
	// plugin appeler (les tableaux collection/wantlist/deck sont distincts),
	// indépendamment de l'onglet de destination choisi ci-dessous. Toutes
	// les cartes d'un même appel partagent la même source — la barre
	// d'actions groupées ne mélange jamais collection et wantlist dans une
	// même sélection, et le panneau de détail d'un deck n'ouvre jamais cette
	// modale qu'avec une seule DeckCard à la fois (voir "deck" ci-dessous).
	private sourceKind: "collection" | "wantlist" | "deck";
	// Nécessaire uniquement quand sourceKind === "deck" : une DeckCard n'a
	// pas de champ id propre (voir "Data model notes" dans CLAUDE.md) ni de
	// référence à son deck parent — copyDeckCardToList/copyDeckCardToDeck/
	// copyDeckCardToWantlist (plugin.ts) ont donc besoin qu'on leur précise
	// explicitement d'où la carte part.
	private deckContext?: { deckId: string };
	// "move" retire chaque carte de sa source une fois ajoutée à la
	// destination — même galerie de destinations que "copy", seule la
	// méthode plugin appelée diffère (voir copyToList/copyToDeck/
	// copyToWantlist).
	private mode: "copy" | "move";
	private onDone: () => void;
	private activeTab: TabKey = "collection";
	private galleryEl!: HTMLElement;
	// Repartie à "" à chaque changement d'onglet (voir selectTab) — une
	// requête tapée dans "My Decks" n'a pas de sens une fois basculé sur
	// "My Wantlists".
	private searchQuery = "";
	private searchInputEl!: HTMLInputElement;
	// Onglets + indicateur construits UNE SEULE FOIS (dans buildChrome,
	// appelé depuis onOpen) plutôt que reconstruits à chaque clic comme le
	// reste de cette modale — demandé explicitement ("transitions plus
	// fluides"). Une transition CSS ne peut animer un élément QUE d'un état
	// à un autre SUR LE MÊME élément ; reconstruire les boutons à chaque
	// clic (l'ancien comportement, hérité de renderGallery ailleurs dans ce
	// fichier) ne laisse jamais rien à animer depuis. Ces références
	// persistent donc pour toute la durée de vie de la modale.
	private tabButtons: Partial<Record<TabKey, HTMLElement>> = {};
	private tabIndicatorEl!: HTMLElement;
	// Décale l'apparition des premières tuiles d'une galerie fraîchement
	// affichée (ouverture, changement d'onglet) — jamais pendant la frappe
	// dans la recherche, qui doit rester instantanée pour ne pas ralentir
	// un filtrage actif. Remis à 0 au début de chaque renderGallery(),
	// incrémenté par tuile pour espacer leur délai (voir revealTile).
	private tileStaggerIndex = 0;
	private staggerNextGallery = false;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		cards: (CollectionCard | WantlistCard | DeckCard)[],
		sourceKind: "collection" | "wantlist" | "deck",
		onDone: () => void,
		mode: "copy" | "move" = "copy",
		deckContext?: { deckId: string }
	) {
		super(app);
		this.plugin = plugin;
		this.cards = cards;
		this.sourceKind = sourceKind;
		this.onDone = onDone;
		this.mode = mode;
		this.deckContext = deckContext;
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts. Demandé explicitement pour cette modale en
		// particulier ("est-ce que la modale 'Move card' peut apparaitre de la
		// même façon que la fenêtre de détail de carte") après quoi la même
		// animation a été généralisée à toutes les autres modales du plugin.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		this.buildChrome();
		this.renderGallery(true);
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	// Titre + onglets + indicateur + barre de recherche + conteneur de
	// galerie (vide) : tout ce qui doit survivre à un changement d'onglet
	// sans être détruit/recréé. Appelée une seule fois, depuis onOpen().
	private buildChrome() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mtg-copy-card-modal");
		contentEl.addClass("mtg-list-actions-modal");
		// Titre au pluriel au-delà d'une carte (même convention que
		// MarkAsAcquiredModal : "Mark as acquired" vs "Mark N cards as
		// acquired") — la barre d'actions groupées de My Collection peut
		// ouvrir cette modale avec plusieurs cartes sélectionnées à la fois.
		const count = this.cards.length;
		const title =
			this.mode === "move"
				? count === 1
					? "Move card"
					: `Move ${count} cards`
				: count === 1
					? "Copy card to"
					: `Copy ${count} cards to`;
		contentEl.createEl("h2", { text: title });

		const tabsEl = contentEl.createDiv({ cls: "mtg-copy-card-tabs" });
		TAB_DEFS.forEach((t) => {
			const btn = tabsEl.createDiv({
				cls: "mtg-copy-card-tab-btn" + (this.activeTab === t.key ? " is-active" : ""),
				text: t.label,
			});
			btn.addEventListener("click", () => this.selectTab(t.key));
			this.tabButtons[t.key] = btn;
		});
		// Barre unique qui glisse d'un onglet à l'autre (voir positionIndicator)
		// plutôt qu'une bordure par bouton activée/désactivée au clic — c'est
		// justement ce qui permet le glissement demandé : une seule instance,
		// jamais reconstruite, dont on change juste transform/width.
		this.tabIndicatorEl = tabsEl.createDiv({ cls: "mtg-copy-card-tab-indicator" });

		const searchWrap = contentEl.createDiv({ cls: "mtg-copy-card-search" });
		this.searchInputEl = searchWrap.createEl("input", {
			cls: "mtg-copy-card-search-input",
			type: "text",
		});
		this.searchInputEl.setAttribute("placeholder", this.searchPlaceholder());
		// Ne reconstruit QUE la galerie (pas les onglets/la recherche) à chaque
		// frappe — reconstruire ce <input> lui-même couperait le focus au milieu
		// de la saisie (même risque documenté pour pendingFocusRestore/
		// renderChipFilter ailleurs dans ce plugin). Jamais de délai décalé ici
		// (staggerNextGallery reste false) : un filtrage doit réagir tout de
		// suite, pas onduler à chaque caractère tapé.
		this.searchInputEl.addEventListener("input", () => {
			this.searchQuery = this.searchInputEl.value;
			this.renderGallery();
		});

		this.galleryEl = contentEl.createDiv({ cls: "mtg-copy-card-gallery" });

		// Position initiale posée de façon synchrone, dans le même passage que
		// la construction des boutons : l'indicateur n'a encore jamais été peint
		// à un autre endroit, donc rien à animer DEPUIS — contrairement à
		// selectTab ci-dessous, qui s'exécute après un premier rendu déjà visible.
		this.positionIndicator(this.activeTab);
	}

	private selectTab(key: TabKey) {
		if (this.activeTab === key) return;
		this.tabButtons[this.activeTab]?.removeClass("is-active");
		this.activeTab = key;
		this.tabButtons[key]?.addClass("is-active");
		this.positionIndicator(key);
		this.searchQuery = "";
		this.searchInputEl.value = "";
		this.searchInputEl.setAttribute("placeholder", this.searchPlaceholder());
		this.renderGallery(true);
	}

	private positionIndicator(key: TabKey) {
		const btn = this.tabButtons[key];
		if (!btn) return;
		this.tabIndicatorEl.style.transform = `translateX(${btn.offsetLeft}px)`;
		this.tabIndicatorEl.style.width = `${btn.offsetWidth}px`;
	}

	private searchPlaceholder(): string {
		if (this.activeTab === "collection") return "Search lists…";
		if (this.activeTab === "decks") return "Search decks…";
		return "Search wantlists…";
	}

	private renderGallery(stagger = false) {
		this.galleryEl.empty();
		this.tileStaggerIndex = 0;
		this.staggerNextGallery = stagger;
		if (this.activeTab === "collection") this.renderCollectionTab();
		else if (this.activeTab === "decks") this.renderDecksTab();
		else this.renderWantlistsTab();
	}

	private matchesSearch(name: string): boolean {
		const query = this.searchQuery.trim().toLowerCase();
		return !query || name.toLowerCase().includes(query);
	}

	// Fait apparaître une tuile fraîchement construite, une par une plutôt que
	// toutes d'un coup, sur l'ouverture initiale et un changement d'onglet
	// (staggerNextGallery) — demandé explicitement ("les premières suggestions
	// pourraient apparaitre une par une"). Plafonné aux 8 premières tuiles :
	// au-delà, même délai que la 8e plutôt qu'un étirement sans fin pour une
	// longue liste — l'idée est de faire "arriver" les premiers résultats
	// visibles à l'écran, pas d'animer toute une galerie de 50 lignes
	// d'affilée. Hors stagger (recherche en cours), la classe est posée tout
	// de suite : rien à animer depuis dans le même repaint, donc aucune
	// transition ne se joue, exactement l'effet "instantané" voulu.
	private revealTile(tile: HTMLElement) {
		if (!this.staggerNextGallery) {
			tile.addClass("is-visible");
			return;
		}
		const delay = Math.min(this.tileStaggerIndex, 8) * 40;
		this.tileStaggerIndex++;
		window.setTimeout(() => tile.addClass("is-visible"), delay);
	}

	private renderNewTile(label: string, onClick: () => void) {
		const tile = this.galleryEl.createDiv({
			cls: "mtg-copy-card-gallery-tile mtg-copy-card-gallery-tile-new",
		});
		tile.createDiv({ cls: "mtg-copy-card-gallery-name", text: label });
		tile.addEventListener("click", onClick);
		this.revealTile(tile);
	}

	// `pictogram` (nom d'icône Lucide) : uniquement pour la tuile "Inbox"
	// (voir renderCollectionTab) — même traitement que sa tuile dans la
	// grille principale "My Collection" (.mtg-set-tile-inbox/renderListTile) :
	// couleur d'accent pleine, sans image/dégradé de fond, avec son petit
	// pictogramme, demandé explicitement après qu'elle soit ressortie ici
	// sans ce traitement (fond gris uni comme n'importe quelle autre liste).
	// `pictogram`/`value` : uniquement pour la tuile "Inbox" (voir
	// renderCollectionTab) — 3ᵉ ligne (valeur totale) en plus, pour
	// reproduire fidèlement sa tuile de la grille principale "My
	// Collection" (renderListTile : nom / "X unique · Y cards" / valeur),
	// demandé explicitement après une première version qui ne reprenait que
	// nom + nombre de cartes sur 2 lignes.
	private renderTile(
		coverImage: string,
		name: string,
		meta: string,
		onClick: () => void,
		pictogram?: string,
		value?: string,
		icon?: ListIcon
	) {
		const tile = this.galleryEl.createDiv({
			cls: "mtg-copy-card-gallery-tile" + (pictogram ? " mtg-copy-card-gallery-tile-inbox" : ""),
		});
		// Le fond vit sur sa propre couche (comme .mtg-set-tile-bg pour les
		// tuiles de la grille "My Collection") plutôt que directement sur la
		// tuile, pour que le zoom au survol (voir styles.css) n'affecte que
		// l'image — le texte de l'overlay, un enfant séparé, reste stable.
		// Jamais créée pour Inbox (même principe que renderListTile pour la
		// grille principale) : rien à neutraliser côté fond, le plein accent
		// vient directement de .mtg-copy-card-gallery-tile-inbox en CSS.
		if (!pictogram) {
			const bg = tile.createDiv({ cls: "mtg-copy-card-gallery-tile-bg" });
			if (coverImage) bg.style.backgroundImage = `url("${coverImage}")`;
		}
		const overlay = tile.createDiv({ cls: "mtg-copy-card-gallery-overlay" });
		if (pictogram) {
			setIcon(overlay.createDiv({ cls: "mtg-copy-card-gallery-pictogram" }), pictogram);
			const textWrap = overlay.createDiv({ cls: "mtg-copy-card-gallery-pinned-text" });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-name", text: name });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-meta", text: meta });
			if (value) {
				textWrap.createDiv({ cls: "mtg-copy-card-gallery-value", text: value });
			}
		} else if (icon) {
			// Pictogramme choisi manuellement (ListSettingsModal, "Choose icon")
			// — même cercle à légère opacité que la tuile Inbox ci-dessus
			// (.mtg-copy-card-gallery-pictogram, réutilisé tel quel), posé dans
			// une rangée imbriquée (mtg-copy-card-gallery-icon-row) plutôt que
			// sur .mtg-copy-card-gallery-overlay lui-même : cette tuile-ci garde
			// son image de fond + dégradé assombri vers le bas (contrairement à
			// Inbox, fond plat), donc le texte doit rester ancré en bas de
			// l'overlay comme avant — seul ce nouveau bloc (cercle + texte) est
			// une rangée, pas l'overlay entier. Mana affiché tel quel (déjà
			// coloré par Scryfall), édition recolorée en blanc pour rester
			// lisible dans ce cercle sombre.
			const iconRow = overlay.createDiv({ cls: "mtg-copy-card-gallery-icon-row" });
			const iconCircle = iconRow.createDiv({ cls: "mtg-copy-card-gallery-pictogram" });
			const fetchIcon =
				icon.kind === "mana"
					? this.plugin.getManaSymbolSvg(icon.value)
					: this.plugin.getSetIconSvg(icon.value);
			void fetchIcon.then((svg) => {
				if (!svg) return;
				setSvgMarkup(iconCircle, svg);
				if (icon.kind === "set") applySvgColor(iconCircle, "#ffffff");
			});
			const textWrap = iconRow.createDiv({ cls: "mtg-copy-card-gallery-icon-text" });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-name", text: name });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-meta", text: meta });
		} else {
			overlay.createDiv({ cls: "mtg-copy-card-gallery-name", text: name });
			overlay.createDiv({ cls: "mtg-copy-card-gallery-meta", text: meta });
		}
		tile.addEventListener("click", onClick);
		this.revealTile(tile);
	}

	private finishAction(destinationName: string) {
		const verb = this.mode === "move" ? "Moved" : "Copied";
		const subject =
			this.cards.length === 1 ? `"${this.cards[0].name}"` : `${this.cards.length} card(s)`;
		new Notice(`${verb} ${subject} to "${destinationName}".`);
		this.close();
		this.onDone();
	}

	private renderCollectionTab() {
		this.renderNewTile("+ New list", () => {
			new NewListModal(this.app, this.plugin, (list) => {
				this.copyToList(list.id, list.name);
			}).open();
		});
		const groups = groupByList(
			this.plugin.settings.lists,
			this.plugin.settings.collection,
			this.plugin.settings.priceCurrency
		);
		// Voir renderTile — même repérage de la liste système "Inbox" que
		// renderListTile/renderListGrid pour la grille principale
		// (CollectionList.isInbox). Épinglée en première tuile (juste après
		// "+ New list") plutôt que laissée dans l'ordre alphabétique de
		// groupByList — bug signalé : Inbox n'était première que par coïncidence
		// (quand son nom triait avant toutes les autres listes) et se
		// retrouvait ailleurs dès qu'une liste la précédait alphabétiquement.
		// Même traitement que renderListGrid (view.ts) pour la grille
		// principale : retirée du tableau, réinjectée à part en tête.
		const inboxListId = this.plugin.settings.lists.find((l) => l.isInbox)?.id;
		const inboxGroup = groups.find((g) => g.id === inboxListId);
		const otherGroups = groups.filter((g) => g.id !== inboxListId);
		const renderGroupTile = (g: (typeof groups)[number], isInbox: boolean) => {
			this.renderTile(
				g.coverImage,
				g.name,
				// "X unique · Y cards" pour Inbox (même libellé que sa tuile de
				// la grille principale, renderListTile) — les autres tuiles
				// gardent leur seule ligne "N cards", pas concernées par cette
				// demande.
				isInbox ? `${g.cards.length} unique · ${g.totalQty} cards` : `${g.totalQty} cards`,
				() => this.copyToList(g.id, g.name),
				isInbox ? "inbox" : undefined,
				isInbox ? formatMoney(g.totalValue, this.plugin.settings.priceCurrency) : undefined,
				isInbox ? undefined : g.icon
			);
		};
		if (inboxGroup && this.matchesSearch(inboxGroup.name)) {
			renderGroupTile(inboxGroup, true);
		}
		otherGroups
			.filter((g) => this.matchesSearch(g.name))
			.forEach((g) => renderGroupTile(g, false));
	}

	private copyToList(listId: string, name: string) {
		// Deck → liste : à part, contrairement aux 2 branches ci-dessous —
		// copyDeckCardToList/moveDeckCardToList (plugin.ts) sont asynchrones
		// (aller-retour Scryfall nécessaire — CollectionCard a des champs que
		// DeckCard n'a toujours pas, ex. releasedAt, prix mis à part depuis
		// le 2026-09-02) et retrouvent leur ligne par scryfallId + catégorie
		// plutôt que par id (this.deckContext.deckId fournit le deck de
		// départ).
		if (this.sourceKind === "deck") {
			const deckId = this.deckContext?.deckId;
			if (!deckId) return;
			void Promise.all(
				(this.cards as DeckCard[]).map((card) => {
					const category = getDeckCardCategory(card);
					return this.mode === "move"
						? this.plugin.moveDeckCardToList(deckId, card.scryfallId, category, listId)
						: this.plugin.copyDeckCardToList(deckId, card.scryfallId, category, listId);
				})
			).then(() => this.finishAction(name));
			return;
		}

		// Boucle sur this.cards plutôt que d'appeler une méthode plugin "bulk"
		// dédiée : copyCollectionCardToList/moveCollectionCardToList (et leurs équivalents
		// wantlist) font déjà tout le travail nécessaire par carte (fusion
		// avec une entrée existante, saveSettings() — debounced, donc N
		// appels rapides ne coûtent pas N écritures disque) ; les réutiliser
		// tels quels pour 1 carte comme pour N évite de maintenir une
		// deuxième implémentation de la même logique de fusion.
		(this.cards as (CollectionCard | WantlistCard)[]).forEach((card) => {
			if (this.sourceKind === "wantlist") {
				if (this.mode === "move") {
					this.plugin.moveWantlistCardsToCollection([card.id], listId, "", "en");
				} else {
					this.plugin.copyWantlistCardToList(card.id, listId);
				}
			} else {
				if (this.mode === "move") {
					this.plugin.moveCollectionCardToList(card.id, listId);
				} else {
					this.plugin.copyCollectionCardToList(card.id, listId);
				}
			}
		});
		this.finishAction(name);
	}

	private renderDecksTab() {
		this.renderNewTile("+ New deck", () => {
			new NewDeckModal(this.app, this.plugin, (deck) => {
				this.copyToDeck(deck.id, deck.name);
			}).open();
		});
		this.plugin.settings.decks
			// Le deck source (sourceKind === "deck") n'a pas sa place dans sa
			// propre galerie de destinations — "déplacer vers le deck où la
			// carte est déjà" n'a pas de sens, et copyDeckCardToDeck/
			// moveDeckCardToDeck (plugin.ts) traitent ce cas comme un no-op
			// explicite plutôt que de risquer une perte de carte.
			.filter((deck) => deck.id !== this.deckContext?.deckId)
			.filter((deck) => this.matchesSearch(deck.name))
			.forEach((deck) => {
				// Même choix manuel/automatique (Deck.coverCardId, "Choose cover
				// image" de DeckSettingsModal) que la grille "My Decks"
				// (renderDeckGrid) — plus la simple 1ʳᵉ carte avec une image
				// trouvée dans deck.cards.
				const cover = resolveDeckCoverImage(deck.cards, deck.coverCardId);
				const totalQty = deck.cards.reduce((s, c) => s + c.count, 0);
				this.renderTile(
					cover,
					deck.name,
					`${deck.cards.length} unique · ${totalQty} cards`,
					() => this.copyToDeck(deck.id, deck.name),
					undefined,
					undefined,
					deck.deckIcon
				);
			});
	}

	private copyToDeck(deckId: string, name: string) {
		if (this.sourceKind === "deck") {
			const fromDeckId = this.deckContext?.deckId;
			if (!fromDeckId) return;
			(this.cards as DeckCard[]).forEach((card) => {
				const category = getDeckCardCategory(card);
				if (this.mode === "move") {
					this.plugin.moveDeckCardToDeck(fromDeckId, card.scryfallId, category, deckId);
				} else {
					this.plugin.copyDeckCardToDeck(fromDeckId, card.scryfallId, category, deckId);
				}
			});
			this.finishAction(name);
			return;
		}

		(this.cards as (CollectionCard | WantlistCard)[]).forEach((card) => {
			if (this.sourceKind === "wantlist") {
				this.plugin.addWantlistCardToDeck(card, deckId);
				if (this.mode === "move") this.plugin.bulkRemoveWantlistCards([card.id]);
			} else {
				this.plugin.addCollectionCardToDeck(card, deckId);
				if (this.mode === "move") this.plugin.removeCollectionCard(card.id);
			}
		});
		this.finishAction(name);
	}

	private renderWantlistsTab() {
		this.renderNewTile("+ New wantlist", () => {
			new NewWantlistModal(this.app, this.plugin, (wantlist) => {
				this.copyToWantlist(wantlist.id, wantlist.name);
			}).open();
		});
		const groups = groupByWantlist(
			this.plugin.settings.wantlists,
			this.plugin.settings.wantlist,
			this.plugin.settings.priceCurrency
		);
		groups
			.filter((g) => this.matchesSearch(g.name))
			.forEach((g) => {
				this.renderTile(
					g.coverImage,
					g.name,
					`${g.totalQty} cards`,
					() => this.copyToWantlist(g.id, g.name),
					undefined,
					undefined,
					g.icon
				);
			});
	}

	private copyToWantlist(wantlistId: string, name: string) {
		// Voir copyToList — même raisonnement (asynchrone, aller-retour
		// Scryfall) pour copyDeckCardToWantlist/moveDeckCardToWantlist.
		if (this.sourceKind === "deck") {
			const deckId = this.deckContext?.deckId;
			if (!deckId) return;
			void Promise.all(
				(this.cards as DeckCard[]).map((card) => {
					const category = getDeckCardCategory(card);
					return this.mode === "move"
						? this.plugin.moveDeckCardToWantlist(deckId, card.scryfallId, category, wantlistId)
						: this.plugin.copyDeckCardToWantlist(deckId, card.scryfallId, category, wantlistId);
				})
			).then(() => this.finishAction(name));
			return;
		}

		(this.cards as (CollectionCard | WantlistCard)[]).forEach((card) => {
			if (this.sourceKind === "wantlist") {
				if (this.mode === "move") {
					this.plugin.moveWantlistCardToWantlist(card.id, wantlistId);
				} else {
					this.plugin.copyWantlistCardToWantlist(card.id, wantlistId);
				}
			} else {
				if (this.mode === "move") {
					this.plugin.moveCollectionCardToWantlist(card.id, wantlistId);
				} else {
					this.plugin.copyCollectionCardToWantlist(card.id, wantlistId);
				}
			}
		});
		this.finishAction(name);
	}

	onClose() {
		this.contentEl.empty();
	}
}
