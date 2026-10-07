import { App, Modal, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { applyModalOpenAnimation, addModalCloseButton } from "../ui/modal-animation";
import type { CardbaseMover } from "../api/cardbase";
import { CARDBASE_VENDOR_LABELS, CARDBASE_FINISH_LABELS } from "../api/cardbase";
import type { ScryfallImmutableSnapshot } from "../api/scryfall";
import { buildCardTextInfo } from "../api/scryfall";
import { renderManaCostIcons, renderTextWithManaSymbols, renderCardDescriptionFaces } from "../ui/card-detail-fx";
import { formatMoney } from "../core/price";
// RARITY_SOLID_COLORS (not RARITY_COLORS/getRarityColor, api/scryfall.ts —
// verified via a harness against real Obsidian light theme before shipping,
// see that constant's own comment): getRarityColor's "common" is pure
// white, correct for the small icon badge it was designed for, but
// invisible here where the rarity shows as a plain colored word.
import { RARITY_SOLID_COLORS } from "../core/deck-stats";

/* -------------------------------------------------------------------------- */
/*  Read-only card preview (2026-09-23) — Home's Market Trends block makes    */
/*  every mover row clickable (previously owned cards only, see              */
/*  home-render.ts's own comment on that click handler), but most movers     */
/*  across the whole market aren't in the user's collection, so there's no   */
/*  real CollectionCard to open CardDetailModal with. That modal assumes real     */
/*  ownership throughout (quantity/condition/language edits, "remove from    */
/*  collection", grading) — forcing a synthetic entry through it to fake     */
/*  ownership was considered and rejected: any interactive control inside    */
/*  it would either silently no-op against a fake id or, worse, write a      */
/*  stray entry into the real collection. This modal is a deliberately       */
/*  narrower, read-only alternative instead: image, name, set/rarity, card   */
/*  text, and the mover's own price move — no editable fields at all.        */
/* -------------------------------------------------------------------------- */

export class CardPreviewModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private mover: CardbaseMover;
	private snapshot: ScryfallImmutableSnapshot | undefined;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		mover: CardbaseMover,
		snapshot: ScryfallImmutableSnapshot | undefined
	) {
		super(app);
		this.plugin = plugin;
		this.mover = mover;
		this.snapshot = snapshot;
	}

	// Entirely synchronous — unlike CardDetailModal's own "Card Text" box,
	// no fetch/loading state of its own: the caller (buildMoverRow,
	// home-render.ts) already has this exact snapshot in hand from the one
	// batched getScryfallImmutableSnapshots call behind the block's own
	// loading spinner, so there's nothing left to wait on here.
	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-card-preview-modal");

		const imageUrl =
			this.snapshot?.image_uris?.normal ?? this.snapshot?.card_faces?.[0]?.image_uris?.normal ?? "";
		const imgWrap = contentEl.createDiv({ cls: "mtg-card-preview-image-wrap" });
		if (imageUrl) {
			imgWrap.createEl("img", { cls: "mtg-card-preview-image", attr: { src: imageUrl } });
		} else {
			imgWrap.createDiv({ cls: "mtg-card-preview-image mtg-no-image" });
		}

		contentEl.createEl("h2", { cls: "mtg-card-preview-name", text: this.mover.name });

		if (this.snapshot) {
			const setLine = contentEl.createDiv({ cls: "mtg-card-preview-set" });
			setLine.createSpan({
				text: `${this.snapshot.set_name} · ${this.snapshot.set.toUpperCase()} #${this.snapshot.collector_number}`,
			});
			const rarityEl = setLine.createSpan({ cls: "mtg-card-preview-rarity", text: this.snapshot.rarity });
			rarityEl.style.color = RARITY_SOLID_COLORS[this.snapshot.rarity.toLowerCase()] ?? "#9a9a9a";
		}

		this.renderCardText(contentEl);
		this.renderPriceBox(contentEl);
	}

	// Same shape as CardDetailModal.renderCardDescriptionBox (header row of
	// type line + mana cost, then oracle text/stats, or one section per
	// face for a multi-face card) minus its own async getCardTextInfo fetch
	// — this.snapshot is already the full ScryfallImmutableSnapshot,
	// buildCardTextInfo runs on it directly.
	private renderCardText(container: HTMLElement) {
		const box = container.createDiv({ cls: "mtg-card-preview-text-box" });
		if (!this.snapshot) {
			box.createDiv({ cls: "mtg-status", text: "Card details unavailable." });
			return;
		}

		const info = buildCardTextInfo(this.snapshot);
		if (info.faces && info.faces.length > 1) {
			renderCardDescriptionFaces(box, info.faces, (letter) => this.plugin.getManaSymbolSvg(letter));
			return;
		}

		const header = box.createDiv({ cls: "mtg-card-description-header" });
		if (this.snapshot.type_line) {
			header.createDiv({ cls: "mtg-card-description-type", text: this.snapshot.type_line });
		}
		if (this.snapshot.mana_cost) {
			const manaCostEl = header.createDiv({ cls: "mtg-card-description-mana-cost" });
			renderManaCostIcons(manaCostEl, this.snapshot.mana_cost, (letter) => this.plugin.getManaSymbolSvg(letter));
		}

		const textEl = box.createDiv({ cls: "mtg-card-description-text" });
		renderTextWithManaSymbols(textEl, info.oracleText || "No rules text.", (letter) =>
			this.plugin.getManaSymbolSvg(letter)
		);
		if (info.loyalty !== undefined) {
			box.createDiv({ cls: "mtg-card-description-stats", text: `Loyalty: ${info.loyalty}` });
		} else if (info.power !== undefined || info.toughness !== undefined) {
			box.createDiv({ cls: "mtg-card-description-stats", text: `${info.power ?? "?"}/${info.toughness ?? "?"}` });
		}
	}

	// The mover's own price move — cardbase's own vendor-native currency
	// (mover.currency, "USD" or "EUR"), not settings.priceCurrency: these
	// are raw per-vendor prices, not a converted value like the rest of the
	// plugin's own price displays. Same icon+badge markup/classes as this
	// mover's row in the block itself (mtg-home-trends-row-change*,
	// home-render.ts) rather than a 3rd near-identical copy of that markup.
	private renderPriceBox(container: HTMLElement) {
		const box = container.createDiv({ cls: "mtg-card-preview-price-box" });
		box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Market trends" });

		const meta = box.createDiv({ cls: "mtg-card-preview-price-meta" });
		meta.createSpan({
			text: `${CARDBASE_VENDOR_LABELS[this.mover.vendor]} · ${
				CARDBASE_FINISH_LABELS[this.mover.finish] ?? this.mover.finish
			}`,
		});

		const currency = this.mover.currency.toLowerCase() === "eur" ? "eur" : "usd";
		const row = box.createDiv({ cls: "mtg-card-preview-price-row" });
		row.createSpan({
			cls: "mtg-card-preview-price-amounts",
			text: `${formatMoney(this.mover.priceFrom, currency)} → ${formatMoney(this.mover.priceTo, currency)}`,
		});
		const directionClass = this.mover.changePct >= 0 ? "is-up" : "is-down";
		const changeEl = row.createDiv({ cls: `mtg-home-trends-row-change ${directionClass}` });
		setIcon(
			changeEl.createSpan({ cls: "mtg-home-trends-row-change-icon" }),
			directionClass === "is-up" ? "arrow-up" : "arrow-down"
		);
		const sign = this.mover.changePct > 0 ? "+" : "";
		changeEl.createSpan({ text: `${sign}${this.mover.changePct.toFixed(1)}%` });
	}
}
