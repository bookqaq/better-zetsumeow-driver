/**
 * Compile-time build mode flag.
 *
 * `build.mjs` replaces every reference with the literal `true` (`--mode=release`)
 * or `false` (`--mode=debug`) through an AST transformer and folds the dead
 * branches away, so the identifier itself never reaches a bundle and no
 * cross-mode code survives into the other artifact. This file only teaches the
 * type checker about the ambient global; it is never bundled.
 */
declare const __ZMEOW_RELEASE__: boolean;
