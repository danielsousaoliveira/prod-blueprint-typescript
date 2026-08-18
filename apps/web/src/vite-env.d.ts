/// <reference types="vite/client" />

/*
 * Declares the ambient module types Vite provides — in particular, that a side-effect
 * import of a `.css` file is legal.
 *
 * Without it, `import './index.css'` in main.tsx is a TS2882 error: TypeScript has no
 * idea what a stylesheet is, and `noUncheckedSideEffectImports` (on by default in TS 6)
 * refuses imports it cannot resolve to a module. That flag exists to catch typo'd import
 * paths, which is worth keeping — the fix is to tell TypeScript about CSS, not to relax
 * the check.
 */
