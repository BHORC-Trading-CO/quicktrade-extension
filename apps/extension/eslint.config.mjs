import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import { fileURLToPath } from 'node:url';

const baseDirectory = fileURLToPath(new URL('.', import.meta.url));
const compat = new FlatCompat({
  baseDirectory,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    ignores: ['.output/**', '.wxt/**', 'dist/**', 'eslint.config.mjs', 'node_modules/**', 'postcss.config.js', 'src/lib/**', 'src/dev/pages/web_recordings/**'],
  },
  ...compat.config({
    parser: '@typescript-eslint/parser',
    parserOptions: {
      project: 'tsconfig.json',
      tsconfigRootDir: baseDirectory,
      sourceType: 'module',
    },
    plugins: ['simple-import-sort', '@typescript-eslint'],
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended', 'plugin:react/recommended', 'plugin:react-hooks/recommended', 'prettier'],
    env: {
      node: true,
      browser: true,
      es2021: true,
    },
    globals: {
      chrome: 'readonly',
      browser: 'readonly',
    },
    rules: {
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      'react/react-in-jsx-scope': 'off',
    },
    settings: {
      react: { version: 'detect' },
    },
  }),
];
