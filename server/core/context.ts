import type { ClientStore } from '../store/clients.ts';
import type { PublicUser, UserStore } from '../store/users.ts';

/** What every resolver is given. */
export interface Context {
  clients: ClientStore;
  users: UserStore;
  /** The provider's public URL, ending in `/oidc`. */
  issuer: string;
  /** The signed-in admin making the request. */
  viewer: PublicUser;
}
