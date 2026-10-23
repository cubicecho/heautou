// Prints the schema the server serves, for codegen. Run by `npm run codegen`.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { printSchema } from 'graphql';
import { relations } from '../db/relations.ts';
import { createSchema } from './build-schema.ts';

/** A database that is never reached: printing the schema runs no query, and node-postgres connects only to run one. */
const UNREACHED_DATABASE = 'postgres://codegen@localhost/codegen';

const target = fileURLToPath(new URL('../../schema.graphql', import.meta.url));
const schema = createSchema(drizzle({ connection: UNREACHED_DATABASE, relations }));
await writeFile(target, `${printSchema(schema)}\n`, 'utf-8');
console.log(`[codegen] wrote ${target}`);
process.exit(0);
