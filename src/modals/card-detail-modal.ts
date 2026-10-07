import { App, Modal, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import type { MTGCollectionView } from "../view";
import {
	CollectionCard,
	isAlphaSet,
	CONDITIONS,
	getCondition,
	getLanguage,
	languagePickerOptions,
	FINISH_OPTIONS,
	getFinishLabel,
	finishHasFoilLook,
} from "../core/card-model";
import { getDeckCardFinish, isDeckCardOwned } from "../core/data-model";
import {
	BackgroundCrossfader,
	setupCardTilt,
	setupPanelScrollFade,
	toCardbaseFinish,
	setupDoubleFacedFlip,
	setupSplitCardRotation,
} from "../ui/card-detail-fx";
import { openPickerMenu } from "../ui/picker-menu";
import { createConditionIcon, createLanguageIcon, createFlagImg } from "../ui/option-icons";
import { applySvgColor, getRarityColor } from "../api/scryfall";
import { formatCardPrice, toDeckPricedCard } from "../core/price";
import { ChangePrintingModal } from "./change-printing-modal";
import { CopyCardModal } from "./copy-card-modal";
import { GradingModal } from "./grading-modal";
import { applyModalOpenAnimation, closeModalAnimated } from "../ui/modal-animation";
import { setSvgMarkup } from "../ui/svg-markup";
import {
	DetailBoxHost,
	LegalFormatsState,
	renderCardDescriptionBox,
	renderPriceHistoryBox,
	renderLegalFormatsBox,
	renderStorePricesBox,
	renderCopiesInListsBox,
	renderCardNavHeader,
	CopyTile,
} from "./shared-detail-boxes";

/* -------------------------------------------------------------------------- */
/*  Card detail modal (big image + info/actions panel)                       */
/* -------------------------------------------------------------------------- */

export class CardDetailModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private card: CollectionCard;
	private confirmingDelete = false;
	// Liste ordonnée (filtre/tri/groupement courants) dans laquelle ce card
	// a été ouvert — sert uniquement à la navigation précédent/suivant et au
	// "Card X of Y", capturée telle quelle à l'ouverture (pas mise à jour en
	// direct si la liste change pendant que la fenêtre est ouverte).
	private navCards: CollectionCard[];
	// Id utilisé pour calculer la position "Card X of Y"/l'activation des
	// flèches — distinct de this.card.id : cliquer une vignette "Other in
	// Lists" change this.card (l'affichage) sans toucher à cet ancrage, pour
	// que la barre de navigation garde la continuité de la liste d'origine
	// plutôt que de disparaître (l'autre exemplaire n'appartient pas à
	// navCards). Mis à jour uniquement par les flèches précédent/suivant
	// elles-mêmes.
	private navAnchorId: string;
	// Empêche un second clic prev/next de couper court à l'animation en cours
	// (voir animateCardNav) — levé dès le lancement de la transition d'entrée,
	// pas forcément une fois celle-ci visuellement terminée.
	private navAnimating = false;
	private bg = new BackgroundCrossfader();
	// Tuile active du carrousel "Copies in Lists" (voir renderCopiesInListsBox)
	// — capturée pour que refreshQuantityAndPrice puisse retoucher son "Nx ·
	// prix" directement, en plus du stepper et de la ligne de prix
	// principale. Sans ça, changer la quantité laissait ce carrousel affiché
	// avec l'ancien nombre : c'est une mise à jour ciblée du DOM (pas un
	// this.draw() complet, pour ne pas perdre le focus/faire clignoter le
	// panneau), donc toute valeur affichée ailleurs doit être retouchée
	// explicitement plutôt que de compter sur un nouveau rendu.
	private copiesActiveTileMetaEl: HTMLElement | null = null;
	// Affiche/masque la rangée Graded/Custom Price — recalculé depuis les
	// données de la carte à chaque fois que this.card change (constructeur +
	// les 3 endroits où this.card est réassigné plus bas), pour que le bloc
	// s'ouvre déjà déplié sur une carte qui a déjà ces infos, mais que
	// naviguer vers une autre carte reparte bien de SES propres données —
	// pas un simple défaut statique comme confirmingDelete, qui lui n'a pas
	// de sens par carte.
	private gradingExpanded: boolean;
	// Distingue "gradingExpanded vient de passer à true suite à un clic sur le
	// toggle" d'un draw() déclenché pour toute autre raison pendant que le
	// bloc est déjà ouvert (changer le finish, sauvegarder le grading, etc.) —
	// sans ça, CHAQUE redessin rejouerait l'animation d'ouverture du bloc au
	// lieu de le rendre directement dans son état final. Consommé (remis à
	// false) dès qu'il a servi une fois, dans draw() lui-même.
	private gradingJustOpened = false;
	// Distingue "premier affichage des légalités pour cette carte" d'un
	// draw() déclenché pour toute autre raison pendant que la même carte est
	// affichée (changer le finish, sauvegarder le grading, etc.) — sans ça,
	// CHAQUE redessin reconstruisait les 8 tuiles dans leur état neutre et
	// rejouait la vague au complet, même si la donnée sous-jacente (déjà en
	// cache, voir MTGCollectionPlugin.legalitiesCache) n'avait pas changé
	// (bug rapporté : la boîte "Legal Formats" semblait se "mettre à jour" à
	// chaque changement de finish, alors que les informations affichées
	// restaient identiques).
	private legalFormatsState: LegalFormatsState = { shownFor: null };
	// État du bouton "flip" 3D (voir setupDoubleFacedFlip) — comme
	// gradingExpanded ci-dessus, réinitialisé à chaque fois que this.card
	// change de référence (constructeur + les 3 endroits où this.card est
	// réassigné plus bas) : naviguer vers une autre carte doit toujours
	// repartir face avant, jamais garder le verso affiché pour une carte
	// différente. `false` couvre déjà le constructeur (valeur initiale du
	// champ), pas besoin de le réaffecter explicitement là.
	private flipped = false;
	// État du bouton "rotation" des cartes split (voir setupSplitCardRotation/
	// getSplitCardInfo) — même réinitialisation que flipped ci-dessus aux 3
	// mêmes endroits, MAIS `null` (pas `false`) : contrairement au flip, dont
	// l'état par défaut est un simple false constant, l'orientation par
	// défaut d'une carte split dépend d'une donnée async (classique → tourné,
	// Aftermath → portrait, voir getSplitCardInfo) — `null` distingue "pas
	// encore déterminé pour cette carte" d'un choix explicite (défaut
	// appliqué ou clic manuel sur le bouton), pour qu'un redessin de la MÊME
	// carte (changer le finish, sauvegarder le grading...) ne réapplique pas
	// le défaut par-dessus un choix déjà fait.
	private splitRotated: boolean | null = null;
	// Débounce du préchargement en arrière-plan des cartes voisines (voir
	// schedulePrefetchNeighbors) — une navigation rapide en Cover Flow annule
	// la planification précédente au lieu d'empiler des lots de requêtes
	// cardbase pour des cartes déjà quittées.
	private prefetchTimeout: number | null = null;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		view: MTGCollectionView,
		card: CollectionCard,
		navCards: CollectionCard[] = []
	) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.card = card;
		this.navCards = navCards;
		this.navAnchorId = card.id;
		// gradingCompany n'indique plus "gradée" à lui seul : GradingModal
		// présélectionne PSA par défaut et l'enregistre même sans note/condition
		// saisie, donc sa seule présence ne distingue plus une carte vraiment
		// gradée d'une carte jamais touchée — seules note et condition comptent.
		this.gradingExpanded = !!(card.gradingGrade != null || card.gradingLabel || card.customPrice);
	}

	onOpen() {
		this.modalEl.addClass("mtg-card-detail-modal-frame");
		// Masque la croix native d'Obsidian (classe partagée par toutes les
		// modales du plugin qui ont leur propre croix perso — voir modal-
		// animation.ts) : ce bouton lui-même vit dans contentEl, rebâti à
		// chaque draw() (voir plus bas), donc PAS ajouté via addModalCloseButton
		// ici — seule cette classe de masquage est nécessaire dans onOpen().
		this.modalEl.addClass("mtg-modal-hides-native-close");
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		this.draw();
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	// Nom de la carte centré au-dessus des deux colonnes, flanqué de flèches
	// précédent/suivant qui parcourent this.navCards (la liste filtrée/triée
	// telle qu'elle était affichée à l'ouverture de la fenêtre), avec le
	// repère "Card X of Y" en dessous. this.card change de référence sur
	// navigation puis redessine toute la fenêtre via draw() — la stepper de
	// quantité, le foil, etc. reflètent alors la carte nouvellement affichée.
	private renderNavHeader(contentEl: HTMLElement) {
		renderCardNavHeader(contentEl, {
			cards: this.navCards,
			currentIndex: this.navCards.findIndex((c) => c.id === this.navAnchorId),
			name: this.card.name,
			isAnimating: () => this.navAnimating,
			setAnimating: (animating) => {
				this.navAnimating = animating;
			},
			goTo: (card) => {
				this.card = card;
				this.gradingExpanded = !!(
					this.card.gradingGrade != null ||
					this.card.gradingLabel ||
					this.card.customPrice
				);
				this.flipped = false;
				this.splitRotated = null;
				this.navAnchorId = this.card.id;
				this.draw();
			},
		});
	}

	draw() {
		const { contentEl } = this;
		// On préserve le calque de fond (voir BackgroundCrossfader) : seul un
		// vidage sélectif (pas contentEl.empty()) permet le fondu enchaîné
		// entre deux illustrations lors de la navigation précédent/suivant.
		this.bg.clearSiblingsIn(contentEl);
		contentEl.addClass("mtg-card-detail-modal");
		// Hauteur fixe (pas seulement plafonnée) — voir styles.css pour le
		// raisonnement complet ; DeckCardDetailModal/WantlistCardDetailModal
		// ajoutent maintenant la même classe (harmonisation 2026-08-17), donc
		// les 3 modales de détail se comportent identiquement de ce point de
		// vue malgré leur contenu différent.
		contentEl.addClass("mtg-card-detail-modal-fixed-height");

		const closeBtn = contentEl.createDiv({ cls: "mtg-card-detail-close-btn" });
		setIcon(closeBtn, "x");
		closeBtn.setAttribute("title", "Close");
		closeBtn.addEventListener("click", () => this.close());

		// Fond flouté : l'illustration seule (art crop), pas la carte entière
		// avec son cadre/texte — plus immersif et lisible une fois floutée.
		if (this.card.artCropUrl) {
			this.bg.update(contentEl, this.card.artCropUrl);
		} else {
			this.bg.clear();
		}

		if (this.confirmingDelete) {
			const confirmWrap = contentEl.createDiv({ cls: "mtg-card-detail-confirm-wrap" });
			confirmWrap.createEl("h2", { text: "Remove this card?" });
			confirmWrap.createEl("p", {
				text: `Remove ${this.card.count}x "${this.card.name}" from this list? This cannot be undone.`,
				cls: "mtg-status",
			});
			const row = confirmWrap.createDiv({ cls: "mtg-svg-btn-row" });
			const yesBtn = row.createEl("button", {
				text: "Yes, remove",
				cls: "mtg-remove-btn",
			});
			yesBtn.addEventListener("click", () => {
				this.plugin.removeCollectionCard(this.card.id);
				this.close();
				this.view.render();
			});
			const noBtn = row.createEl("button", { text: "No, cancel" });
			noBtn.addEventListener("click", () => {
				this.confirmingDelete = false;
				this.draw();
			});
			return;
		}

		this.renderNavHeader(contentEl);

		const layout = contentEl.createDiv({ cls: "mtg-card-detail-layout" });

		const isAlpha = isAlphaSet(this.card.setCode);
		const imageColumn = layout.createDiv({ cls: "mtg-card-detail-image-column" });

		// Condition/langue sont affichées à deux endroits — les icônes au-dessus
		// de l'image, et les boîtes du panneau (dans la section repliable, voir
		// gradingExpanded plus bas) — choisir une valeur dans l'un des deux doit
		// mettre à jour l'autre. applyCondition/applyLanguage centralisent la
		// mutation + le rafraîchissement des deux emplacements ; les références
		// ci-dessous ne sont renseignées que si l'élément correspondant a
		// effectivement été créé (l'image seulement si this.card.imageUrl est
		// défini ; les boîtes du panneau seulement si gradingExpanded est vrai).
		// HTMLElement, pas plus précis : condGlyphImageEl/langFlagImageEl tiennent
		// soit un badge/drapeau (valeur réelle), soit l'icône Lucide de repli
		// "aucune valeur choisie" (createConditionIcon/createLanguageIcon,
		// types.ts) — deux formes DOM différentes (span texte vs span+svg
		// injecté), jamais interchangeables par simple .setText()/.style.color
		// en place. applyCondition/applyLanguage ci-dessous reconstruisent donc
		// systématiquement l'élément (remove + recreate) au lieu de le muter,
		// contrairement à l'ancien code d'avant l'ajout de ce repli.
		let condGlyphImageEl: HTMLElement | null = null;
		let condBtnImageEl: HTMLElement | null = null;
		let langFlagImageEl: HTMLElement | null = null;
		let langBtnImageEl: HTMLElement | null = null;
		let condValuePanelEl: HTMLElement | null = null;
		let langValuePanelEl: HTMLElement | null = null;

		const conditionPickerItems = () =>
			CONDITIONS.map((c) => ({
				render: (el: HTMLElement) => {
					createConditionIcon(el, c.value, "mtg-picker-condition-glyph");
					el.createSpan({ text: c.label });
				},
				onSelect: () => applyCondition(c.value),
			}));

		const applyCondition = (value: string) => {
			this.plugin.setCollectionCardCondition(this.card.id, value);
			this.card.condition = value;
			if (condBtnImageEl && condGlyphImageEl) {
				condGlyphImageEl.remove();
				condGlyphImageEl = createConditionIcon(
					condBtnImageEl,
					value,
					"mtg-card-detail-image-icon-glyph"
				);
				condBtnImageEl.setAttribute("title", getCondition(value).label);
			}
			if (condValuePanelEl) {
				condValuePanelEl.setText(getCondition(value).label);
			}
			this.view.render();
		};

		const openLanguagePickerFrom = (
			anchor: HTMLElement,
			menuOptions?: { matchAnchorWidth?: boolean; menuClass?: string }
		) => {
			void this.plugin
				.getAvailableLanguages(this.card.setCode, this.card.collectorNumber)
				.then((availableCodes) => {
					const options = languagePickerOptions(availableCodes);
					openPickerMenu(
						anchor,
						options.map((l) => ({
							render: (el: HTMLElement) => {
								createFlagImg(el, l.flag, "mtg-flag-img mtg-flag-img-inline");
								el.createSpan({ text: l.label });
							},
							onSelect: () => applyLanguage(l.code),
						})),
						menuOptions
					);
				});
		};

		const applyLanguage = (code: string) => {
			this.plugin.setCollectionCardLanguage(this.card.id, code);
			this.card.language = code;
			const lang = getLanguage(code);
			if (langBtnImageEl && langFlagImageEl) {
				langFlagImageEl.remove();
				langFlagImageEl = createLanguageIcon(
					langBtnImageEl,
					code,
					"mtg-card-detail-image-icon-flag",
					"mtg-card-detail-image-icon-glyph"
				);
				langBtnImageEl.setAttribute("title", lang.label);
			}
			if (langValuePanelEl) {
				langValuePanelEl.setText(lang.label);
			}
			this.view.render();
		};

		if (this.card.imageUrl) {
			// Condition/langue au-dessus de l'image (pas en incrustation) : ce
			// sont des attributs de l'exemplaire physique, au même titre que le
			// foil déjà incrusté sur l'image, mais placées à côté plutôt que
			// par-dessus pour ne jamais masquer l'illustration.
			const imageIcons = imageColumn.createDiv({ cls: "mtg-card-detail-image-icons" });

			const condBtn = imageIcons.createDiv({ cls: "mtg-card-detail-image-icon-btn" });
			condGlyphImageEl = createConditionIcon(
				condBtn,
				this.card.condition,
				"mtg-card-detail-image-icon-glyph"
			);
			condBtn.setAttribute("title", getCondition(this.card.condition).label);
			condBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openPickerMenu(condBtn, conditionPickerItems());
			});
			condBtnImageEl = condBtn;

			const langBtn = imageIcons.createDiv({ cls: "mtg-card-detail-image-icon-btn" });
			langFlagImageEl = createLanguageIcon(
				langBtn,
				this.card.language,
				"mtg-card-detail-image-icon-flag",
				"mtg-card-detail-image-icon-glyph"
			);
			langBtn.setAttribute("title", getLanguage(this.card.language).label);
			langBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openLanguagePickerFrom(langBtn);
			});
			langBtnImageEl = langBtn;
		}

		const viewport = imageColumn.createDiv({ cls: "mtg-card-detail-nav-viewport" });
		const imageWrap = viewport.createDiv({
			cls: isAlpha ? "mtg-card-detail-image-wrap mtg-card-detail-image-wrap-alpha" : "mtg-card-detail-image-wrap",
		});
		if (this.card.imageUrl) {
			// Le tilt/scintillement holographique (setupCardTilt) est posé sur
			// ce niveau imbriqué, pas directement sur imageWrap : imageWrap
			// porte déjà le transform du carrousel Cover Flow (animateCardNav)
			// pour la navigation précédent/suivant, et les deux se
			// disputeraient la même propriété transform s'ils visaient le même
			// élément. Le tilt 3D lui-même s'applique à toutes les finitions —
			// seuls les calques de couleur (foil-overlay/holo-shine/holo-sweep)
			// restent réservés au foil/etched, puisqu'une carte regular ne
			// scintille pas physiquement mais peut quand même être inclinée.
			const tilt = imageWrap.createDiv({ cls: "mtg-card-detail-tilt" });
			tilt.createEl("img", {
				cls: "mtg-card-detail-image",
				attr: { src: this.card.imageUrl },
			});
			if (finishHasFoilLook(this.card.finish)) {
				// Etched ne disperse pas la lumière comme foiled/surged — son
				// halo ambiant reste neutre/argenté (mtg-foil-overlay-etched)
				// plutôt que le dégradé arc-en-ciel partagé par les deux
				// autres finitions.
				tilt.createDiv({
					cls:
						this.card.finish === "etched"
							? "mtg-foil-overlay-etched"
							: "mtg-foil-overlay mtg-foil-overlay-large",
				});
				// Surge Foil obtient le reflet multi-calques façon carte Pokémon
				// "V" (voir styles.css) ; Etched obtient un effet paillettes
				// (voir styles.css) plutôt que le reflet arc-en-ciel simple
				// utilisé pour foiled — demandé explicitement, etched "ne
				// disperse pas la lumière" comme un vrai holo.
				tilt.createDiv({
					cls:
						this.card.finish === "surged"
							? "mtg-card-detail-holo-shine-surge"
							: this.card.finish === "etched"
								? "mtg-card-detail-holo-shine-etched"
								: "mtg-card-detail-holo-shine",
				});
				tilt.createDiv({ cls: "mtg-card-detail-holo-sweep" });
			}
			setupCardTilt(imageWrap, tilt);

			// Bouton "flip" 3D — uniquement pour une vraie carte double-face
			// physique (transform/modal_dfc), voir getDoubleFacedImages
			// (scryfall.ts). Le guard de péremption suit la même convention que
			// les autres boîtes de ce panneau qui dépendent d'un aller-retour
			// Scryfall (Legal Formats, Store Prices, Price History plus bas) :
			// requestedId capturé au lancement, comparé à this.card.scryfallId
			// une fois la promesse résolue, pour ignorer une réponse arrivée
			// après une navigation prev/next vers une autre carte.
			const flipRequestedId = this.card.scryfallId;
			void this.plugin.getCardFaceImages(flipRequestedId).then((images) => {
				if (!images || this.card.scryfallId !== flipRequestedId) return;
				setupDoubleFacedFlip(imageColumn, tilt, images.back, this.flipped, (flipped) => {
					this.flipped = flipped;
				});
			});

			// Bouton "rotation" — uniquement pour un layout split (Fire // Ice,
			// Never // Return...), voir getSplitCardInfo (scryfall.ts). Mutuellement
			// exclusif avec le flip ci-dessus (une carte est soit une vraie
			// double-face, soit split, jamais les deux — voir getDoubleFacedImages/
			// getSplitCardInfo), même guard de péremption que lui.
			const splitRequestedId = this.card.scryfallId;
			void this.plugin.getSplitCardInfo(splitRequestedId).then((info) => {
				if (!info || this.card.scryfallId !== splitRequestedId) return;
				if (this.splitRotated === null) this.splitRotated = false;
				setupSplitCardRotation(imageColumn, tilt, this.splitRotated, (rotated) => {
					this.splitRotated = rotated;
				});
			});
		}

		const panel = layout.createDiv({ cls: "mtg-card-detail-panel" });

		const headerRow = panel.createDiv({ cls: "mtg-card-detail-header-row" });
		const setBox = headerRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-set-box mtg-card-detail-set-box-clickable",
		});
		setBox.setAttribute("title", "View all versions");
		const setBadge = setBox.createDiv({ cls: "mtg-card-detail-set-badge" });
		void this.plugin.getSetIconSvg(this.card.setCode).then((svg) => {
			if (!svg) return;
			setSvgMarkup(setBadge, svg);
			const svgEl = setBadge.querySelector("svg");
			if (svgEl) {
				svgEl.setAttribute("width", "20");
				svgEl.setAttribute("height", "20");
			}
			applySvgColor(setBadge, getRarityColor(this.card.rarity));
		});
		setBox.createDiv({ cls: "mtg-card-detail-set-box-name", text: this.card.setName });
		setBox.createDiv({ cls: "mtg-card-detail-set-box-versions", text: "View all versions" });
		setBox.createDiv({
			cls: "mtg-card-detail-set-box-code",
			text: `${this.card.setCode.toUpperCase()} #${this.card.collectorNumber}`,
		});
		setBox.addEventListener("click", () => {
			new ChangePrintingModal(this.app, this.plugin, this.card, () => {
				this.view.render();
				this.draw();
			}).open();
		});

		const deleteBtn = headerRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-icon-box mtg-delete-icon-btn",
		});
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttribute("title", "Remove from list");
		deleteBtn.addEventListener("click", () => {
			this.confirmingDelete = true;
			this.draw();
		});

		const attrRow = panel.createDiv({ cls: "mtg-card-detail-box-row" });

		const qtyBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-qty-box" });
		qtyBox.createDiv({ cls: "mtg-card-detail-qty-label", text: "Quantity" });
		const stepper = qtyBox.createDiv({ cls: "mtg-stepper mtg-stepper-horizontal" });
		const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
		const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
		setIcon(downBtn, "minus");
		downBtn.toggleClass("is-disabled", this.card.count <= 1);
		const valueEl = controls.createDiv({
			cls: "mtg-stepper-value",
			text: String(this.card.count),
		});
		const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
		setIcon(upBtn, "plus");

		const finishBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-finish-box" });
		finishBox.setAttribute("title", "Change finish");
		finishBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Finish" });
		const finishValueRow = finishBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
		finishValueRow.createSpan();
		finishValueRow.createSpan({
			cls: "mtg-card-detail-finish-value",
			text: getFinishLabel(this.card.finish),
		});
		setIcon(finishValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
		finishBox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			openPickerMenu(
				finishBox,
				FINISH_OPTIONS.map((f) => ({
					render: (el: HTMLElement) => el.createSpan({ text: f.label }),
					onSelect: () => {
						this.plugin.setCollectionCardFinish(this.card.id, f.value);
						this.card.finish = f.value;
						this.view.render();
						this.draw();
					},
				})),
				{ matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" }
			);
		});

		const copyBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-icon-box" });
		setIcon(copyBox, "copy");
		copyBox.setAttribute("title", "Copy card to…");
		copyBox.addEventListener("click", () => {
			// this.draw() (pas seulement this.view.render()) : la modale reste
			// ouverte après une copie (contrairement au déplacement plus bas, qui
			// se ferme puisque la carte quitte cette liste) — sans réafficher son
			// propre contenu, le bloc "Copies in Lists" restait sur l'instantané
			// capturé à l'ouverture de la modale, sans la copie qui vient d'être
			// créée (bug signalé).
			new CopyCardModal(this.app, this.plugin, [this.card], "collection", () => {
				this.view.render();
				this.draw();
			}).open();
		});

		const gradingToggleBox = attrRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-icon-box",
		});
		setIcon(gradingToggleBox, this.gradingExpanded ? "chevron-up" : "chevron-down");
		gradingToggleBox.setAttribute("title", "Grading & custom price");
		// Le wrapper est rempli plus bas (uniquement si gradingExpanded est déjà
		// vrai à ce point du draw()) — la fermeture s'appuie dessus directement
		// (retirer is-expanded déclenche la transition CSS) sans repasser par
		// draw(), donc cette closure doit voir la valeur à jour au moment du
		// clic, pas seulement à la création. Ça marche : gradingWrapperEl est
		// affecté plus bas dans ce même appel synchrone à draw(), donc par le
		// temps où un clic peut réellement arriver, il pointe déjà vers le bon
		// élément (ou reste null si le bloc n'était pas ouvert).
		let gradingWrapperEl: HTMLElement | null = null;
		gradingToggleBox.addEventListener("click", () => {
			if (this.gradingExpanded) {
				this.gradingExpanded = false;
				setIcon(gradingToggleBox, "chevron-down");
				if (gradingWrapperEl) {
					// Anime la fermeture sur l'élément existant (déjà peint), sans
					// attendre un draw() complet — puis, une fois la transition
					// terminée, un draw() retardé retire le bloc du DOM pour de bon
					// (même minuterie de 300ms que toggleGroupRows pour les groupes).
					// Fige la hauteur actuelle (mesurée, "auto" ne s'anime pas) en
					// pixels explicites avant de retirer is-expanded, sinon la
					// transition "height" n'a rien de concret à partir duquel
					// interpoler. La lecture de offsetHeight qui suit force le
					// navigateur à appliquer cette valeur AVANT le changement
					// suivant (sans quoi les deux se fondent en une seule opération
					// et la transition ne voit jamais l'état de départ).
					const currentHeight = gradingWrapperEl.getBoundingClientRect().height;
					gradingWrapperEl.style.height = `${currentHeight}px`;
					void gradingWrapperEl.offsetHeight;
					gradingWrapperEl.removeClass("is-expanded");
					// Plus de hauteur en ligne : la classe de base fait height:0 (styles.css), la transition part de
					// la valeur en pixels posée juste au-dessus.
					gradingWrapperEl.style.removeProperty("height");
					window.setTimeout(() => {
						if (!this.gradingExpanded) this.draw();
					}, 300);
				} else {
					this.draw();
				}
			} else {
				this.gradingExpanded = true;
				this.gradingJustOpened = true;
				setIcon(gradingToggleBox, "chevron-up");
				this.draw();
			}
		});

		if (this.gradingExpanded) {
			const gradingWrapper = panel.createDiv({ cls: "mtg-card-detail-grading-wrapper" });
			gradingWrapperEl = gradingWrapper;
			// Regroupe visuellement tout ce que le toggle révèle (Condition/
			// Language + Graded/Custom Price) dans un seul contour en pointillé,
			// pour qu'on comprenne au premier coup d'œil que ces boîtes forment
			// un bloc à part plutôt que de simplement continuer la liste des
			// boîtes toujours visibles au-dessus. Purement cosmétique — depuis
			// le passage à une hauteur en pixels mesurée (voir plus bas et
			// styles.css), gradingWrapper n'a plus besoin d'un enfant unique
			// pour s'animer, contrairement à l'ancienne technique grid-
			// template-rows.
			const gradingContent = gradingWrapper.createDiv({ cls: "mtg-card-detail-grading-content" });

			const conditionLanguageRow = gradingContent.createDiv({ cls: "mtg-card-detail-box-row" });

			const condBox = conditionLanguageRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box",
			});
			condBox.setAttribute("title", "Change condition");
			condBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Condition" });
			const condValueRow = condBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
			condValueRow.createSpan();
			condValuePanelEl = condValueRow.createSpan({
				cls: "mtg-card-detail-finish-value",
				text: getCondition(this.card.condition).label,
			});
			setIcon(condValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
			condBox.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openPickerMenu(condBox, conditionPickerItems(), {
					matchAnchorWidth: true,
					menuClass: "mtg-finish-picker-menu",
				});
			});

			const langBox = conditionLanguageRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box",
			});
			langBox.setAttribute("title", "Change language");
			langBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Language" });
			const langValueRow = langBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
			langValueRow.createSpan();
			langValuePanelEl = langValueRow.createSpan({
				cls: "mtg-card-detail-finish-value",
				text: getLanguage(this.card.language).label,
			});
			setIcon(langValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
			langBox.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openLanguagePickerFrom(langBox, { matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" });
			});

			const gradingRow = gradingContent.createDiv({ cls: "mtg-card-detail-box-row" });

			const gradedBox = gradingRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box",
			});
			gradedBox.setAttribute("title", "Set grading");
			gradedBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Graded" });
			// Pas de flèche ici (contrairement à Condition/Language/Finish) :
			// demandé explicitement — "Graded" ouvre GradingModal en raccourci, ce
			// n'est pas un picker inline, donc pas de gouttière 1em/auto à équilibrer
			// (voir mtg-card-detail-finish-value-row-no-caret en CSS pour le
			// recentrage à une seule colonne que ça implique).
			const gradedValueRow = gradedBox.createDiv({
				cls: "mtg-card-detail-finish-value-row mtg-card-detail-finish-value-row-no-caret",
			});
			gradedValueRow.createSpan({
				cls: "mtg-card-detail-finish-value",
				// gradingCompany seul ne suffit plus à dire "gradée" (voir
				// gradingExpanded plus haut) — GradingModal présélectionne PSA par
				// défaut et l'enregistre même sans note/condition saisie.
				text:
					this.card.gradingGrade != null || this.card.gradingLabel
						? `${this.card.gradingCompany ?? ""} ${this.card.gradingGrade ?? ""} ${
								this.card.gradingLabel ?? ""
						  }`
								.replace(/\s+/g, " ")
								.trim()
						: "Not graded",
			});
			gradedBox.addEventListener("click", () => {
				new GradingModal(this.app, this.plugin, this.card, () => {
					this.view.render();
					this.draw();
				}).open();
			});

			// Pas de modale ici (contrairement à gradedBox) : l'utilisateur tape
			// son prix directement dans la boîte, sauvegardé via setCollectionCardCustomPrice
			// au blur/Entrée. Ne jamais appeler this.draw()/this.view.render()
			// depuis ces handlers — un redessin en plein milieu de la frappe
			// couperait le focus (même risque que pendingFocusRestore documenté
			// ailleurs dans ce fichier), et rien d'autre dans le panneau n'affiche
			// customPrice à mettre à jour en retour.
			const customPriceBox = gradingRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box mtg-card-detail-customprice-box",
			});
			customPriceBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Custom price" });
			const priceInput = customPriceBox.createEl("input", {
				cls: "mtg-card-detail-customprice-input",
				type: "text",
			});
			priceInput.value = this.card.customPrice ?? "";
			priceInput.setAttribute("placeholder", "For example, $45");
			const commitCustomPrice = () => {
				this.plugin.setCollectionCardCustomPrice(this.card.id, priceInput.value);
			};
			priceInput.addEventListener("blur", commitCustomPrice);
			priceInput.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") priceInput.blur();
			});

			// La toute première ouverture part de l'état replié (voir la classe de
			// base dans styles.css) puis passe à is-expanded une frame plus tard,
			// pour que la transition CSS ait un changement d'état réel à animer —
			// sans le rAF, l'élément apparaîtrait déjà dans son état final dès sa
			// première peinture, sans transition visible. Un draw() qui retombe
			// ici pour une tout autre raison (bloc déjà ouvert) saute directement
			// à l'état final, sans rejouer l'animation d'entrée.
			if (this.gradingJustOpened) {
				this.gradingJustOpened = false;
				// scrollHeight mesure la hauteur naturelle du contenu déjà
				// construit ci-dessus MALGRÉ le height:0/overflow:hidden actuel
				// (posé par la classe de base en CSS) — c'est justement ce que
				// scrollHeight est fait pour rapporter. Posée en même temps que
				// is-expanded, dans le même callback rAF, pour que height/
				// margin-bottom/opacity démarrent tous les trois leur transition
				// depuis le même état peint, au même instant (voir styles.css
				// pour pourquoi ça remplace l'ancienne technique grid-template-
				// rows, qui n'a pas gardé ces propriétés parfaitement en phase
				// malgré une durée/courbe déclarée identique).
				const targetHeight = gradingWrapper.scrollHeight;
				window.requestAnimationFrame(() => {
					gradingWrapper.addClass("is-expanded");
					gradingWrapper.style.height = `${targetHeight}px`;
				});
				window.setTimeout(() => {
					// Repasse à "auto" une fois la transition terminée : une valeur
					// figée en pixels resterait fausse si le contenu change de
					// hauteur ensuite (ex. sélectionner une mention de note plus
					// longue dans Graded) sans repasser par ce chemin d'ouverture.
					// "auto" est celui de .is-expanded (styles.css) : on retire la
					// valeur en pixels. Sur un bloc refermé entre-temps (il n'a plus
					// is-expanded) la hauteur reste donc 0 — l'ancien code le rouvrait
					// d'un coup en posant "auto" en ligne.
					gradingWrapper.style.removeProperty("height");
				}, 300);
			} else {
				// Redessin pendant que le bloc est déjà ouvert (changer le finish,
				// sauvegarder le grading…) : pas d'animation à rejouer, la hauteur
				// suit directement le contenu (height:auto de .is-expanded).
				gradingWrapper.addClass("is-expanded");
			}
		}

		const list = this.plugin.settings.lists.find((l) => l.id === this.card.listId);
		const listBoxRow = panel.createDiv({ cls: "mtg-card-detail-box-row" });
		const listBox = listBoxRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-list-box mtg-card-detail-set-box-clickable",
		});
		listBox.setAttribute("title", "Move card to another list…");
		listBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "List" });
		listBox.createDiv({ cls: "mtg-card-detail-list-box-value", text: list?.name ?? "" });
		listBox.addEventListener("click", () => {
			new CopyCardModal(
				this.app,
				this.plugin,
				[this.card],
				"collection",
				() => {
					this.close();
					this.view.render();
				},
				"move"
			).open();
		});

		this.renderCopiesInListsBox(panel);
		this.renderLegalFormatsBox(panel);
		this.renderStorePricesBox(panel);
		this.renderPriceHistoryBox(panel);
		this.renderCardDescriptionBox(panel);

		const refreshQuantityAndPrice = () => {
			valueEl.setText(String(this.card.count));
			if (this.copiesActiveTileMetaEl) {
				this.copiesActiveTileMetaEl.setText(
					`${this.card.count}x · ${formatCardPrice(this.card, this.plugin.settings.priceCurrency)}`
				);
			}
			this.view.render();
		};

		upBtn.addEventListener("click", () => {
			this.plugin.changeCollectionCardCount(this.card.id, 1, () => {
				refreshQuantityAndPrice();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});
		downBtn.addEventListener("click", () => {
			this.plugin.changeCollectionCardCount(this.card.id, -1, () => {
				refreshQuantityAndPrice();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});

		setupPanelScrollFade(panel);
	}

	private renderCopiesInListsBox(panel: HTMLElement) {
		const others: CopyTile[] = [];

		this.plugin.settings.collection
			.filter((c) => c.name === this.card.name && c.id !== this.card.id)
			.forEach((c) => {
				others.push({
					kind: "collection",
					sourceName: this.plugin.settings.lists.find((l) => l.id === c.listId)?.name ?? "",
					imageUrl: c.imageUrl,
					finish: c.finish,
					count: c.count,
					priceText: formatCardPrice(c, this.plugin.settings.priceCurrency),
					onClick: () => {
						this.card = c;
						this.gradingExpanded = !!(
							this.card.gradingGrade != null ||
							this.card.gradingLabel ||
							this.card.customPrice
						);
						this.flipped = false;
						this.splitRotated = null;
						this.draw();
					},
				});
			});

		this.plugin.settings.decks.forEach((deck) => {
			deck.cards
				.filter((c) => c.name === this.card.name)
				.forEach((c) => {
					others.push({
						kind: "deck",
						sourceName: deck.name,
						imageUrl: c.imageUrl,
						finish: getDeckCardFinish(c),
						count: c.count,
						priceText: formatCardPrice(toDeckPricedCard(c), this.plugin.settings.priceCurrency),
						wanted: !isDeckCardOwned(c),
						onClick: () => {
							this.close();
							this.view.openDeckCardDetailById(deck.id, c.scryfallId);
						},
					});
				});
		});

		this.plugin.settings.wantlist
			.filter((c) => c.name === this.card.name)
			.forEach((c) => {
				others.push({
					kind: "wantlist",
					sourceName: this.plugin.settings.wantlists.find((w) => w.id === c.listId)?.name ?? "",
					imageUrl: c.imageUrl,
					finish: c.finish,
					count: c.count,
					priceText: formatCardPrice(c, this.plugin.settings.priceCurrency),
					onClick: () => {
						this.close();
						this.view.openWantlistCardDetailById(c.id);
					},
				});
			});

		renderCopiesInListsBox(
			panel,
			{
				kind: "collection",
				sourceName: this.plugin.settings.lists.find((l) => l.id === this.card.listId)?.name ?? "",
				imageUrl: this.card.imageUrl,
				finish: this.card.finish,
				count: this.card.count,
				priceText: formatCardPrice(this.card, this.plugin.settings.priceCurrency),
			},
			others,
			(meta) => {
				this.copiesActiveTileMetaEl = meta;
			}
		);
	}

	// Les boîtes ci-dessous sont communes aux trois fenêtres de détail (voir shared-detail-boxes.ts) :
	// ces méthodes ne font que leur donner ce qui est propre à CETTE section.
	private detailHost(): DetailBoxHost {
		return { plugin: this.plugin, currentScryfallId: () => this.card.scryfallId };
	}

	private renderLegalFormatsBox(panel: HTMLElement) {
		renderLegalFormatsBox(this.detailHost(), panel, this.card, this.legalFormatsState);
	}

	private renderStorePricesBox(panel: HTMLElement) {
		renderStorePricesBox(this.detailHost(), panel, {
			scryfallId: this.card.scryfallId,
			name: this.card.name,
			finish: this.card.finish,
			pricedCard: this.card,
		});
	}

	private renderPriceHistoryBox(panel: HTMLElement) {
		renderPriceHistoryBox(
			this.detailHost(),
			panel,
			{ scryfallId: this.card.scryfallId, finish: this.card.finish },
			() => this.schedulePrefetchNeighbors()
		);
	}

	private renderCardDescriptionBox(panel: HTMLElement) {
		renderCardDescriptionBox(this.detailHost(), panel, this.card);
	}

	// Voir MTGCollectionPlugin.prefetchCardbaseNeighbors pour le raisonnement
	// complet (fenêtre selon clé API, séquentiel, dédoublonné par cache). Le
	// debounce ici (500ms) évite qu'une navigation rapide en Cover Flow
	// n'empile une planification de préchargement par carte traversée — seule
	// la dernière carte réellement restée affichée un instant déclenche un
	// vrai lot de requêtes.
	private schedulePrefetchNeighbors() {
		if (this.prefetchTimeout != null) window.clearTimeout(this.prefetchTimeout);
		const centerIndex = this.navCards.findIndex((c) => c.id === this.navAnchorId);
		if (centerIndex === -1 || this.navCards.length < 2) return;
		this.prefetchTimeout = window.setTimeout(() => {
			const items = this.navCards.map((c) =>
				c.finish === "proxy" ? null : { scryfallId: c.scryfallId, finish: toCardbaseFinish(c.finish) }
			);
			void this.plugin.prefetchCardbaseNeighbors(items, centerIndex);
		}, 500);
	}

	onClose() {
		this.contentEl.empty();
	}
}
