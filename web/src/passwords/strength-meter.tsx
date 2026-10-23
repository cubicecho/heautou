import { Progress } from '@/components/ui/progress';
import { usePasswordStrengthRule } from '@/core/settings';
import { usePasswordStrength } from '@/passwords/strength';

/** What each zxcvbn score is called, from 0 to 4. */
const SCORE_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;

interface PasswordStrengthMeterProps {
  /** The password typed so far. Empty, the meter draws nothing. */
  password: string;
  /** The owner's username, name and email: a password made of them is easier to guess. */
  owner: readonly string[];
}

/**
 * Names a score.
 *
 * @param score - A zxcvbn score.
 * @returns Its label.
 */
function labelOf(score: number): string {
  return SCORE_LABELS[score] ?? '';
}

/** A bar for how hard a new password is to guess, with what zxcvbn says about it. The server makes the final call. */
export function PasswordStrengthMeter({ password, owner }: PasswordStrengthMeterProps) {
  const strength = usePasswordStrength(password, owner);
  const rule = usePasswordStrengthRule();
  if (strength === null) {
    return null;
  }
  const minScore = rule.data?.minScore ?? 0;
  const label = labelOf(strength.score);
  const isStrongEnough = strength.score >= minScore;
  const verdict = isStrongEnough
    ? `${label}.`
    : `${label}: too easy to guess. It has to be ${labelOf(minScore).toLowerCase()} or better.`;
  const notes = [verdict, strength.warning, strength.suggestion].filter((note) => note !== null);

  return (
    <div className="grid gap-1.5">
      <Progress
        value={strength.score + 1}
        max={SCORE_LABELS.length}
        label="Password strength"
        valueLabel={label}
        indicatorClassName={isStrongEnough ? 'bg-positive' : 'bg-negative'}
      />
      <p className="text-xs text-foreground/60">{notes.join(' ')}</p>
    </div>
  );
}
