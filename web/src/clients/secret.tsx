import { Button } from '@/components/ui/button';
import { Eye, EyeOff } from '@/components/ui/icons';

/** What a hidden client secret is drawn as. */
const SECRET_MASK = '••••••••••••••••';

/**
 * Hides a client secret wherever it appears in a value shown on screen.
 *
 * @param text - What is shown: the secret itself, or settings that hold it.
 * @param secret - The client's secret, or null for a public client.
 * @param isShown - Whether the secret is shown.
 * @returns The text, with the secret masked unless it is shown.
 */
export function maskSecret(text: string, secret: string | null, isShown: boolean): string {
  return isShown || secret === null || secret === '' ? text : text.replaceAll(secret, SECRET_MASK);
}

interface SecretToggleProps {
  /** Whether the secret is shown now. */
  isShown: boolean;
  onShownChange: (isShown: boolean) => void;
}

/** The button that shows or hides a client secret. A copy beside it still copies the real value. */
export function SecretToggle({ isShown, onShownChange }: SecretToggleProps) {
  return (
    <Button
      // One name, with the pressed state saying whether it is shown, so the button does not rename itself.
      aria-label="Show client secret"
      aria-pressed={isShown}
      hint={isShown ? 'Hide secret' : 'Show secret'}
      variant="outline"
      size="icon-sm"
      iconSlot={isShown ? <EyeOff /> : <Eye />}
      onClick={() => onShownChange(isShown === false)}
    />
  );
}
