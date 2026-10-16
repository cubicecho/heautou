import { useBranding } from '@/core/admin';
import { ShieldCheck } from '@/core/app-icons';

/** The name shown until the branding has loaded, and when it fails to. */
const FALLBACK_NAME = 'Heautou';

/**
 * The provider's name, as the operator set it.
 *
 * @returns The name.
 */
export function useBrandName(): string {
  return useBranding().data?.name ?? FALLBACK_NAME;
}

/**
 * The provider's logo, or the shield when it has none. Decorative: the name always sits beside it or in the
 * heading.
 *
 * @param props - The class for its size.
 * @param props.className - Sizes the mark; the shield is coloured by the text around it.
 */
export function BrandIcon({ className }: { className?: string }) {
  const logoUrl = useBranding().data?.logoUrl ?? null;
  return logoUrl === null ? (
    <ShieldCheck className={className} aria-hidden />
  ) : (
    <img src={logoUrl} alt="" className={`${className ?? ''} object-contain`} />
  );
}
