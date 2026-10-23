// A store's data as one document in memory, written through to its tables.
//
// The stores were written over JSON files read once and rewritten whole on every change, and much of the server reads
// them synchronously: the provider's account lookups, each forward auth verify, the sign-in checks. So each store keeps
// its document in memory as before, and a change is applied there at once, while the same call is still running, so
// "is this username taken" and "was this code used" are still decided without anything in between. The tables are
// written after, in order, and the change's promise settles once they are: a caller that awaits it knows the data is
// in the database, and one whose write failed gets the error and finds the document as the tables have it.
//
// One process owns the database: nothing else writes the tables while it runs.
import {
  and,
  eq,
  getColumns,
  getTableName,
  type InferInsertModel,
  type InferSelectModel,
  inArray,
  or,
  type SQL,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database, Transaction } from './client.ts';

/** One row, by the tables' TS keys. */
export type Row = Record<string, unknown>;

/** One store's data in memory, written through to its tables. */
export interface DataDocument<T> {
  /** The document now, with every change made so far. Treat it as read-only and change it through `update`. */
  read: () => T;
  /**
   * Changes the document. The change is made in memory before this returns, so the next `read` sees it.
   *
   * @param change - Builds the next document from the current one.
   * @returns Once the tables hold it: the next document.
   * @throws The database's error when the write fails. The document is then as the tables hold it, and changes made
   * after this one, before it failed, are dropped with it.
   */
  update: (change: (current: T) => T) => Promise<T>;
  /** Reads the tables again, after something other than `update` replaced them, such as a restore. */
  reload: () => Promise<void>;
}

/** One table a document is kept in. */
export interface RowSet<TTable extends PgTable = PgTable> {
  table: TTable;
  /** The columns that tell its rows apart: its primary key, by TS key. */
  keys: readonly (keyof InferSelectModel<TTable> & string)[];
  /** The rows of this document, when the table holds others' too, such as one oidc-provider model's. */
  scope?: SQL;
}

/** The rows of each of a document's tables, in the order of its `tables`. */
export type RowsOf<TTables extends readonly PgTable[], Shape extends 'insert' | 'select'> = {
  [K in keyof TTables]: Shape extends 'insert' ? InferInsertModel<TTables[K]>[] : InferSelectModel<TTables[K]>[];
};

/** How a document is laid out in its tables. */
export interface DocumentMapping<T, TTables extends readonly PgTable[] = readonly PgTable[]> {
  /**
   * Its name, such as `users`: the row a single document is kept in. Its path in a backup archive, and in the data
   * directory of a version before the database, is the name as a JSON file (`archivePathOf`).
   */
  name: string;
  /** The document a new install starts with. */
  fallback: T;
  /** Its tables, each one a table before any that points at it. */
  tables: { [K in keyof TTables]: RowSet<TTables[K]> };
  /**
   * Lays a document out as rows. It also reads a file an older version wrote, so it fills in what that lacks.
   *
   * @param document - The document, secrets sealed.
   * @returns The rows of each table.
   */
  toRows: (document: T) => RowsOf<TTables, 'insert'>;
  /**
   * Builds the document from its rows.
   *
   * @param rows - The rows of each table, as read.
   * @returns The document.
   */
  fromRows: (rows: RowsOf<TTables, 'select'>) => T;
}

/**
 * A mapping with its document's type forgotten, for the code that treats every store alike: backups, restores and
 * the import from an older data directory.
 */
export interface LooseMapping {
  name: string;
  fallback: unknown;
  tables: readonly RowSet[];
  /**
   * Lays a document out as rows.
   *
   * @param document - The document, as its store or its file holds it.
   * @returns The rows of each table.
   */
  toRows: (document: unknown) => Row[][];
  /**
   * Builds the document from its rows.
   *
   * @param rows - The rows of each table.
   * @returns The document.
   */
  fromRows: (rows: readonly Row[][]) => unknown;
}

/**
 * Forgets a mapping's document type.
 *
 * @typeParam T - The document's shape.
 * @typeParam TTables - Its tables.
 * @param mapping - The mapping.
 * @returns The same mapping, loosely typed.
 */
export function loosen<T, TTables extends readonly PgTable[]>(mapping: DocumentMapping<T, TTables>): LooseMapping {
  const tables: readonly RowSet[] = mapping.tables;
  return {
    name: mapping.name,
    fallback: mapping.fallback,
    tables,
    // A document handed in is one this store wrote, or the file an older version of it wrote, which its toRows fills in.
    toRows: (document) => mapping.toRows(document as T) as Row[][],
    fromRows: (rows) => fromRowsOf(mapping, rows),
  };
}

/**
 * Builds a document from the rows of each of its tables, a table with none read as empty.
 *
 * @typeParam T - The document's shape.
 * @typeParam TTables - Its tables.
 * @param mapping - How the document is laid out.
 * @param rows - The rows of each table, in the order of its `tables`.
 * @returns The document.
 */
