import { z } from 'zod';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import type { ClientStore } from './clients.ts';
import type { ProtectedSiteStore } from './protected-sites.ts';
import type { UpstreamStore } from './upstreams.ts';
import type { UserStore } from './users.ts';

/**
 * A group: a name users hold in their `groups` claim and clients may be limited to. Groups are not stored on
 * their own; one exists while a user or a client names it.
 */
export interface Group {
  name: string;
  /** The ids of the users in it. */
  memberIds: string[];
  /** The clients only its members (and other allowed groups') may sign in to. */
  clientIds: string[];
  /** Whether it is the admin group, which cannot be renamed or removed. */
  isProtected: boolean;
}

/** The stores groups live in. */
export interface GroupStores {
  users: UserStore;
  clients: ClientStore;
  /** Upstream providers name groups too, for the users they create and map. Renames and removals follow there. */
  upstreams?: UpstreamStore;
  /** Protected sites are limited to groups as clients are. Renames follow there, and removals are refused. */
  protectedSites?: ProtectedSiteStore;
}

const groupNameSchema = z.string().trim().min(1, 'give the group a name');

/**
 * Lists every group a user or a client names, and the admin group.
 *
 * @param stores - The users and clients.
 * @returns The groups, by name.
 */
export function listGroups({ users, clients, protectedSites }: GroupStores): Group[] {
  const names = new Set<string>([ADMIN_DEFAULTS.group]);
  for (const user of users.list()) {
    for (const group of user.groups) {
      names.add(group);
    }
  }
  for (const client of clients.list()) {
    for (const group of client.allowedGroups) {
      names.add(group);
    }
  }
  for (const site of protectedSites?.list() ?? []) {
    for (const group of site.allowedGroups) {
      names.add(group);
    }
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      memberIds: users
        .list()
        .filter((user) => user.groups.includes(name))
        .map((user) => user.id),
      clientIds: clients
        .list()
        .filter((client) => client.allowedGroups.includes(name))
        .map((client) => client.clientId),
      isProtected: name === ADMIN_DEFAULTS.group,
    }));
}

/**
 * Finds one group, refusing the admin group.
 *
 * @param stores - The users and clients.
 * @param name - The group.
 * @returns The group.
 * @throws NOT_FOUND when nothing names it; BAD_USER_INPUT for the admin group.
 */
function loadChangeable(stores: GroupStores, name: string): Group {
  const group = listGroups(stores).find((candidate) => candidate.name === name);
  if (group === undefined) {
    throw notFound(`No user or client has the group "${name}".`);
  }
  if (group.isProtected) {
    throw badInput(`"${name}" makes users admins, so it keeps its name.`);
  }
  return group;
}

/**
 * Renames a group in every user and client. Renaming it to a group that exists merges the two.
 *
 * @param stores - The users and clients.
 * @param name - The group.
 * @param newName - What to call it.
 * @returns Once every store has saved it: the group under its new name.
 */
export async function renameGroup(stores: GroupStores, name: string, newName: string): Promise<Group> {
  loadChangeable(stores, name);
  const to = parseInput(groupNameSchema, newName);
  if (to === ADMIN_DEFAULTS.group) {
    throw badInput(`newName: add users to "${to}" one by one, so no one becomes an admin by accident.`);
  }
  await Promise.all([
    stores.users.replaceGroup(name, to),
    stores.clients.replaceGroup(name, to),
    stores.upstreams?.replaceGroup(name, to),
    stores.protectedSites?.replaceGroup(name, to),
  ]);
  const renamed = listGroups(stores).find((group) => group.name === to);
  if (renamed === undefined) {
    throw notFound(`No user or client has the group "${to}".`);
  }
  return renamed;
}

/**
 * Takes a group off every user. A group a client is limited to is refused: removing it from the client's list
 * could leave the list empty, which lets everyone in.
 *
 * @param stores - The users and clients.
 * @param name - The group.
 * @returns Once saved: how many users were in it.
 */
export async function deleteGroup(stores: GroupStores, name: string): Promise<number> {
  const group = loadChangeable(stores, name);
  if (group.clientIds.length > 0) {
    const names = group.clientIds.map((clientId) => `"${stores.clients.find(clientId)?.name ?? clientId}"`);
    throw badInput(`${names.join(', ')} only let "${name}" sign in. Change their allowed groups first.`);
  }
  const sites = (stores.protectedSites?.list() ?? []).filter((site) => site.allowedGroups.includes(name));
  if (sites.length > 0) {
    const names = sites.map((site) => `"${site.name}"`);
    throw badInput(`${names.join(', ')} only let "${name}" in. Change their allowed groups first.`);
  }
  const [, members] = await Promise.all([
    stores.upstreams?.replaceGroup(name, null),
    stores.users.replaceGroup(name, null),
  ]);
  return members;
}
