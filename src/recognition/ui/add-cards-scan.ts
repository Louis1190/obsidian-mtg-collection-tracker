// The scan of one "Add cards" window (beta, PRIVATE like src/recognition/): the camera button, the list of photos taken, and what starts and stops with them. It used to be ~230 lines
// inside AddCardsModal; it lives here so that the window talks to the feature through one narrow door (src/card-recognition-entry.ts) and the public build can leave all of it out
// (docs/history/public-stubs-plan.md). The window keeps its own state (the carousel, "Add all", the add control): it hands over what the scan needs in `AddCardsScanHost`.

import { setIcon } from "obsidian";
import { fetchCardsByName, fetchPrintingBySetAndNumber, fetchPrintingsOfNames, fetchSetCardNames } from "../../api/scryfall";
import type { AddCardsScan as AddCardsScanApi, AddCardsScanHost } from "../../card-recognition-types";
import { cardRecognitionAvailable, usesWebcam } from "../availability";
import type { PhotoSource } from "../photo-input";
import { prepareSharedCardRecognition, releaseSharedCardRecognition, sharedCardRecognition } from "../shared";
import { startCardScan } from "./card-scan";
import { fingerprintDeps, fingerprintEnabled, prepareFingerprint, releaseFingerprint } from "./fingerprint-base";
import { ScanQueue } from "./scan-queue";
import { renderScanResultBlock } from "./scan-result-block";
import { WebcamCaptureModal } from "./webcam-capture";

export class AddCardsScan implements AddCardsScanApi {
	// The list of photos taken (made when the first one arrives), shown in place of the carousel while `view` is on. See scan-queue.ts and startCardScanFromFile.
	private queue: ScanQueue | null = null;
	private view = false;
	private viewEls: { carousel: HTMLElement; panel: HTMLElement; switchRow: HTMLElement; switchBtn: HTMLElement } | null = null;
	private inputEl: HTMLInputElement | null = null;
	// set when the window closes: a base that answers late must not warm the title reader for a window that is gone (nothing would release it)
	private closed = false;

	constructor(private readonly host: AddCardsScanHost) {}

	// Beta, private: a photo of a card in place of typing its name. On a phone or tablet, and on a computer where a webcam is found (availability.ts), and only when the setting
	// is on for this device; the reader (an OCR engine, ~80 MB) is not made until a photo is given. The input carries `capture="environment"`: that is what opens the camera on a phone
	// (without it Obsidian's Android chooser offered only the photo library, seen on the real phone 2026-11-07); a computer ignores the attribute and the input is only its file chooser.
	mountCameraButton(searchBarRow: HTMLElement): void {
		if (!cardRecognitionAvailable() || !this.host.plugin.settings.cardRecognitionEnabled) return;
		searchBarRow.addClass("has-scan-btn");
		this.inputEl = searchBarRow.createEl("input", { cls: "mtg-search-scan-input", type: "file", attr: { accept: "image/*", capture: "environment" } });
		this.inputEl.addEventListener("change", () => {
			const file = this.inputEl?.files?.[0];
			if (this.inputEl) this.inputEl.value = "";
			if (file) this.startCardScanFromFile(file);
		});
		const scanBtn = searchBarRow.createEl("button", {
			cls: "mtg-search-add-btn mtg-search-scan-btn",
			attr: { title: "Add a card from a photo (beta)", "aria-label": "Add a card from a photo (beta)" },
		});
		setIcon(scanBtn, "camera");
		scanBtn.addEventListener("click", () => this.openCamera());
	}

	isShowingScan(): boolean {
		return this.view;
	}

	close(): void {
		this.closed = true;
		this.queue?.destroy();
		this.queue = null;
		releaseSharedCardRecognition();
		releaseFingerprint(this.host.plugin);
	}

	// A photo of a card (card-scan.ts) goes into the LIST of scanned cards (scan-queue.ts), shown in place of the carousel: the reading runs in the background, one photo after the
	// other, and each card found is a block the person adds (✓) or removes (×) — nothing is added here. Taking another photo does not wait for the reading of the last one. A typed
	// search shows the carousel again, the list stays (a pill brings it back); closing the window stops the readings.
	// What starts while the person takes the photo: the base of image fingerprints when that is on (the title reader then starts only if it is needed), the title reader otherwise.
	private prepareScan() {
		if (!fingerprintEnabled(this.host.plugin)) {
			prepareSharedCardRecognition();
			return;
		}
		// the base loads while the photo is taken; with no base (no files, no address, a shard the sync has not brought yet) the title reader is warmed instead, as it always was
		void prepareFingerprint(this.host.plugin).then((ready) => {
			if (!ready && !this.closed) prepareSharedCardRecognition();
		});
	}