function fromRowsOf<T, TTables extends readonly PgTable[]>(
  mapping: DocumentMapping<T, TTables>,
  rows: readonly Row[][],
): T {
  // The rows the queries here read are loose; they are the ones these tables hold.
  return mapping.fromRows(mapping.tables.map((_rowSet, index) => rows[index] ?? []) as RowsOf<TTables, 'select'>);
}

/** Runs writes one at a time, in the order they were asked for. */
export interface WriteQueue {
  /**
   * Runs a task once every task asked for before it has settled.
   *
   * @typeParam R - What it returns.
   * @param task - The task.
   * @returns What it returns.
   */
  run: <R>(task: () => Promise<R>) => Promise<R>;
}

/**
 * Makes a write queue. One per database, so writes reach it in the order the server made them, across stores: a
 * row that names another store's row is written after it.
 *
 * @returns The queue.
 */
export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run: (task) => {
      const result = tail.then(task, task);
      tail = result.catch(() => {});
      return result;
    },
  };
}

/** How many rows go in one statement, well under Postgres's limit on bound parameters. */
const ROWS_PER_STATEMENT = 200;

/**
 * Splits a list into statements' worth.
 *
 * @typeParam V - What it holds.
 * @param values - The list.
 * @returns Its pieces.
 */
function chunked<V>(values: readonly V[]): V[][] {
  const chunks: V[][] = [];
  for (let start = 0; start < values.length; start += ROWS_PER_STATEMENT) {
    chunks.push(values.slice(start, start + ROWS_PER_STATEMENT));
  }
  return chunks;
}

/**
 * Builds the condition that picks one row out by its key.
 *
 * @param rowSet - Its table.
 * @param row - The row.
 * @returns The condition.
 */
function whereKey(rowSet: RowSet, row: Row): SQL {
  const columns = getColumns(rowSet.table);
  const conditions = rowSet.keys.map((key) => eq(columns[key], row[key]));
  const condition = conditions.length === 1 ? conditions[0] : and(...conditions);
  if (condition === undefined) {
    throw new Error(`${getTableName(rowSet.table)} has no key columns.`);
  }
  return condition;
}

/**
 * Builds the condition that picks several rows out by their keys.
 *
 * @param rowSet - Their table.
 * @param rows - The rows.
 * @returns The condition.
 */
function whereKeys(rowSet: RowSet, rows: readonly Row[]): SQL | undefined {
  const [onlyKey] = rowSet.keys;
  if (rowSet.keys.length === 1 && onlyKey !== undefined) {
    const column = getColumns(rowSet.table)[onlyKey];
    return inArray(
      column,
      rows.map((row) => row[onlyKey]),
    );
  }
  return or(...rows.map((row) => whereKey(rowSet, row)));
}

/**
 * Tells a row apart from the others in its table.
 *
 * @param rowSet - Its table.
 * @param row - The row.
 * @returns Its key, as text.
 */
function keyOf(rowSet: RowSet, row: Row): string {
  return JSON.stringify(rowSet.keys.map((key) => row[key]));
}

/**
 * Reads a document's rows.
 *
 * @param db - The database, or a transaction on it.
 * @param rowSets - Its tables.
 * @returns The rows of each table.
 */
async function loadRows(db: Database | Transaction, rowSets: readonly RowSet[]): Promise<Row[][]> {
  const loaded: Row[][] = [];
  for (const { table, scope } of rowSets) {
    const query = db.select().from(table);
    loaded.push(await (scope === undefined ? query : query.where(scope)));
  }
  return loaded;
}

/**
 * Writes the difference between what a document's tables hold and what they should: rows gone are deleted, new rows
 * inserted and changed rows updated. Deletes go child tables first, inserts parents first.
 *
 * @param tx - The transaction.
 * @param rowSets - The document's tables.
 * @param before - The rows they hold, laid out as `toRows` lays them out.
 * @param after - The rows they should hold.
 */
async function writeDifference(
  tx: Transaction,
  rowSets: readonly RowSet[],
  before: readonly Row[][],
  after: readonly Row[][],
): Promise<void> {
  const plans = rowSets.map((rowSet, index) => {
    const previous = new Map((before[index] ?? []).map((row) => [keyOf(rowSet, row), row]));
    const next = new Map((after[index] ?? []).map((row) => [keyOf(rowSet, row), row]));
    const removed = [...previous].filter(([key]) => next.has(key) === false).map(([, row]) => row);
    const added = [...next].filter(([key]) => previous.has(key) === false).map(([, row]) => row);
    const changed = [...next]
      .filter(([key, row]) => {
        const old = previous.get(key);
        return old !== undefined && JSON.stringify(old) !== JSON.stringify(row);
      })
      .map(([, row]) => row);
    return { rowSet, removed, added, changed };
  });
  for (const { rowSet, removed } of plans.toReversed()) {
    for (const rows of chunked(removed)) {
      await tx.delete(rowSet.table).where(whereKeys(rowSet, rows));
    }
  }
  for (const { rowSet, added, changed } of plans) {
    for (const row of changed) {
      await tx.update(rowSet.table).set(row).where(whereKey(rowSet, row));
    }
    for (const rows of chunked(added)) {
      await tx.insert(rowSet.table).values(rows);
    }
  }
}

