import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
    { ignores: ["node_modules/**", "dist/**", "forge-out/**", "cache/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts"],
        languageOptions: { globals: { ...globals.node, Bun: "readonly" } },
        rules: {
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
            eqeqeq: ["error", "always", { null: "ignore" }],
        },
    },
    // winston is the only log sink in the service; a stray console.log would break json-only stdout.
    { files: ["src/**/*.ts"], rules: { "no-console": "error" } },
    prettier,
];
