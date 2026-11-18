// A photo (a File or Blob, from the camera route or a file picker) as the pixels `scanPhoto` reads. Needs a DOM (a canvas); never calls `toBlob` (it costs 4 s on a
// phone WebView): only `drawImage` and `getImageData`, which take about 40 ms.

import type { Photo } from "./scan";

/** The photo's long side is brought to at most this many pixels: a card is ~1000 px wide in a phone's 1440 x 1920 picture, more only costs time and memory. */
export const PHOTO_MAX_SIDE = 1920;

/**
 * What a reading is given: a file the person took or picked (a phone's camera, a file chooser) or pixels already in hand (a computer's webcam, webcam-capture.ts, which grabs a frame from the
 * video: nothing is encoded and decoded again).
 */
export type PhotoSource = Blob | Photo;

export function isDecodedPhoto(source: PhotoSource): source is Photo {
	return !(source instanceof Blob) && "rgba" in source;
}

/** The pixels of a source: a decoded photo as it is, a file decoded by `photoFromBlob`. */
export async function photoFromSource(source: PhotoSource, maxSide = PHOTO_MAX_SIDE): Promise<Photo> {
	return isDecodedPhoto(source) ? source : photoFromBlob(source, maxSide);
}

export async function photoFromBlob(blob: Blob, maxSide = PHOTO_MAX_SIDE): Promise<Photo> {
	// the browser applies the picture's own orientation (EXIF): a phone photo comes out upright
	const bitmap = await createImageBitmap(blob);
	try {
		const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * k));
		const h = Math.max(1, Math.round(bitmap.height * k));
		const canvas = createEl("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) throw new Error("No 2D canvas to read the photo with.");
		ctx.drawImage(bitmap, 0, 0, w, h);
		return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
	} finally {
		bitmap.close();
	}
}