/**
 * Says why a write was dropped without being tried.
 *
 * @param name - The document's name.
 * @returns The error.
 */
function droppedWrite(name: string): Error {
  return new Error(`An earlier change to ${name} failed to save, so this one, made on top of it, was dropped.`);
}

/** The database the documents are kept in, and the queue every write to it takes. */
export interface DocumentStore {
  db: Database;
  queue: WriteQueue;
}

/**
 * Opens a document: reads its rows, or starts from the fallback when there are none.
 *
 * @typeParam T - The document's shape.
 * @typeParam TTables - Its tables.
 * @param store - The database and its write queue.
 * @param mapping - How the document is laid out.
 * @returns The document.
 */
export async function openDocument<T, TTables extends readonly PgTable[]>(
  store: DocumentStore,
  mapping: DocumentMapping<T, TTables>,
): Promise<DataDocument<T>> {
  return documentFromRows(store, mapping, await loadRows(store.db, mapping.tables));
}

/**
 * Builds a document from rows already read, without reading them again.
 *
 * @typeParam T - The document's shape.
 * @typeParam TTables - Its tables.
 * @param store - The database and its write queue.
 * @param mapping - How the document is laid out.
 * @param loaded - Its rows, as the tables hold them now: empty for a document with none yet.
 * @returns The document.
 */
export function documentFromRows<T, TTables extends readonly PgTable[]>(
  store: DocumentStore,
  mapping: DocumentMapping<T, TTables>,
  loaded: readonly Row[][],
): DataDocument<T> {
  const { db, queue } = store;
  const rowSets: readonly RowSet[] = mapping.tables;
  const loose = loosen(mapping);
  const toRows = (document: T): Row[][] => loose.toRows(document);
  const fromRows = (rows: readonly Row[][]): T => fromRowsOf(mapping, rows);

  /**
   * Lays out the rows the tables hold as `toRows` would, so the next document's compare with them. Only rows that were
   * read count: a document that starts from its fallback has no row yet, and its first write inserts one.
   *
   * @param document - The document the rows make.
   * @param rows - The rows, as read.
   * @returns The rows of each table, laid out.
   */
  const laidOut = (document: T, rows: readonly Row[][]): Row[][] =>
    toRows(document).map((laid, index) => {
      const rowSet = rowSets[index];
      const read = new Set((rows[index] ?? []).map((row) => (rowSet === undefined ? '' : keyOf(rowSet, row))));
      return laid.filter((row) => rowSet !== undefined && read.has(keyOf(rowSet, row)));
    });

  /** The document as the tables hold it. */
  let stored = fromRows(loaded);
  /** Its rows, as `toRows` lays them out, to compare the next document's with. */
  let storedRows = laidOut(stored, loaded);
  /** The document with every change made, saved or not. */
  let current = stored;
  /** Counts failures and reloads: a change made before one is dropped rather than written on top of it. */
  let generation = 0;

  return {
    read: () => current,
    update: (change) => {
      const next = change(current);
      current = next;
      const madeIn = generation;
      const write = async (): Promise<void> => {
        if (madeIn !== generation) {
          throw droppedWrite(mapping.name);
        }
        const nextRows = toRows(next);
        try {
          await db.transaction((tx) => writeDifference(tx, rowSets, storedRows, nextRows));
        } catch (error) {
          generation += 1;
          current = stored;
          throw error;
        }
        stored = next;
        storedRows = nextRows;
      };
      return queue.run(write).then(() => next);
    },
    reload: () =>
      queue.run(async () => {
        generation += 1;
        const reloaded = await loadRows(db, rowSets);
        stored = fromRows(reloaded);
        storedRows = laidOut(stored, reloaded);
        current = stored;
      }),
  };
}

/**
 * Replaces everything a document's tables hold with a document, as a restore or the first import does.
 *
 * @param tx - The transaction the whole restore runs in.
 * @param mapping - How the document is laid out.
 * @param document - The document, as its archive file holds it.
 */
export async function replaceDocument(tx: Transaction, mapping: LooseMapping, document: unknown): Promise<void> {
  const rows = mapping.toRows(document);
  for (const { table, scope } of mapping.tables.toReversed()) {
    await (scope === undefined ? tx.delete(table) : tx.delete(table).where(scope));
  }
  for (const [index, rowSet] of mapping.tables.entries()) {
    for (const chunk of chunked(rows[index] ?? [])) {
      await tx.insert(rowSet.table).values(chunk);
    }
  }
}

/**
 * Reads a document as its tables hold it, secrets sealed, for a backup.
 *
 * @param db - The database.
 * @param mapping - How the document is laid out.
 * @returns The document.
 */
export async function readDocument(db: Database, mapping: LooseMapping): Promise<unknown> {
  return mapping.fromRows(await loadRows(db, mapping.tables));
}
