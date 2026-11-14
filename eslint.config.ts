import { defineConfig } from 'eslint/config'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended'

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  eslintPluginPrettier,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true }
      ]
    }
  },
  {
    files: ['src/configpanel/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { project: './src/configpanel/tsconfig.json' }
    }
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // vi.fn() stubs on object literals have no `this` to lose.
      '@typescript-eslint/unbound-method': 'off'
    }
  },
  {
    ignores: ['plugin/**', 'public/**', 'node_modules/**']
  }
)
