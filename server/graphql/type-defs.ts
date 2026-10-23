/**
 * The root types of the admin API that every concept's module extends (`clients.ts`, `users.ts`, `mail.ts`...), beyond
 * the reads drizzle-graphql generates from the tables (`build-schema.ts`). Each module holds the fields a row can't
 * hold, the settings that are no table, and every change, since each one is checked, audited and made through a store.
 */
export const ROOT_TYPE_DEFS = /* GraphQL */ `
  type Mutation

  "Live updates, over server-sent events. The admin session is checked when the stream opens."
  type Subscription

  extend schema {
    mutation: Mutation
    subscription: Subscription
  }
`;
