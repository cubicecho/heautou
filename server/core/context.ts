import type { PublicUser } from '../store/users.ts';
import type { Services } from './services.ts';

/** What every resolver is given: the services, and who is asking. */
export interface Context
  extends Pick<
    Services,
    | 'db'
    | 'clients'
    | 'apis'
    | 'users'
    | 'factors'
    | 'upstreams'
    | 'upstreamFlows'
    | 'issuer'
    | 'host'
    | 'sessions'
    | 'keys'
    | 'branding'
    | 'passwordLinks'
    | 'adminSessions'
    | 'pairings'
    | 'pairingOffers'
    | 'settings'
    | 'passwordPolicy'
    | 'audit'
    | 'mail'
    | 'pictures'
    | 'protectedSites'
    | 'forwardAuth'
  > {
  /** The signed-in admin making the request. */
  viewer: PublicUser;
  /** The admin's address, for the audit log. */
  ip: string | null;
}
