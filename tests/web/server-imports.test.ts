import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB_SOURCE = path.join(ROOT, 'web/src');
/** What the web app's alias for the server's folder starts with (`vite.config.ts`). */
const SERVER_ALIAS = '@server/';
/** Every module specifier in an import or export statement, or a dynamic import. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/**
 * Lists the module specifiers a source file imports.
 *
 * @param file - The file.
 * @returns Its specifiers.
 */
function specifiersOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map(([, specifier = '']) => specifier);
}

/**
 * Lists the web app's source files.
 *
 * @param dir - Where to start.
 * @returns Every `.ts` and `.tsx` file under it.
 */
function webFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Finds what a server module pulls in that a browser can't load: a package or a Node built-in, at any depth.
 *
 * @param file - The server module.
 * @param [seen] - The modules already checked.
 * @returns The specifiers that are not other server modules, by the module that imports them.
 */
function nonLocalImports(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  return specifiersOf(file).flatMap((specifier) => {
    const isLocal = specifier.startsWith('.');
    if (isLocal) {
      return nonLocalImports(path.resolve(path.dirname(file), specifier), seen);
    }
    return [`${path.relative(ROOT, file)} imports ${specifier}`];
  });
}

describe('the web app’s imports of server modules', () => {
  const imported = [
    ...new Set(
      webFiles(WEB_SOURCE).flatMap((file) =>
        specifiersOf(file)
          .filter((specifier) => specifier.startsWith(SERVER_ALIAS))
          .map((specifier) => path.join(ROOT, 'server', specifier.slice(SERVER_ALIAS.length))),
      ),
    ),
  ];

  it('reach only modules that import nothing but other such modules', () => {
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.flatMap((file) => nonLocalImports(file))).toEqual([]);
  });
});
