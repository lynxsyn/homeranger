// homescout flat ESLint config (loaded via jiti). Lean M1 baseline:
// typescript-eslint recommended (non-type-checked — fast, no parserServices).
// Tighten with type-checked rules once the app surface lands (M2+).
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'infra/**',
      '.aide/**',
    ],
  },
  ...tseslint.configs.recommended,
)