	// The camera button, the list's "Next photo" and an item's "Retake": the reader starts now, while the person takes the photo, and stays up between photos until this window closes.
	// A phone or tablet hands over to the system's camera app through the file input; a computer has none, so the plugin's own window shows the webcam (webcam-capture.ts).
	private openCamera() {
		this.prepareScan();
		if (usesWebcam()) {
			this.openWebcam();
			return;
		}
		this.inputEl?.click();
	}

	// A photo from the webcam is pixels already (nothing to decode). "Choose a photo…" in that window opens the same file chooser a phone's button opens, inside its own click.
	private openWebcam() {
		new WebcamCaptureModal(this.host.plugin.app, {
			onPhoto: (photo) => {
				if (!this.closed) this.startCardScanFromFile(photo);
			},
			onChooseFile: () => this.inputEl?.click(),
		}).open();
	}

	private startCardScanFromFile(file: PhotoSource) {
		this.ensureScanQueue().add(file);
		this.showScanView();
	}

	// The list of scanned cards is built when the first photo arrives (a window that never scans carries none of it): a pill under the title that brings it back, and the panel itself
	// next to the carousel, with its blocks, a way back to the search and the button for the next photo.
	private ensureScanQueue(): ScanQueue {
		if (this.queue) return this.queue;
		const top = this.host.topSection;
		const carousel = this.host.resultsBlock;
		const switchRow = top.createDiv({ cls: "mtg-scan-switch mtg-hidden" });
		top.insertBefore(switchRow, carousel);
		const switchBtn = switchRow.createEl("button", { cls: "mtg-scan-switch-btn" });
		switchBtn.addEventListener("click", () => this.showScanView());
		const panel = top.createDiv({ cls: "mtg-scan-queue mtg-hidden" });
		const header = panel.createDiv({ cls: "mtg-scan-queue-header" });
		// the camera icon is only drawn on a phone (styles.css), where the panel is a block with a header like Home's; elsewhere it has no box
		setIcon(header.createSpan({ cls: "mtg-scan-queue-title-icon" }), "camera");
		header.createSpan({ cls: "mtg-scan-queue-title", text: "Scanned cards" });
		const back = header.createEl("button", { cls: "mtg-scan-queue-back", text: "Search results" });
		back.addEventListener("click", () => this.showSearchView());
		const list = panel.createDiv({ cls: "mtg-scan-queue-list" });
		const next = panel.createEl("button", { cls: "mtg-scan-queue-next mod-cta" });
		setIcon(next.createSpan({ cls: "mtg-scan-queue-next-icon" }), "camera");
		next.createSpan({ text: "Next photo" });
		next.addEventListener("click", () => this.openCamera());
		this.viewEls = { carousel, panel, switchRow, switchBtn };
		this.queue = new ScanQueue(list, {
			start: (el, file, onRetry) =>
				startCardScan(el, file, {
					recognition: () => sharedCardRecognition(),
					lookupPrintings: fetchPrintingsOfNames,
					lookupExact: fetchPrintingBySetAndNumber,
					lookupCards: fetchCardsByName,
					lookupSetCards: fetchSetCardNames,
					fingerprint: fingerprintDeps(this.host.plugin, sharedCardRecognition),
					onRetry,
				}),
			renderCards: (el, outcome, item) =>
				renderScanResultBlock(el, outcome, {
					plugin: this.host.plugin,
					renderAddControl: (block, hostEl, card, onAddedChange) => this.host.renderAddControl(block, card, { host: hostEl, compact: true, track: false, onAddedChange }),
					onDismiss: () => this.queue?.dismiss(item),
				}),
			onRetake: () => this.openCamera(),
			onChange: () => this.refreshScanSwitch(),
		});
		return this.queue;
	}

	private showScanView() {
		const els = this.viewEls;
		if (!els) return;
		this.view = true;
		els.carousel.addClass("mtg-hidden");
		els.panel.removeClass("mtg-hidden");
		this.refreshScanSwitch();
		this.host.updateAddAllButtonState();
	}

	showSearchView(): void {
		const els = this.viewEls;
		if (!els) return;
		this.view = false;
		els.carousel.removeClass("mtg-hidden");
		els.panel.addClass("mtg-hidden");
		this.refreshScanSwitch();
		this.host.updateAddAllButtonState();
	}

	// The pill that brings the list back shows only while the carousel is on screen and the list holds something; the last block taken away sends the person back to the search
	private refreshScanSwitch() {
		const els = this.viewEls;
		const queue = this.queue;
		if (!els || !queue) return;
		if (queue.size === 0 && this.view) {
			this.showSearchView();
			return;
		}
		els.switchBtn.setText(`Scanned cards (${queue.size})${queue.busy ? " …" : ""}`);
		els.switchRow.toggleClass("mtg-hidden", this.view || queue.size === 0);
	}
}
