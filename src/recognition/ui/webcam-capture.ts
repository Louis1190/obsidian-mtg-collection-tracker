// A computer's webcam as the camera button's "take a photo" (card recognition by photo, beta, PRIVATE like src/recognition/). A phone or tablet hands over to the system's camera app; a
// computer has none, so the plugin opens its own window: the live image, "Take photo", "Choose a photo…" (the file chooser, for a picture taken elsewhere) and "Cancel". The camera is switched
// on when the window opens and OFF the moment a photo is taken or the window closes (the camera's light must never stay on behind a closed window); nothing is recorded or kept: the frame
// is grabbed as pixels (`drawImage` + `getImageData`, never `toBlob`, see photo-input.ts) and handed to the reading, like a photo from a file.
//
// Measured with the probe tools/android/probes/card-scan/webcam/ on a 2015 laptop's webcam (1280x720 at 30 fps, a hand-held card ~300x400 px in the frame): the fingerprint finds the card, the
// title and the printed corner are probably too small to read, so the edition is a list of proposals. docs/history/card-recognition-fingerprint-plan.md, 2026-11-16.

import { Modal, type App } from "obsidian";
import { addModalCloseButton, applyModalOpenAnimation, closeModalAnimated } from "../../ui/modal-animation";
import type { Photo } from "../scan";

/** The camera asked for: as many pixels as it will give up to full HD (the card is then bigger in the frame), no sound. A laptop's camera often offers one mode only (1280x720) and gives that. */
export const WEBCAM_CONSTRAINTS: MediaStreamConstraints = { video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };

/** What the window needs of the browser: a test hands in fakes. */
export interface WebcamDeps {
	openStream(): Promise<MediaStream>;
	/** The pixels of the video's current image, or null when it has none yet. */
	grabFrame(video: HTMLVideoElement): Photo | null;
}

export function grabVideoFrame(video: HTMLVideoElement): Photo | null {
	const w = video.videoWidth;
	const h = video.videoHeight;
	if (!w || !h) return null;
	const canvas = createEl("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(video, 0, 0, w, h);
	return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
}

export const browserWebcam: WebcamDeps = {
	openStream: () => navigator.mediaDevices.getUserMedia(WEBCAM_CONSTRAINTS),
	grabFrame: grabVideoFrame,
};

/** Switches the camera off (its light goes out): every track of the stream is stopped. Safe to repeat. */
export function stopStream(stream: MediaStream | null): void {
	for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Why the camera did not open, in words the person can act on. */
export function describeCameraError(error: unknown): string {
	const name = (error as { name?: string } | null)?.name;
	if (name === "NotAllowedError" || name === "SecurityError") return "access to the camera was refused";
	if (name === "NotFoundError" || name === "OverconstrainedError") return "no camera was found";
	if (name === "NotReadableError" || name === "AbortError") return "the camera is in use by another application";
	return "it did not start";
}

export interface WebcamCaptureOptions {
	/** A photo was taken (the camera is already off). */
	onPhoto(photo: Photo): void;
	/** The person chose "Choose a photo…": called inside that click, so the browser lets the file chooser open. */
	onChooseFile(): void;
	deps?: WebcamDeps;
}

export class WebcamCaptureModal extends Modal {
	private stream: MediaStream | null = null;
	private video: HTMLVideoElement | null = null;
	private statusEl: HTMLElement | null = null;
	private takeBtn: HTMLButtonElement | null = null;
	// set when the window closes: a camera that answers late must be switched off at once, not shown in a window that is gone
	private disposed = false;

	constructor(
		app: App,
		private readonly options: WebcamCaptureOptions,
	) {
		super(app);
	}

	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		this.modalEl.addClass("mtg-scan-webcam-modal");
		const { contentEl } = this;
		contentEl.addClass("mtg-scan-webcam");
		contentEl.createEl("h2", { text: "Take a photo of the card" });
		const video = contentEl.createEl("video", { cls: "mtg-scan-webcam-video" });
		video.muted = true;
		video.autoplay = true;
		video.playsInline = true;
		this.video = video;
		this.statusEl = contentEl.createEl("p", { cls: "mtg-status mtg-scan-webcam-status", text: "Starting the camera…" });
		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		this.takeBtn = actions.createEl("button", { cls: "mtg-search-add-btn mtg-scan-webcam-take", text: "Take photo" });
		this.takeBtn.disabled = true;
		this.takeBtn.addEventListener("click", () => this.take());
		const choose = actions.createEl("button", { cls: "mtg-scan-webcam-choose", text: "Choose a photo…" });
		choose.addEventListener("click", () => {
			this.options.onChooseFile();
			this.close();
		});
		const cancel = actions.createEl("button", { cls: "mtg-scan-webcam-cancel", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		void this.start();
	}

	private async start() {
		const deps = this.options.deps ?? browserWebcam;
		try {
			const stream = await deps.openStream();
			// closed while the camera was starting: switch it off, show nothing
			if (this.disposed) {
				stopStream(stream);
				return;
			}
			this.stream = stream;
			const video = this.video!;
			video.srcObject = stream;
			await video.play();
			if (this.disposed) return;
			this.statusEl?.setText("Hold the card flat, filling most of the frame, in good light, then take the photo.");
			if (this.takeBtn) this.takeBtn.disabled = false;
		} catch (e) {
			// the stream may be open even when playing failed: it is switched off, the window stays to say why and to offer the file chooser
			stopStream(this.stream);
			this.stream = null;
			if (this.disposed) return;
			this.statusEl?.setText(`Could not use the camera: ${describeCameraError(e)}. You can choose a photo instead.`);
			this.statusEl?.addClass("is-error");
		}
	}

	private take() {
		const video = this.video;
		if (!video || this.disposed) return;
		const photo = (this.options.deps ?? browserWebcam).grabFrame(video);
		if (!photo) {
			this.statusEl?.setText("The camera has not sent an image yet. Try again in a moment.");
			return;
		}
		this.options.onPhoto(photo);
		this.close();
	}

	// The camera goes off here, at the person's click, not when the closing animation ends
	close() {
		this.disposed = true;
		stopStream(this.stream);
		this.stream = null;
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.disposed = true;
		stopStream(this.stream);
		this.stream = null;
		if (this.video) this.video.srcObject = null;
		this.contentEl.empty();
	}
}
