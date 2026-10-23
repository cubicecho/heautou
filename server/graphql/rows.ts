// Reading a generated type's rows from a hand-written field: a mutation's result, the viewer, a group's members. The
// read is drizzle-graphql's own, so the rows carry the columns and relations the request selected.
import { resolveSelection, singularizeMapper } from '@vantreeseba/drizzle-graphql';
import {
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLField,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  getNamedType,
  isObjectType,
  Kind,
  type SelectionNode,
  type SelectionSetNode,
} from 'graphql';
import type { Context } from '../core/context.ts';
import { notFound } from '../core/errors.ts';

/** How the generated types are named, which the build and every read over them must agree on. */
export const SELECTION_NAMING = { typeNameMapper: singularizeMapper } as const;

/** A row as a generated type reads it. */
export type GeneratedRow = Record<string, unknown>;

/** The tables with a generated type, by their key in `server/db/schema.ts`. */
export const GeneratedTable = {
  Users: 'users',
  Clients: 'clients',
  Apis: 'apis',
  Upstreams: 'upstreams',
  ProtectedSites: 'protectedSites',
  AuditEntries: 'auditEntries',
} as const;
export type GeneratedTable = (typeof GeneratedTable)[keyof typeof GeneratedTable];

/**
 * The generated types with hand-written fields, and the column each of those fields finds its store's record by. A
 * generated read fetches only the columns a request selects, so this one is added to every selection of the type.
 */
const KEY_FIELDS: Readonly<Record<string, string>> = { User: 'id', Client: 'clientId', Upstream: 'id' };

/**
 * Makes the selection of a key field.
 *
 * @param name - The field.
 * @returns Its node.
 */
function keyField(name: string): FieldNode {
  return { kind: Kind.FIELD, name: { kind: Kind.NAME, value: name } };
}

/**
 * Says whether a selection already reads a field under its own name.
 *
 * @param selections - The selections.
 * @param name - The field.
 * @returns True when one of them is the field, unaliased.
 */
function selectsField(selections: readonly SelectionNode[], name: string): boolean {
  return selections.some(
    (selection) => selection.kind === Kind.FIELD && selection.name.value === name && selection.alias === undefined,
  );
}

/**
 * Copies a field's info with each keyed type's key field added to every selection of it, nested ones and fragments
 * included. Only the generated read sees the copy: the response holds what the request asked for.
 *
 * @param info - The field being resolved.
 * @returns The copy.
 */
export function selectingKeys(info: GraphQLResolveInfo): GraphQLResolveInfo {
  const fragments: Record<string, FragmentDefinitionNode> = { ...info.fragments };
  const visited = new Set<string>();
  /**
   * Adds the key fields to one selection set and the ones under it.
   *
   * @param set - The selection set.
   * @param typeName - The type it selects from.
   * @returns The set with the keys added.
   */
  const visit = (set: SelectionSetNode, typeName: string): SelectionSetNode => {
    const type = info.schema.getType(typeName);
    const fields = isObjectType(type) ? type.getFields() : {};
    const selections = set.selections.map((selection): SelectionNode => {
      if (selection.kind === Kind.FIELD) {
        const field = fields[selection.name.value];
        return field === undefined || selection.selectionSet === undefined
          ? selection
          : { ...selection, selectionSet: visit(selection.selectionSet, getNamedType(field.type).name) };
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const condition = selection.typeCondition?.name.value ?? typeName;
        return { ...selection, selectionSet: visit(selection.selectionSet, condition) };
      }
      const name = selection.name.value;
      const fragment = info.fragments[name];
      if (fragment !== undefined && visited.has(name) === false) {
        visited.add(name);
        fragments[name] = {
          ...fragment,
          selectionSet: visit(fragment.selectionSet, fragment.typeCondition.name.value),
        };
      }
      return selection;
    });
    const key = KEY_FIELDS[typeName];
    const isMissingKey = key !== undefined && selectsField(selections, key) === false;
    return { ...set, selections: isMissingKey ? [...selections, keyField(key)] : selections };
  };
  const typeName = getNamedType(info.returnType).name;
  const fieldNodes = info.fieldNodes.map((node) =>
    node.selectionSet === undefined ? node : { ...node, selectionSet: visit(node.selectionSet, typeName) },
  );
  return { ...info, fieldNodes, fragments };
}

/**
 * Makes every generated root read select the keys its type's hand-written fields need (`selectingKeys`).
 *
 * @param schema - The built schema. Its root fields are changed in place.
 * @returns The same schema.
 */
export function withKeysSelected(schema: GraphQLSchema): GraphQLSchema {
  const fields: GraphQLField<unknown, unknown>[] = Object.values(schema.getQueryType()?.getFields() ?? {});
  for (const field of fields) {
    const { resolve } = field;
    if (resolve !== undefined) {
      field.resolve = (parent, args, ctx, info) => resolve(parent, args, ctx, selectingKeys(info));
    }
  }
  return schema;
}

/**
 * Reads the rows a filter matches, shaped for the field being resolved.
 *
 * @param ctx - Request context, for the database.
 * @param info - The field being resolved, whose type is the table's.
 * @param table - The table.
 * @param where - A filter in the generated `where` shape.
 * @returns The rows, in the table's default order.
 */
export async function rowsWhere(
  ctx: Pick<Context, 'db'>,
  info: GraphQLResolveInfo,
  table: GeneratedTable,
  where: Record<string, unknown>,
): Promise<GeneratedRow[]> {
  const rows: GeneratedRow[] = await resolveSelection(selectingKeys(info), {
    ...SELECTION_NAMING,
    db: ctx.db,
    table,
    where,
  });
  return rows;
}

/**
 * Reads one row by a filter, shaped for the field being resolved.
 *
 * @param ctx - Request context, for the database.
 * @param info - The field being resolved, whose type is the table's.
 * @param table - The table.
 * @param where - A filter in the generated `where` shape that matches one row.
 * @returns The row, or null when none matches.
 */
export async function rowWhere(
  ctx: Pick<Context, 'db'>,
  info: GraphQLResolveInfo,
  table: GeneratedTable,
  where: Record<string, unknown>,
): Promise<GeneratedRow | null> {
  const row: GeneratedRow | null | undefined = await resolveSelection(selectingKeys(info), {
    ...SELECTION_NAMING,
    db: ctx.db,
    table,
    where,
    single: true,
  });
  return row ?? null;
}

/**
 * Reads one row by a filter, for a field that can't be null.
 *
 * @param ctx - Request context, for the database.
 * @param info - The field being resolved, whose type is the table's.
 * @param table - The table.
 * @param where - A filter in the generated `where` shape that matches one row.
 * @returns The row.
 * @throws NOT_FOUND when none matches, such as a row removed while the request ran.
 */
export async function requiredRow(
  ctx: Pick<Context, 'db'>,
  info: GraphQLResolveInfo,
  table: GeneratedTable,
  where: Record<string, unknown>,
): Promise<GeneratedRow> {
  const row = await rowWhere(ctx, info, table, where);
  if (row === null) {
    throw notFound(`It is no longer in ${table}.`);
  }
  return row;
}
