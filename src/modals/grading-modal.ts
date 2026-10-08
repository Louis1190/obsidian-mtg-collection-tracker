import { App, Modal, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { GradingCompany, GRADING_TERMS } from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { GRADING_COMPANY_LOGOS } from "../ui/brand-assets";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import { setSvgMarkup } from "../ui/svg-markup";

// Edits only the grading company + the grade (opened only by the "Graded" box
// of the detail panel) — the custom price initially had its own box opening
// this same modal, but is now edited inline directly in its box (see
// customPriceBox in CardDetailModal.draw), so this window now only concerns
// grading, as requested.
// Selector as logo tiles (PSA/BGS/CGC) rather than a <select> — explicitly
// requested to select the company directly at a glance. A 4th "Other" choice
// initially existed (see GRADING_COMPANY_OPTIONS, still used by the CSV
// import) but was removed from THIS selector by explicit choice ("not useful")
// — a card already graded "Other" by an old version or a CSV import remains
// readable/saveable normally, simply no tile allows selecting it again. draw()
// rebuilds the whole content on every company change (same pattern as
// CopyCardModal.draw and its tabs) — this code never goes through Obsidian's
// Setting API for its own card modals, only for the plugin's settings tab.
// Grade and Condition (renamed from Grade/Appreciation) are two fields
// INDEPENDENT of each other — explicitly requested after a first version that
// synchronized them automatically (choosing a label filled in the grade,
// typing the grade erased the label): "I don't want there to be a direct
// link... if they enter a grade of 2 and select 'Near Mint', that's their
// mistake." So neither handler touches the other's state any more.
// PSA preselected by default (explicitly requested) when the card doesn't have
// a company of its own yet — selectedCompany is therefore never undefined once
// the modal is open, hence its non-optional type below (unlike
// CollectionCard.gradingCompany, which remains optional: a card never opened
// in this modal still has nothing in the database). A consequence:
// gradingCompany alone no longer means "this card is graded" elsewhere in this
// file (see gradingExpanded and the "Graded" box in CardDetailModal.draw) —
// Save records PSA even with no grade or condition entered, so only
// grade/condition are authoritative for that.
// Minimal source card needed by this modal — CollectionCard AND DeckCard both
// satisfy this shape (see "source"/"deckContext" below, same principle as
// ChangePrintingModal for the same reason: DeckCard has no id field of its
// own, see "Data model notes" in CLAUDE.md). `id` optional: unused when source
// === "deck", in which case deckContext (deckId + scryfallId) serves as the
// key instead, see MTGCollectionPlugin.setDeckCardGrading.
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
	// Distinguishes which plugin method to call (setCollectionCardGrading vs
	// setDeckCardGrading, two different arrays) without duplicating the whole
	// modal — same principle as ChangePrintingModal.source.
	private source: "collection" | "deck";
	private deckContext?: { deckId: string; scryfallId: string };
	private selectedCompany: GradingCompany;
	private gradeValue: string;
	private gradingLabel: string | undefined;
	// Distinguishes "selectedCompany has just changed following a click on a
	// tile" from a draw() triggered for any other reason (choosing a label in
	// Condition, for example) while this company is already selected — same
	// pattern as gradingJustOpened in CardDetailModal. Without it, EVERY
	// redraw would replay the zoom effect of the selected tile instead of
	// rendering it directly in its final state. Consumed (reset to false) as
	// soon as it has served once, in renderTile.
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

	// Single write point — the two call sites (Clear/Save below) go through
	// here rather than duplicating the source branching.
	private saveGrading(company: GradingCompany | undefined, grade: number | undefined, label: string | undefined) {
		if (this.source === "deck" && this.deckContext) {
			this.plugin.setDeckCardGrading(this.deckContext.deckId, this.deckContext.scryfallId, company, grade, label);
		} else if (this.card.id) {
			this.plugin.setCollectionCardGrading(this.card.id, company, grade, label);
		}
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		// Built only once here rather than in draw(): see the note of
		// addModalCloseButton for why (modalEl, unlike contentEl, is never emptied
		// between two redraws).
		addModalCloseButton(this);
		this.draw();
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	private selectCompany(company: GradingCompany) {
		if (this.selectedCompany === company) return;
		this.selectedCompany = company;
		// The condition depends on the scale of the chosen company — a label still
		// displayed after changing company would point to a scale that is no
		// longer the right one.
		this.gradingLabel = undefined;
		this.companyJustChanged = true;
		this.draw();
	}

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mtg-list-actions-modal");
		// Scope for --mtg-detail-box-h and the few overrides specific to this
		// modal (disabled Condition box, button alignment) — no longer used to
		// position the close button (see onOpen), which now anchors directly on
		// modalEl.
		contentEl.addClass("mtg-grading-modal");

		contentEl.createEl("h2", { text: "Grading" });

		const picker = contentEl.createDiv({ cls: "mtg-grading-company-picker" });
		const row = picker.createDiv({ cls: "mtg-grading-company-row" });
		(["PSA", "BGS", "CGC"] as const).forEach((company) => this.renderTile(row, company));

		// Same family of boxes as a card's detail panel, reused as is here —
		// explicitly requested ("present the Grade field the same way as Custom
		// Price", "the Appreciation block like the Finish block").
		// --mtg-detail-box-h is normally only defined in .mtg-card-detail-panel;
		// redefined here on .mtg-grading-modal so that these boxes have the same
		// fixed height as their equivalents there instead of falling back to an
		// automatic height.
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

		// Square box with a cross, rather than a "Clear" button at the bottom —
		// explicitly requested, positioned to the right of Condition. Only deletes
		// the grade and the condition (not the chosen company) — and, unlike Save,
		// doesn't record by closing the window: "this button doesn't close the
		// window". Records immediately (unlike Save/Grade/Condition, whose other
		// modifications only exist locally until the click on Save) since it is an
		// explicit deletion rather than an entry in progress — see also CLAUDE.md
		// for the full reasoning.
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

	// The brand color (background + logo) lives on an inner wrapper
	// (mtg-grading-company-tile-inner), not on the tile itself — it is this
	// wrapper that shrinks (transform:scale) when its company isn't selected,
	// letting the tile's neutral background show around it as a margin, rather
	// than the whole tile shrinking within its own frame. Explicitly
	// requested: the selected company must "fill the square entirely"
	// (accent-color outline), the others must be visibly "smaller in the
	// square... like with a small margin" (dark gray outline) — see styles.css
	// for the animation.
	private renderTile(parent: HTMLElement, company: GradingCompany) {
		const isSelected = this.selectedCompany === company;
		// If this tile has just been selected by a click, we first build it
		// WITHOUT is-selected (hence shrunk) then add it one frame later, so that
		// the CSS transition has a real state change to animate from — without
		// this delay, draw() rebuilds the whole DOM at once and the element would
		// appear already in its final state from its first paint, with no visible
		// zoom effect (same technique as gradingJustOpened in CardDetailModal).
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
