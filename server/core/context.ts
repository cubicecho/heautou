import type { PublicUser } from '../store/users.ts';
import type { Services } from './services.ts';

/** What every resolver is given: the services, and who is asking. */
export interface Context
  extends Pick<
    Services,
    | 'clients'
    | 'users'
    | 'issuer'
    | 'host'
    | 'sessions'
    | 'keys'
    | 'branding'
    | 'passwordLinks'
    | 'adminSessions'
    | 'pairings'
  > {
  /** The signed-in admin making the request. */
  viewer: PublicUser;
}
