import { App, Modal, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { GradingCompany, GRADING_TERMS } from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { GRADING_COMPANY_LOGOS } from "../ui/brand-assets";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import { setSvgMarkup } from "../ui/svg-markup";

// Édite uniquement la société de grading + la note (ouverte seulement par la
// boîte "Graded" du panneau de détail) — le prix perso avait initialement sa
// propre boîte ouvrant cette même modale, mais s'édite maintenant en ligne
// directement dans sa boîte (voir customPriceBox dans CardDetailModal.draw),
// donc cette fenêtre ne concerne plus que le grading, comme demandé.
// Sélecteur en tuiles logo (PSA/BGS/CGC) plutôt qu'un <select> — demandé
// explicitement pour sélectionner directement la société d'un coup d'œil.
// Un 4e choix "Other" existait initialement (voir GRADING_COMPANY_OPTIONS,
// toujours utilisé par l'import CSV) mais a été retiré de CE sélecteur par
// choix explicite ("pas utile") — une carte déjà gradée "Other" par une
// ancienne version ou un import CSV reste lisible/sauvegardable normalement,
// simplement plus aucune tuile ne permet de la sélectionner à nouveau. draw()
// reconstruit tout le contenu à chaque changement de société (même pattern
// que CopyCardModal.draw et ses onglets) — ce code ne passe jamais par l'API
// Setting d'Obsidian pour ses propres modales de carte, uniquement pour
// l'onglet de réglages du plugin.
// Note et Condition (renommées depuis Grade/Appreciation) sont deux champs
// INDÉPENDANTS l'un de l'autre — demandé explicitement après une première
// version qui les synchronisait automatiquement (choisir une mention
// remplissait la note, taper la note effaçait la mention) : "je ne souhaite
// pas qu'il y ait de lien direct... s'il met une note de 2 et qu'il
// sélectionne 'Near Mint', c'est son erreur." Donc plus aucun des deux
// handlers ne touche à l'état de l'autre.
// PSA présélectionnée par défaut (demandé explicitement) quand la carte n'a
// pas encore de société propre — selectedCompany n'est donc plus jamais
// undefined une fois la modale ouverte, d'où son type non-optionnel
// ci-dessous (contrairement à CollectionCard.gradingCompany, qui lui reste
// optionnel : une carte jamais ouverte dans cette modale n'a toujours rien
// en base). Une conséquence : gradingCompany seul ne veut plus dire "cette
// carte est gradée" ailleurs dans ce fichier (voir gradingExpanded et la
// boîte "Graded" dans CardDetailModal.draw) — Save enregistre PSA même sans
// note ni condition saisie, donc seules note/condition font foi pour ça.
// Carte source minimale nécessaire à cette modale — CollectionCard ET DeckCard
// satisfont toutes les deux cette forme (voir "source"/"deckContext"
// ci-dessous, même principe que ChangePrintingModal pour la même raison :
// DeckCard n'a pas de champ id propre, voir "Data model notes" dans
// CLAUDE.md). `id` optionnel : inutilisé quand source === "deck", auquel
// cas deckContext (deckId + scryfallId) sert de clé à la place, voir
// MTGCollectionPlugin.setDeckCardGrading.
export interface GradableCard {
	id?: string;
	gradingCompany?: GradingCompany;
	gradingGrade?: number;
	gradingLabel?: string;
}

export class GradingModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private card: GradableCard;
	private onDone: () => void;
	// Distingue quelle méthode plugin appeler (setCollectionCardGrading vs
	// setDeckCardGrading, deux tableaux différents) sans dupliquer toute la
	// modale — même principe que ChangePrintingModal.source.
	private source: "collection" | "deck";
	private deckContext?: { deckId: string; scryfallId: string };
	private selectedCompany: GradingCompany;
	private gradeValue: string;
	private gradingLabel: string | undefined;
	// Distingue "selectedCompany vient de changer suite à un clic sur une
	// tuile" d'un draw() déclenché pour toute autre raison (choisir une
	// mention dans Condition, par ex.) pendant que cette société est déjà
	// sélectionnée — même pattern que gradingJustOpened dans CardDetailModal.
	// Sans ça, CHAQUE redessin rejouerait l'effet zoom de la tuile
	// sélectionnée au lieu de la rendre directement dans son état final.
	// Consommé (remis à false) dès qu'il a servi une fois, dans renderTile.
	private companyJustChanged = false;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		card: GradableCard,
		onDone: () => void,
		source: "collection" | "deck" = "collection",
		deckContext?: { deckId: string; scryfallId: string }
	) {
		super(app);
		this.plugin = plugin;
		this.card = card;
		this.onDone = onDone;
		this.source = source;
		this.deckContext = deckContext;
		this.selectedCompany = card.gradingCompany ?? "PSA";
		this.gradeValue = card.gradingGrade != null ? String(card.gradingGrade) : "";
		this.gradingLabel = card.gradingLabel;
	}

	// Point d'écriture unique — les deux call sites (Clear/Save ci-dessous)
	// passent par ici plutôt que de dupliquer le branchement source.
	private saveGrading(company: GradingCompany | undefined, grade: number | undefined, label: string | undefined) {
		if (this.source === "deck" && this.deckContext) {
			this.plugin.setDeckCardGrading(this.deckContext.deckId, this.deckContext.scryfallId, company, grade, label);
		} else if (this.card.id) {
			this.plugin.setCollectionCardGrading(this.card.id, company, grade, label);
		}
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		// Construite une seule fois ici plutôt que dans draw() : voir la note
		// de addModalCloseButton pour pourquoi (modalEl, contrairement à
		// contentEl, n'est jamais vidé entre deux redessins).
		addModalCloseButton(this);
		this.draw();
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	private selectCompany(company: GradingCompany) {
		if (this.selectedCompany === company) return;
		this.selectedCompany = company;
		// La condition dépend du barème de la société choisie — une mention
		// encore affichée après avoir changé de société pointerait vers un
		// barème qui n'est plus le bon.
		this.gradingLabel = undefined;
		this.companyJustChanged = true;
		this.draw();
	}

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mtg-list-actions-modal");
		// Scope pour --mtg-detail-box-h et les quelques overrides propres à
		// cette modale (boîte Condition désactivée, alignement du bouton) —
		// plus utilisée pour positionner le bouton de fermeture (voir onOpen),
		// qui s'ancre maintenant directement sur modalEl.
		contentEl.addClass("mtg-grading-modal");

		contentEl.createEl("h2", { text: "Grading" });

		const picker = contentEl.createDiv({ cls: "mtg-grading-company-picker" });
		const row = picker.createDiv({ cls: "mtg-grading-company-row" });
		(["PSA", "BGS", "CGC"] as const).forEach((company) => this.renderTile(row, company));

		// Même famille de boîtes que le panneau de détail d'une carte, réutilisée
		// telle quelle ici — demandé explicitement ("présente le champ Grade de
		// la même manière que Custom Price", "le bloc Appreciation comme le
		// bloc Finish"). --mtg-detail-box-h n'est normalement définie que dans
		// .mtg-card-detail-panel ; redéfinie ici sur .mtg-grading-modal pour que
		// ces boîtes aient la même hauteur fixe que leurs équivalents là-bas au
		// lieu de retomber sur une hauteur automatique.
		const fieldsRow = picker.createDiv({ cls: "mtg-card-detail-box-row" });

		const gradeBox = fieldsRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-finish-box mtg-card-detail-customprice-box mtg-grading-grade-box",
		});
		gradeBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Note" });
		const gradeInput = gradeBox.createEl("input", {
			cls: "mtg-card-detail-customprice-input",
			type: "number",
			attr: { min: "1", max: "10", step: "0.5" },
		});
		gradeInput.value = this.gradeValue;
		gradeInput.addEventListener("input", () => {
			this.gradeValue = gradeInput.value;
		});

		const appreciationBox = fieldsRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-finish-box mtg-grading-appreciation-box",
		});
		const terms = this.selectedCompany !== "Other" ? GRADING_TERMS[this.selectedCompany] : [];
		appreciationBox.toggleClass("is-disabled", terms.length === 0);
		appreciationBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Condition" });
		const apprValueRow = appreciationBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
		apprValueRow.createSpan();
		apprValueRow.createSpan({
			cls: "mtg-card-detail-finish-value",
			text: this.gradingLabel ?? "—",
		});
		setIcon(apprValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
		appreciationBox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (!terms.length) return;
			openPickerMenu(
				appreciationBox,
				[
					{
						render: (el: HTMLElement) => el.createSpan({ text: "—" }),
						onSelect: () => {
							this.gradingLabel = undefined;
							this.draw();
						},
					},
					...terms.map((term) => ({
						render: (el: HTMLElement) =>
							el.createSpan({ text: `${term.label} — ${term.name}` }),
						onSelect: () => {
							this.gradingLabel = term.label;
							this.draw();
						},
					})),
				],
				{ matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" }
			);
		});

		// Boîte carrée avec une croix, plutôt qu'un bouton "Clear" en bas —
		// demandé explicitement, positionnée à droite de Condition. Ne
		// supprime QUE la note et la condition (pas la société choisie) — et,
		// contrairement à Save, n'enregistre pas en fermant la fenêtre :
		// "ce bouton ne ferme pas la fenêtre". Enregistre immédiatement
		// (contrairement à Save/Note/Condition, dont les autres modifications
		// n'existent que localement jusqu'au clic sur Save) puisqu'il s'agit
		// d'une suppression explicite plutôt que d'une saisie en cours — voir
		// aussi CLAUDE.md pour le raisonnement complet.
		const deleteBox = fieldsRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-icon-box" });
		setIcon(deleteBox, "x");
		deleteBox.setAttribute("title", "Clear note & condition");
		deleteBox.addEventListener("click", () => {
			this.gradeValue = "";
			this.gradingLabel = undefined;
			this.saveGrading(this.selectedCompany, undefined, undefined);
			this.onDone();
			this.draw();
		});

		const btnRow = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-grading-modal-btn-row" });
		const saveBtn = btnRow.createEl("button", { text: "Save and close", cls: "mtg-search-add-btn" });
		saveBtn.addEventListener("click", () => {
			const gradeRaw = this.gradeValue.trim();
			const grade = gradeRaw ? Number(gradeRaw) : undefined;
			if (grade !== undefined && (Number.isNaN(grade) || grade < 1 || grade > 10)) {
				new Notice("Grade must be between 1 and 10.");
				return;
			}
			this.saveGrading(this.selectedCompany, grade, this.gradingLabel);
			this.close();
			this.onDone();
		});
	}

	// La couleur de marque (fond + logo) vit sur un wrapper interne
	// (mtg-grading-company-tile-inner), pas sur la tuile elle-même — c'est ce
	// wrapper qui rétrécit (transform:scale) quand sa société n'est pas
	// sélectionnée, laissant apparaître le fond neutre de la tuile autour en
	// guise de marge, plutôt que la tuile entière rétrécissant dans son
	// propre cadre. Demandé explicitement : la société sélectionnée doit
	// "remplir entièrement le carré" (contour couleur d'accent), les autres
	// doivent être visiblement "plus petites dans le carré... comme avec une
	// petite marge" (contour gris foncé) — voir styles.css pour l'animation.
	private renderTile(parent: HTMLElement, company: GradingCompany) {
		const isSelected = this.selectedCompany === company;
		// Si cette tuile vient d'être sélectionnée par un clic, on la construit
		// d'abord SANS is-selected (donc rétrécie) puis on l'ajoute une frame
		// plus tard, pour que la transition CSS ait un changement d'état réel
		// à partir duquel s'animer — sans ce délai, draw() reconstruit tout le
		// DOM d'un coup et l'élément apparaîtrait déjà dans son état final dès
		// sa première peinture, sans effet zoom visible (même technique que
		// gradingJustOpened dans CardDetailModal).
		const deferSelection = isSelected && this.companyJustChanged;
		const tile = parent.createDiv({
			cls: "mtg-grading-company-tile" + (isSelected && !deferSelection ? " is-selected" : ""),
		});
		const inner = tile.createDiv({
			cls: "mtg-grading-company-tile-inner mtg-grading-company-tile-" + company.toLowerCase(),
		});
		const logoSvg = GRADING_COMPANY_LOGOS[company];
		if (logoSvg) {
			setSvgMarkup(inner.createDiv({ cls: "mtg-grading-company-logo" }), logoSvg);
		} else {
			inner.createDiv({ cls: "mtg-grading-company-name", text: company });
		}
		if (deferSelection) {
			this.companyJustChanged = false;
			window.requestAnimationFrame(() => tile.addClass("is-selected"));
		}
		tile.addEventListener("click", () => this.selectCompany(company));
	}

	onClose() {
		this.contentEl.empty();
	}
}
