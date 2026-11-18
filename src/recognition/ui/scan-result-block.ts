// What a reading of a photo found, as one block of the scan list (card recognition by photo, beta): the
// most probable printing's picture, its name, its set and number and price, a small ✓ to add it and a × to take the block away, and, when the reading proposes several editions
// (it always proposes the ones it cannot tell apart), a row of them under the block to pick from. Choosing an edition changes the block, adding is the usual "Add" of the window.
// Nothing is added by itself, whatever the reading is sure of.
//
// The ✓ and what follows it (the +/- stepper, the history of the window, the list picker of the gallery flows, opening the card's window) are the window's own `renderAddControl`,
// handed in, so a block adds exactly as a search tile does.

import { setIcon } from "obsidian";
import type MTGCollectionPlugin from "../../plugin";
import { getImageUrl, type ScryfallCard } from "../../api/scryfall";
import { getLanguage } from "../../core/card-model";
import { languageCodeOfPrint } from "../../core/foreign-print";
import { formatScryfallPrice } from "../../core/price";
import { createLanguageIcon } from "../../ui/option-icons";

export interface ScanBlockDeps {
	plugin: MTGCollectionPlugin;
	/**
	 * Draws the add control of `card` in `host` (the block itself is the area that opens the card's window once it is added) and answers what takes it away again.
	 * `onAddedChange` hears whether the card is now added (true) or not any more (false, undone from the history).
	 */
	renderAddControl(block: HTMLElement, host: HTMLElement, card: ScryfallCard, onAddedChange: (added: boolean) => void): () => void;
	/** The × */
	onDismiss(): void;
}

export interface ScanBlock {
	/** Makes edition `index` of the proposed cards the one the block shows (ignored once the card is added). */
	select(index: number): void;
	/** Index of the edition the block shows. */
	selected(): number;
}

/** At most this many editions in the row: the reading never proposes more (`MAX_SHOWN_PRINTINGS`). */
export const BLOCK_MAX_EDITIONS = 24;

export function renderScanResultBlock(host: HTMLElement, outcome: { cards: ScryfallCard[]; note: string }, deps: ScanBlockDeps): ScanBlock {
	const cards = outcome.cards.slice(0, BLOCK_MAX_EDITIONS);
	const block = host.createDiv({ cls: "mtg-scan-block" });
	const thumb = block.createDiv({ cls: "mtg-scan-block-thumb" });
	const body = block.createDiv({ cls: "mtg-scan-block-body" });
	const nameRow = body.createDiv({ cls: "mtg-scan-block-name" });
	const nameEl = nameRow.createSpan({ cls: "mtg-scan-block-name-text" });
	const flagEl = nameRow.createSpan({ cls: "mtg-scan-block-lang" });
	// two lines: the set's name (cut with an ellipsis when it is long), then the number and the price, which must stay whole
	const metaEl = body.createDiv({ cls: "mtg-scan-block-meta" });
	const setEl = metaEl.createSpan({ cls: "mtg-scan-block-set" });
	const numberEl = metaEl.createSpan({ cls: "mtg-scan-block-number" });
	body.createDiv({ cls: "mtg-scan-block-note", text: outcome.note, attr: { title: outcome.note } });
	const actions = block.createDiv({ cls: "mtg-scan-block-actions" });
	const slot = actions.createDiv({ cls: "mtg-scan-block-add" });
	const dismiss = actions.createEl("button", { cls: "mtg-scan-block-dismiss", attr: { "aria-label": "Remove from the list", title: "Remove from the list" } });
	setIcon(dismiss, "x");
	dismiss.addEventListener("click", (evt) => {
		evt.stopPropagation();
		deps.onDismiss();
	});

	let selectedIndex = 0;
	let added = false;
	let removeAddControl: (() => void) | null = null;
	let editionsBtn: HTMLElement | null = null;
	let strip: HTMLElement | null = null;
	const tiles: HTMLElement[] = [];

	const draw = () => {
		const card = cards[selectedIndex];
		thumb.empty();
		const img = getImageUrl(card);
		if (img) thumb.createEl("img", { cls: "mtg-scan-block-image", attr: { src: img, loading: "lazy", alt: card.name } });
		else thumb.createDiv({ cls: "mtg-scan-block-image mtg-no-image" });
		nameEl.setText(card.name);
		nameEl.setAttribute("title", card.printed_name && card.printed_name !== card.name ? card.printed_name : card.name);
		flagEl.empty();
		const language = languageCodeOfPrint(card);
		flagEl.toggleClass("mtg-hidden", !language);
		if (language) {
			createLanguageIcon(flagEl, language);
			flagEl.setAttribute("title", card.printed_name ? `${getLanguage(language).label}: ${card.printed_name}` : getLanguage(language).label);
		}
		const price = formatScryfallPrice(card, deps.plugin.settings.priceCurrency);
		setEl.setText(card.set_name || card.set.toUpperCase());
		numberEl.setText([`${card.set.toUpperCase()} #${card.collector_number}`, price].filter(Boolean).join(" · "));
		tiles.forEach((tile, i) => tile.toggleClass("is-selected", i === selectedIndex));
		removeAddControl?.();
		removeAddControl = deps.renderAddControl(block, slot, card, (isAdded) => {
			added = isAdded;
			refreshEditions();
		});
	};

	// the editions can be changed until the card is added: after that, the card's own window changes its printing
	const refreshEditions = () => {
		editionsBtn?.toggleClass("mtg-hidden", added);
		if (added) strip?.addClass("mtg-hidden");
	};

	if (cards.length > 1) {
		editionsBtn = body.createEl("button", { cls: "mtg-scan-block-editions", attr: { "aria-expanded": "false" } });
		editionsBtn.createSpan({ text: `${cards.length} editions` });
		const chevron = editionsBtn.createSpan({ cls: "mtg-scan-block-editions-chevron" });
		setIcon(chevron, "chevron-down");
		strip = block.createDiv({ cls: "mtg-scan-block-strip mtg-hidden" });
		cards.forEach((card, i) => {
			const tile = strip!.createDiv({ cls: "mtg-scan-edition", attr: { role: "button", tabindex: "0", title: card.set_name || card.set.toUpperCase() } });
			const tileImg = getImageUrl(card);
			if (tileImg) tile.createEl("img", { cls: "mtg-scan-edition-image", attr: { src: tileImg, loading: "lazy", alt: "" } });
			else tile.createDiv({ cls: "mtg-scan-edition-image mtg-no-image" });
			tile.createSpan({ cls: "mtg-scan-edition-label", text: `${card.set.toUpperCase()} ${card.collector_number}` });
			const choose = (evt: Event) => {
				evt.stopPropagation();
				select(i);
			};
			tile.addEventListener("click", choose);
			tile.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter" || evt.key === " ") {
					evt.preventDefault();
					choose(evt);
				}
			});
			tiles.push(tile);
		});
		editionsBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const open = strip!.hasClass("mtg-hidden");
			strip!.toggleClass("mtg-hidden", !open);
			editionsBtn!.setAttribute("aria-expanded", String(open));
			editionsBtn!.toggleClass("is-open", open);
		});
	}

	const select = (index: number) => {
		if (added || index < 0 || index >= cards.length || index === selectedIndex) return;
		selectedIndex = index;
		draw();
	};

	draw();
	return { select, selected: () => selectedIndex };
}
