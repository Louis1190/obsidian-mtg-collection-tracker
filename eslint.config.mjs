// The official Obsidian rules (eslint-plugin-obsidianmd) in the configuration that the plugin directory's
// scanner applies to every submission (documented in the ESLint plugin's docs/configuration.md, "Community
// plugin scanner configuration"): only six security rules are ERRORS, everything else is a warning, a few rules
// are turned off, and tests / scripts / docs are not read.
//
//   npm run lint          like the scanner: blocking = the errors
//   npm run lint:strict   the original severities of the "recommended" config (everything Obsidian recommends)
//
// State and plan: docs/obsidian-compliance.md.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const strict = process.env.LINT_STRICT === "1";

const SECURITY = ["no-eval", "no-implied-eval", "no-unsanitized/method", "no-unsanitized/property", "obsidianmd/regex-lookbehind", "obsidianmd/no-forbidden-elements"];
// The five `no-unsafe-*` rules are NOT turned off: the directory's first real review (2026-10-07) reported them
// as warnings (13 / 30 / 4 places, exactly what this linter finds in strict mode). What remains off is off
// according to the scanner's documentation; `no-base-to-string` (3 places in strict mode) did not show up in the
// real review.
const OFF = [
	"no-undef", "@typescript-eslint/restrict-template-expressions",
	"@typescript-eslint/no-base-to-string", "import/no-unresolved", "obsidianmd/validate-manifest", "obsidianmd/validate-license",
	"obsidianmd/commands/no-command-in-command-id", "obsidianmd/commands/no-plugin-id-in-command-id",
];

// "error" (or 2, or ["error", options]) becomes "warn", as the scanner does.
const toWarn = (entry) => {
	if (entry === "error" || entry === 2) return "warn";
	if (Array.isArray(entry) && (entry[0] === "error" || entry[0] === 2)) return ["warn", ...entry.slice(1)];
	return entry;
};
const asScanner = (configs) =>
	configs.map((c) => (c.rules ? { ...c, rules: Object.fromEntries(Object.entries(c.rules).map(([k, v]) => [k, toWarn(v)])) } : c));

export default defineConfig([
	{ languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*", "manifest.json"] }, tsconfigRootDir: import.meta.dirname } } },
	...(strict ? obsidianmd.configs.recommended : asScanner(obsidianmd.configs.recommended)),
	...(strict
		? []
		: [
				{
					files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"],
					rules: {
						...Object.fromEntries(SECURITY.map((r) => [r, "error"])),
						...Object.fromEntries(OFF.map((r) => [r, "off"])),
					},
				},
			]),
	globalIgnores([
		"node_modules", "dist", "build", "pkg", "test-vault", ".obsidian", "**/.obsidian/**", "esbuild.config.mjs", "version-bump.mjs",
		"**/*.test.*", "**/*.tests.*", "**/*.spec.*", "**/*.specs.*", "**/test/**", "**/tests/**", "**/__tests__/**", "**/mocks/**", "**/__mocks__/**",
		"**/*.cjs", "**/*.mjs", "**/*.cts", "**/*.mts", "**/vite*", "**/scripts/**", "**/docs/**", "**/testUtils**", "main.js", "tools/**",
	]),
]);
