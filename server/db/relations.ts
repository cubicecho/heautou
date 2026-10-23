import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/** How the tables point at each other. drizzle-graphql generates the nested read fields from these. */
export const relations = defineRelations(schema, (relate) => ({
  users: {
    upstreamLinks: relate.many.upstreamLinks({ from: relate.users.id, to: relate.upstreamLinks.userId }),
  },
  clients: {
    apis: relate.many.apis({
      from: relate.clients.clientId.through(relate.apiClients.clientId),
      to: relate.apis.identifier.through(relate.apiClients.apiIdentifier),
    }),
  },
  apis: {
    allowedClients: relate.many.clients({
      from: relate.apis.identifier.through(relate.apiClients.apiIdentifier),
      to: relate.clients.clientId.through(relate.apiClients.clientId),
    }),
  },
  upstreams: {
    groupMappings: relate.many.upstreamGroupMappings({
      from: relate.upstreams.id,
      to: relate.upstreamGroupMappings.upstreamId,
    }),
    links: relate.many.upstreamLinks({ from: relate.upstreams.id, to: relate.upstreamLinks.providerId }),
  },
  upstreamLinks: {
    provider: relate.one.upstreams({
      from: relate.upstreamLinks.providerId,
      to: relate.upstreams.id,
      optional: false,
    }),
    user: relate.one.users({ from: relate.upstreamLinks.userId, to: relate.users.id }),
  },
}));
