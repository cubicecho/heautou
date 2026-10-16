import type { IncomingMessage, ServerResponse } from 'node:http';
import type Provider from 'oidc-provider';

/**
 * Holds the provider and builds it again when what it was built from changes. oidc-provider fixes its keys and
 * claims when it is made; its sessions, codes and tokens live in the model files, so a new build carries on where
 * the old one stopped.
 */
export interface ProviderHost {
  /** The provider as it is now. Read it on each request rather than keeping it. */
  current: () => Provider;
  /** Builds the provider again if its keys or claim names have changed since the last build. */
  refresh: () => void;
  /** Handles a request under the mount path with the current provider. */
  handle: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Makes the provider host.
 *
 * @param build - Makes a provider from the current keys and claim names.
 * @param fingerprint - Sums those inputs up; a different value means a rebuild.
 * @returns The host, with the first provider built.
 */
export function createProviderHost(build: () => Provider, fingerprint: () => string): ProviderHost {
  let builtFrom = fingerprint();
  let provider = build();
  let handler = provider.callback();
  return {
    current: () => provider,
    refresh: () => {
      const next = fingerprint();
      if (next !== builtFrom) {
        builtFrom = next;
        provider = build();
        handler = provider.callback();
      }
    },
    handle: (req, res) => {
      void handler(req, res);
    },
  };
}
