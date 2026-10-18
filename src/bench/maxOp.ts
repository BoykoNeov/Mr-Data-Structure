import type { StructureId } from './measure';

/**
 * The worst-single-operation profile's wire format (docs/PLAN.md §13, docs/METHODOLOGY.md §4
 * hurdle 13): the fields of the Rust `MaxOpProfile` (`bench-engine/src/structures/maxop.rs`),
 * copied out of the wasm object in the worker so a plain object crosses the Comlink boundary.
 *
 * The list is typed against the generated class in the worker (`readMaxOpProfile`'s caller
 * passes the wasm object), so a field renamed in Rust fails the typecheck rather than reading
 * `undefined`. Values are counts; `NaN` means "does not apply to this structure" and is
 * turned into `null` by the shaping in `src/compare/maxOp.ts`.
 */
export const MAX_OP_FIELDS = [
  'n',
  'stored',
  'height',
  'insert_max_ops',
  'insert_max_ops_at',
  'insert_mean_ops',
  'delete_max_ops',
  'delete_max_ops_at',
  'delete_mean_ops',
  'deletes',
  'delete_misses',
  'insert_max_rotations',
  'delete_max_rotations',
  'insert_max_recolours',
  'delete_max_recolours',
  'insert_max_moved',
  'insert_max_moved_at',
  'resizes',
] as const;

export type MaxOpField = (typeof MAX_OP_FIELDS)[number];

/** One structure at one size, as the engine returns it. */
export type RawMaxOpProfile = { readonly structure: StructureId } & { readonly [F in MaxOpField]: number };

/**
 * The structures profiled, in the shared charts' order — the canonical numeric ones
 * (`src/registry.ts`). Mirrors `MAX_OP_STRUCTURES` in `maxop.rs`; an id the Rust side does
 * not know makes the worker throw rather than silently skip a line. Excluded on purpose: the
 * min-heap (insert / extract-min is a different op set — PLAN §8, risk R6), the graph (its own
 * section) and the string twins (another key type, another run).
 */
export const MAX_OP_STRUCTURES: readonly StructureId[] = [
  'array',
  'll',
  'sarr',
  'hashset',
  'skiplist',
  'dll',
  'rbt',
  'btree',
  'hashoa',
  'bst',
  'avl',
  'hashbs',
];

/** Copy the profile's fields off a wasm object (or anything carrying them) into a plain one. */
export function readMaxOpProfile(
  structure: StructureId,
  p: { readonly [F in MaxOpField]: number },
): RawMaxOpProfile {
  return {
    structure,
    n: p.n,
    stored: p.stored,
    height: p.height,
    insert_max_ops: p.insert_max_ops,
    insert_max_ops_at: p.insert_max_ops_at,
    insert_mean_ops: p.insert_mean_ops,
    delete_max_ops: p.delete_max_ops,
    delete_max_ops_at: p.delete_max_ops_at,
    delete_mean_ops: p.delete_mean_ops,
    deletes: p.deletes,
    delete_misses: p.delete_misses,
    insert_max_rotations: p.insert_max_rotations,
    delete_max_rotations: p.delete_max_rotations,
    insert_max_recolours: p.insert_max_recolours,
    delete_max_recolours: p.delete_max_recolours,
    insert_max_moved: p.insert_max_moved,
    insert_max_moved_at: p.insert_max_moved_at,
    resizes: p.resizes,
  };
}
