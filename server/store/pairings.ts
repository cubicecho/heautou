import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PAIRING_DEFAULTS } from '../core/defaults.ts';
import { parseInput } from '../core/validation.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import { DEFAULT_GROUPS_CLAIM, groupsClaimSchema } from './claims.ts';
import type { JsonFile } from './json-file.ts';

/** One setup URL handed out: what the app that registers with it gets, and whether one has. */
interface PairingRecord {
  /** The SHA-256 of the initial access token in the setup URL. */
  tokenHash: string;
  /** The allowed groups the paired client gets. */
  allowedGroups: string[];
  /** The groups claim the paired client gets. */
  groupsClaim: string;
  /** In epoch milliseconds. Past it the record is dropped, paired or not. */
  expiresAt: number;
  /** The client the app registered as, or null while it has not. */
  clientId: string | null;
}

/** Pairings by id. */
export type PairingDocument = Record<string, PairingRecord>;

/** A pairing, with its id. */
export interface Pairing extends Omit<PairingRecord, 'tokenHash'> {
  id: string;
}

/** What the operator chooses before handing out a setup URL. */
const pairingInputSchema = z.object({
  allowedGroups: z
    .array(z.string().trim().min(1))
    .transform((groups) => [...new Set(groups)])
    .default([]),
  groupsClaim: groupsClaimSchema.default(DEFAULT_GROUPS_CLAIM),
});
export type PairingInput = z.input<typeof pairingInputSchema>;

/** Setup URLs waiting for an app to register with them, and the ones it has. */
export interface PairingStore {
  /**
   * Records a setup URL just handed out.
   *
   * @param token - The initial access token in the URL. Only its hash is kept.
   * @param input - What the paired client gets.
   * @returns The pairing.
   * @throws BAD_USER_INPUT when the groups or the claim name are not allowed.
   */
  start: (token: string, input: PairingInput) => Pairing;
  /**
   * Looks a pairing up.
   *
   * @param id - The pairing's id.
   * @returns It, or null once it has expired or been cancelled.
   */
  find: (id: string) => Pairing | null;
  /**
   * Finds the pairing an app is registering with.
   *
   * @param token - The initial access token the app sent.
   * @returns The pairing, or null when it is unknown, expired, cancelled or already used.
   */
  waitingFor: (token: string) => Pairing | null;
  /**
   * Marks a pairing done.
   *
   * @param id - The pairing's id.
   * @param clientId - The client the app registered as.
   */
  complete: (id: string, clientId: string) => void;
  /**
   * Cancels a pairing, so its setup URL stops working.
   *
   * @param id - The pairing's id.
   * @returns True when there was one to cancel.
   */
  cancel: (id: string) => boolean;
}

/**
 * Hashes an initial access token for storage.
 *
 * @param token - The token.
 * @returns Its SHA-256, base64url.
 */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Drops the token hash from a record.
 *
 * @param id - The pairing's id.
 * @param record - The stored record.
 * @returns The pairing.
 */
function toPairing(id: string, record: PairingRecord): Pairing {
  const { tokenHash: _tokenHash, ...rest } = record;
  return { id, ...rest };
}

/**
 * Opens the pairing store on its file.
 *
 * @param file - The file holding the pairings.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store. Expired pairings are dropped whenever it writes.
 */
export function createPairingStore(file: JsonFile<PairingDocument>, now: () => number = Date.now): PairingStore {
  const live = (): [string, PairingRecord][] =>
    Object.entries(file.read()).filter(([, record]) => record.expiresAt > now());

  const write = (change: (entries: [string, PairingRecord][]) => [string, PairingRecord][]): void => {
    file.update(() => Object.fromEntries(change(live())));
  };

  return {
    start: (token, input) => {
      const fields = parseInput(pairingInputSchema, input);
      const id = randomUUID();
      const record: PairingRecord = {
        ...fields,
        tokenHash: digest(token),
        expiresAt: now() + PAIRING_DEFAULTS.linkSeconds * MS_PER_SECOND,
        clientId: null,
      };
      write((entries) => [...entries, [id, record]]);
      return toPairing(id, record);
    },
    find: (id) => {
      const found = live().find(([key]) => key === id);
      return found === undefined ? null : toPairing(...found);
    },
    waitingFor: (token) => {
      const tokenHash = digest(token);
      const found = live().find(([, record]) => record.tokenHash === tokenHash && record.clientId === null);
      return found === undefined ? null : toPairing(...found);
    },
    complete: (id, clientId) => {
      write((entries) => entries.map(([key, record]) => [key, key === id ? { ...record, clientId } : record]));
    },
    cancel: (id) => {
      const isWaiting = live().some(([key]) => key === id);
      if (isWaiting) {
        write((entries) => entries.filter(([key]) => key !== id));
      }
      return isWaiting;
    },
  };
}
