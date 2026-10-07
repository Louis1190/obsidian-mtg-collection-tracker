// Les règles officielles d'Obsidian (eslint-plugin-obsidianmd) dans la configuration que le scanner du répertoire des
// plug-ins applique à chaque soumission (documentée dans docs/configuration.md du plugin ESLint, « Community plugin
// scanner configuration ») : seules six règles de sécurité sont des ERREURS, tout le reste est un avertissement, quelques
// règles sont éteintes, et les tests / scripts / docs ne sont pas lus.
//
//   npm run lint          comme le scanner : bloquant = les erreurs
//   npm run lint:strict   les sévérités d'origine de la config « recommended » (tout ce qu'Obsidian recommande)
//
// L'état et le plan : docs/obsidian-compliance.md.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const strict = process.env.LINT_STRICT === "1";

const SECURITY = ["no-eval", "no-implied-eval", "no-unsanitized/method", "no-unsanitized/property", "obsidianmd/regex-lookbehind", "obsidianmd/no-forbidden-elements"];
const OFF = [
	"no-undef", "@typescript-eslint/no-unsafe-member-access", "@typescript-eslint/no-unsafe-assignment", "@typescript-eslint/no-unsafe-argument",
	"@typescript-eslint/no-unsafe-call", "@typescript-eslint/no-unsafe-return", "@typescript-eslint/restrict-template-expressions",
	"@typescript-eslint/no-base-to-string", "import/no-unresolved", "obsidianmd/validate-manifest", "obsidianmd/validate-license",
	"obsidianmd/commands/no-command-in-command-id", "obsidianmd/commands/no-plugin-id-in-command-id",
];

// « error » (ou 2, ou ["error", options]) devient « warn », comme le fait le scanner.
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
