/**
 * The data layer (docs/PLAN.md §3 layer 1, §4) — public surface. Produces the
 * one normalized {@link Dataset} shared by the visualization and benchmark
 * engines, from imported (CSV/JSON/paste/file) or synthetic data.
 */
export type {
  Dataset,
  NumberDataset,
  StringDataset,
  KeyType,
  DataOrder,
  GeneratorDescriptor,
} from './dataset';
export { makeDataset } from './dataset';

export type { Table } from './table';
export { column } from './table';

export { parseCsv, type CsvOptions } from './csv';
export { parseJson } from './json';
export { isNumeric, detectColumnType, coerceKey } from './detect';

export {
  tableToDataset,
  importCsv,
  importJson,
  type ToDatasetOptions,
} from './import';

export {
  generateSorted,
  generateReverseSorted,
  generateNearSorted,
  generateUniform,
  generateGaussian,
  generateZipfian,
  generateStringCorpus,
} from './generators';

export {
  marshalKeys,
  unmarshalKeys,
  transferables,
  type MarshalledKeys,
  type NumberKeyBuffer,
  type StringKeyBuffer,
} from './marshal';
