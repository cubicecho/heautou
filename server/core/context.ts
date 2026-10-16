import type { ClientStore } from '../store/clients.ts';
import type { UserStore } from '../store/users.ts';

/** What every resolver is given. */
export interface Context {
  clients: ClientStore;
  users: UserStore;
  /** The provider's public URL, ending in `/oidc`. */
  issuer: string;
}
