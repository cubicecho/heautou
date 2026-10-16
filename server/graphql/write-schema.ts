// Prints the schema the server serves, for codegen. Run by `npm run codegen`.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { printSchema } from 'graphql';
import { schema } from './schema.ts';

const target = fileURLToPath(new URL('../../schema.graphql', import.meta.url));
await writeFile(target, `${printSchema(schema)}\n`, 'utf-8');
console.log(`[codegen] wrote ${target}`);
