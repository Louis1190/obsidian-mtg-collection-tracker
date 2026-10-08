import { getCondition, getLanguage } from "../core/card-model";
import { CONDITION_NONE_ICON_SVG, getFlagSvgDataUri, LANGUAGE_NONE_ICON_SVG } from "./brand-assets";
import { setSvgMarkup } from "./svg-markup";

/* ---------------------------------------------------------------------------- */
/* DOM factories for the language (flag) and condition (badge) pictograms. */
/* ---------------------------------------------------------------------------- */

export function createFlagImg(
	container: HTMLElement,
	countryCode: string,
	cls = "mtg-flag-img"
): HTMLImageElement {
	return container.createEl("img", {
		cls,
		attr: { src: getFlagSvgDataUri(countryCode), alt: "" },
	});
}
// Renders the flag of a card language, or LANGUAGE_NONE_ICON_SVG (brand-assets.ts)
// when code is empty/unrecognized (a card with no language chosen — "None" is no
// longer an entry of LANGUAGES (core/card-model.ts), so never again a choice listed
// in a picker, only this visual fallback). Any caller that displays the *own*
// language of a CollectionCard (as opposed to a Scryfall print language known in
// advance, always a real code) must go through here rather than createFlagImg
// directly. extraCls makes it possible to match the icon's size to that of the flag
// in a given context (e.g. mtg-card-detail-image-icon-glyph above a card's image).

export function createLanguageIcon(
	container: HTMLElement,
	code: string,
	imgCls = "mtg-flag-img",
	extraCls = ""
): HTMLElement {
	const lang = getLanguage(code);
	if (!lang.flag) {
		const icon = container.createSpan({
			cls: extraCls ? `mtg-none-icon ${extraCls}` : "mtg-none-icon",
		});
		setSvgMarkup(icon, LANGUAGE_NONE_ICON_SVG);
		return icon;
	}
	return createFlagImg(container, lang.flag, imgCls);
}
// Renders the condition badge (colored glyph), or CONDITION_NONE_ICON_SVG
// (brand-assets.ts) when value is empty (a card with no condition chosen — same
// treatment, same reasons as createLanguageIcon above).

export function createConditionIcon(
	container: HTMLElement,
	value: string,
	extraCls = ""
): HTMLElement {
	if (!value) {
		const icon = container.createSpan({
			cls: extraCls ? `mtg-none-icon ${extraCls}` : "mtg-none-icon",
		});
		setSvgMarkup(icon, CONDITION_NONE_ICON_SVG);
		return icon;
	}
	const cond = getCondition(value);
	const badge = container.createSpan({
		cls: extraCls ? `mtg-condition-badge ${extraCls}` : "mtg-condition-badge",
		text: cond.glyph,
	});
	badge.style.color = cond.color;
	return badge;
}
