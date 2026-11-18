import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assembleDb, identifyPhoto, parseIndex } from "./database";

// OPT-IN, skipped in the release CI (it needs files that are not in the repository: personal photos and the real base). It proves the plugin's TypeScript on the REAL data, the check the
// measurements were made with: the real photos of docs/history/card-recognition-spike.md against the real base of ~50 600 illustrations built by the kit's build-shards.mjs.
//   FINGERPRINT_SHARDS=<dir with index.json, s*.bin.gz, names.json>  FINGERPRINT_PPM=<dir of the photos as <id>.ppm (topnm-sel.py)>  npx vitest run src/recognition/fingerprint/real-photos.test.ts
// The truth (the English name of each photo's card) is read from the replay corpora under ~/.local/share/mtg-card-scan-probe/.
const shardsDir = process.env.FINGERPRINT_SHARDS;
const ppmDir = process.env.FINGERPRINT_PPM;

function ppm(file: string): { rgba: Uint8ClampedArray; w: number; h: number } {
	const b = readFileSync(file);
	let pos = 0;
	const token = (): string => {
		while (b[pos] <= 32) pos++;
		let s = "";
		while (b[pos] > 32) s += String.fromCharCode(b[pos++]);
		return s;
	};
	token();
	const w = Number(token());
	const h = Number(token());
	token();
	pos++;
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let i = 0, j = pos; i < w * h; i++, j += 3) {
		rgba[i * 4] = b[j];
		rgba[i * 4 + 1] = b[j + 1];
		rgba[i * 4 + 2] = b[j + 2];
		rgba[i * 4 + 3] = 255;
	}
	return { rgba, w, h };
}

describe.skipIf(!shardsDir || !ppmDir)("the TypeScript scan on the real photos and the real base (opt-in)", () => {
	it("finds the right card first on every photo with a known truth", { timeout: 600_000 }, () => {
		const index = parseIndex(JSON.parse(readFileSync(`${shardsDir}/index.json`, "utf8")));
		expect(index).not.toBeNull();
		const shards = index!.shards.map((s) => new Uint8Array(gunzipSync(readFileSync(`${shardsDir}/${s.file}`))));
		const db = assembleDb(index!, shards);
		expect(db).not.toBeNull();
		const names = JSON.parse(readFileSync(`${shardsDir}/names.json`, "utf8")) as [string, string, string, number][];
		expect(names.length).toBe(db!.n);
		const base = `${homedir()}/.local/share/mtg-card-scan-probe`;
		const truth: Record<string, { name: string }> = {
			...JSON.parse(readFileSync(`${base}/replay-corpus-2026-11-09/photos/rtruth.json`, "utf8")),
			...JSON.parse(readFileSync(`${base}/replay-corpus-2026-11-10-phone/photos/ttruth.json`, "utf8")),
		};
		let right = 0;
		const misses: string[] = [];
		let tried = 0;
		for (const f of readdirSync(ppmDir!).filter((x) => x.endsWith(".ppm")).sort()) {
			const id = f.replace(".ppm", "");
			if (!truth[id] || truth[id].name === "(unknown)") continue;
			tried++;
			const matches = identifyPhoto(ppm(`${ppmDir}/${f}`), db!);
			const got = matches?.[0] ? names[matches[0].row][0] : null;
			if (got === truth[id].name) right++;
			else misses.push(`${id} ${truth[id].name} -> ${got}`);
		}
		console.log(`real photos: ${right}/${tried} right card first; misses: ${misses.join(" | ") || "-"}`);
		expect(tried).toBeGreaterThanOrEqual(38);
		expect(misses).toEqual([]);
	});
});
