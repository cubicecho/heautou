import type { CodegenConfig } from '@graphql-codegen/cli';

/** Typed documents for the web app, from the schema `server/graphql/write-schema.ts` prints. */
const config: CodegenConfig = {
  schema: './schema.graphql',
  documents: './web/src/graphql/**/*.graphql',
  ignoreNoDocuments: true,
  generates: {
    './web/src/__generated__/graphql.ts': {
      plugins: ['typescript-operations', 'typed-document-node'],
      config: {
        useTypeImports: true,
        skipTypename: true,
        enumType: 'const',
        avoidOptionals: { field: true },
        scalars: { DateTime: 'string', JSON: 'Record<string, string>' },
      },
    },
  },
};

export default config;
