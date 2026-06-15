/**
 * Teaching implementations (docs/PLAN.md §2.1, §8) — public surface. These are
 * the TypeScript twins of the Rust bench impls: they run the *same* algorithm so
 * the user animates exactly what they measure, and a cross-language conformance
 * corpus (docs/PLAN.md §12) holds the two languages to identical observable
 * results. Phase 2 covers the numeric-key and string-key array and hash set;
 * step-event animation is Phase 3.
 */
export type { SearchResult } from './dynArray';
export { DynArrayF64 } from './dynArray';
export { HashSetF64 } from './hashSet';
export { DynArrayStr } from './dynArrayStr';
export { HashSetStr } from './hashSetStr';
export { mixF64, mixStr } from './mix';
