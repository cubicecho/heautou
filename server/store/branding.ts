import { z } from 'zod';
import { BRANDING_DEFAULTS } from '../core/defaults.ts';
import { badInput } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import { BYTES_PER_KB } from '../core/wire.ts';
import type { DataDocument } from '../db/document.ts';

/** The image types a logo may be. SVG is allowed: it is only ever shown in an `<img>`, which runs no scripts. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

/** A logo as stored: its type and its bytes in base64. */
export interface Logo {
  type: LogoType;
  data: string;
  /** When it was set, as an ISO 8601 string. It versions the logo's URL. */
  updatedAt: string;
}

/** What the sign-in page and the sidebar show. */
export interface Branding {
  name: string;
  logo: Logo | null;
}

/** A `data:` URL as the browser's file reader makes one. */
const DATA_URL_PATTERN = /^data:([a-z+/.-]+);base64,([A-Za-z0-9+/=]+)$/;

const nameSchema = z.string().trim().min(1, 'give it a name').max(BRANDING_DEFAULTS.maxNameLength);

/** The provider's name and logo, kept in one document. */
export interface BrandingStore {
  read: () => Branding;
  setName: (name: string) => Promise<Branding>;
  /**
   * Sets or removes the logo.
   *
   * @param dataUrl - The image as a base64 `data:` URL, or null to remove it.
   * @returns The branding.
   * @throws BAD_USER_INPUT for another type or a file over `BRANDING_DEFAULTS.maxLogoBytes`.
   */
  setLogo: (dataUrl: string | null) => Promise<Branding>;
}

/**
 * Opens the branding store on its document.
 *
 * @param document - The document. Missing, the defaults apply.
 * @param [now] - The clock.
 * @returns The store.
 */
export function createBrandingStore(
  document: DataDocument<Partial<Branding>>,
  now: () => Date = () => new Date(),
): BrandingStore {
  const read = (): Branding => {
    const { name = BRANDING_DEFAULTS.name, logo = null } = document.read();
    return { name, logo };
  };
  return {
    read,
    setName: async (name) => {
      const parsed = parseInput(nameSchema, name);
      await document.update(() => ({ ...read(), name: parsed }));
      return read();
    },
    setLogo: async (dataUrl) => {
      if (dataUrl === null) {
        await document.update(() => ({ ...read(), logo: null }));
        return read();
      }
      const [, type = '', data = ''] = DATA_URL_PATTERN.exec(dataUrl) ?? [];
      const isKnownType = (LOGO_TYPES as readonly string[]).includes(type);
      if (isKnownType === false) {
        throw badInput('logo: use a PNG, JPEG, WebP or SVG image.');
      }
      if (Buffer.byteLength(data, 'base64') > BRANDING_DEFAULTS.maxLogoBytes) {
        throw badInput(`logo: use an image under ${BRANDING_DEFAULTS.maxLogoBytes / BYTES_PER_KB} KB.`);
      }
      await document.update(() => ({
        ...read(),
        logo: { type: type as LogoType, data, updatedAt: now().toISOString() },
      }));
      return read();
    },
  };
}
