import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["dist/", ".omc/", ".omo/", "node_modules/", "tests/", "*.mjs"]),
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] } } } },
  {
    files: ["src/domain/**/*.ts", "src/types/**/*.ts", "src/utils/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["obsidian", "obsidian/*"], message: "domain/, types/, and utils/ must not import from obsidian." }],
      }],
    },
  },
]);
