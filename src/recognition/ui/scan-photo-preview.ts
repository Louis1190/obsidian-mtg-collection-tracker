// The photo being read, shown small in the scan panel with the card the finder found drawn on it (card recognition by photo, beta).
// The camera screen belongs to the system's camera app, so no frame can be drawn on it; this is the next best thing: after the shot
// the person sees at once whether the reader looked at the right card, and can retake the photo without waiting for a wrong answer.
//
// The picture is painted from the Photo's own pixels (a small copy, no canvas `toBlob`, no object URL to revoke) so it is the photo as the reader sees it, already upright, and the
// finder's corners (in the photo's pixels) land on it exactly: an <img> of the file could disagree with them over the picture's orientation.

import type { Quad } from "../card-finder";
import { downscaleRgba, type Photo } from "../scan";

/** The picture shown is brought to at most this many pixels on its long side: it is displayed at about 170 px, 480 keeps it sharp on a phone's dense screen. */
export const PREVIEW_MAX_SIDE = 480;

const SVG_NS = "http://www.w3.org/2000/svg";

export interface PhotoPreview {
	/** Outlines the card on the photo (corners in the photo's pixels) and says what the outline is. A quad with a corner that is not a finite number is ignored. */
	setOutline(quad: Quad): void;
	/** Takes the preview away. */
	remove(): void;
}

/** The `points` of a polygon through the corners, or null when one of them is not a finite number. */
export function outlinePoints(quad: Quad): string | null {
	if (quad.length !== 4) return null;
	const parts: string[] = [];
	for (const [x, y] of quad) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		parts.push(`${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`);
	}
	return parts.join(" ");
}

/**
 * Draws the photo in `panel`, right before `before` (the progress bar), with a caption line under it that stays empty until a card is outlined. Returns null when the picture
 * cannot be made (no 2D canvas): the panel then simply has no preview, the reading does not depend on it.
 */
export function renderPhotoPreview(panel: HTMLElement, before: HTMLElement, photo: Photo): PhotoPreview | null {
	try {
		// only the size is kept for the outline: a closure that mentioned `photo` itself would keep its full-size pixels (11 MB for a phone's picture) alive for as long as the preview object is
		const photoW = photo.w;
		const photoH = photo.h;
		const small = downscaleRgba(photo, Math.max(1, Math.round(photo.w * Math.min(1, PREVIEW_MAX_SIDE / Math.max(photo.w, photo.h)))));
		const frame = panel.createDiv({ cls: "mtg-scan-preview" });
		frame.setAttribute("role", "img");
		frame.setAttribute("aria-label", "Your photo");
		const canvas = frame.createEl("canvas", { cls: "mtg-scan-preview-photo" });
		canvas.width = small.w;
		canvas.height = small.h;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			frame.remove();
			return null;
		}
		const image = ctx.createImageData(small.w, small.h);
		image.data.set(small.rgba);
		ctx.putImageData(image, 0, 0);
		const hint = panel.createDiv({ cls: "mtg-scan-hint" });
		panel.insertBefore(frame, before);
		panel.insertBefore(hint, before);

		let svg: SVGSVGElement | null = null;
		let shade: SVGPolygonElement | null = null;
		let line: SVGPolygonElement | null = null;
		const setOutline = (quad: Quad): void => {
			try {
				const points = outlinePoints(quad);
				if (!points) return;
				if (!svg || !shade || !line) {
					const doc = panel.ownerDocument;
					svg = doc.createElementNS(SVG_NS, "svg");
					svg.setAttribute("class", "mtg-scan-outline");
					// the corners are in the photo's pixels: the viewBox is the photo's, whatever size the picture is shown at
					svg.setAttribute("viewBox", `0 0 ${photoW} ${photoH}`);
					svg.setAttribute("aria-hidden", "true");
					// a dark line under a light one: visible on a light mat as well as a dark one
					shade = doc.createElementNS(SVG_NS, "polygon");
					shade.setAttribute("class", "mtg-scan-outline-shade");
					line = doc.createElementNS(SVG_NS, "polygon");
					line.setAttribute("class", "mtg-scan-outline-line");
					svg.append(shade, line);
					frame.appendChild(svg);
				}
				shade.setAttribute("points", points);
				line.setAttribute("points", points);
				frame.setAttribute("aria-label", "Your photo, with the card found outlined");
				hint.textContent = "Outlined: the card found. Not your card? Retake.";
			} catch {
				// a drawing problem never reaches the reading
			}
		};
		return {
			setOutline,
			remove: () => {
				frame.remove();
				hint.remove();
			},
		};
	} catch {
		return null;
	}
}
