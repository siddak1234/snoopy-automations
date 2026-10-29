import { loadTable, type TableId } from '../src/tables.js';

/**
 * Run by `tables.test.ts` in its own Node, with `--expose-gc`: the heap one table's load keeps,
 * after a collection before and after, printed as JSON.
 */
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error('run with --expose-gc');
gc();
const before = process.memoryUsage().heapUsed;
const table = loadTable(process.argv[2] as TableId);
gc();
const after = process.memoryUsage().heapUsed;
console.log(JSON.stringify({ heap: after - before, codes: Object.keys(table.codes).length }));
