import { getCondition, getLanguage } from "../core/card-model";
import { CONDITION_NONE_ICON_SVG, getFlagSvgDataUri, LANGUAGE_NONE_ICON_SVG } from "./brand-assets";
import { setSvgMarkup } from "./svg-markup";

/* ---------------------------------------------------------------------------- */
/*  Fabriques DOM des pictogrammes de langue (drapeau) et de condition (badge).*/
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
// Rend le drapeau d'une langue de carte, ou LANGUAGE_NONE_ICON_SVG (brand-assets.ts)
// quand code est vide/non reconnu (une carte sans langue choisie — "None"
// n'est plus une entrée de LANGUAGES (core/card-model.ts), donc plus jamais un
// choix listé dans un picker, seulement ce repli visuel). Tout appelant qui
// affiche la langue *propre* d'une CollectionCard (par opposition à une langue
// d'impression Scryfall connue d'avance, toujours un vrai code) doit passer
// par ici plutôt que createFlagImg directement. extraCls permet d'assortir
// la taille de l'icône à celle du drapeau dans un contexte donné (ex.
// mtg-card-detail-image-icon-glyph au-dessus de l'image d'une carte).

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
// Rend le badge de condition (glyph coloré), ou CONDITION_NONE_ICON_SVG
// (brand-assets.ts) quand value est vide (une carte sans condition choisie — même
// traitement, mêmes raisons que createLanguageIcon ci-dessus).

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
