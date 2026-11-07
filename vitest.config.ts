import { fileURLToPath } from "node:url";
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
	resolve: {
		// See the stub's own comment: a jsdom test that imports a module importing "obsidian" needs the name to resolve.
		alias: { obsidian: fileURLToPath(new URL("./src/__tests__/obsidian-stub.ts", import.meta.url)) },
	},
	test: {
		environment: "node",
		setupFiles: ["./vitest.setup.ts"],
		exclude: [...configDefaults.exclude, ".claude/**"],
	},
});
