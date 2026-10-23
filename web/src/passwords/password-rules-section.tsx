import { Combobox } from '@/components/combobox';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { messageOf } from '@/core/errors';
import { usePasswordRules, useSetPasswordRules } from '@/core/settings';

/** The minimum strengths an operator can pick, by zxcvbn score, in words. */
const MIN_SCORE_OPTIONS = [
  { value: '0', label: 'Any password (length only)' },
  { value: '1', label: 'Not trivially guessable' },
  { value: '2', label: 'Somewhat hard to guess' },
  { value: '3', label: 'Hard to guess (recommended)' },
  { value: '4', label: 'Very hard to guess' },
];

/**
 * What a new password must pass: how hard it is to guess, and whether it has leaked.
 */
export function PasswordRulesSection() {
  const rules = usePasswordRules();
  const save = useSetPasswordRules();
  const current = rules.data;
  const isLocked = current === undefined || save.isPending;

  return (
    <Section
      title="Passwords"
      description="Checked whenever a password is set: by an admin, with an invite or reset link, on the account page or at setup. Passwords set before keep working."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {rules.isError && <QueryError error={rules.error} onRetry={rules.refetch} what="the password rules" />}
          <SettingRow
            title="Minimum strength"
            description="How hard to guess a new password must be, as zxcvbn rates it. The forms show a meter as it is typed."
            actionSlot={({ titleId }) => (
              <Combobox
                aria-labelledby={titleId}
                className="w-60"
                options={MIN_SCORE_OPTIONS}
                value={current === undefined ? '' : String(current.minScore)}
                disabled={isLocked}
                onValueChange={(value) => save.mutate({ minScore: Number(value) })}
              />
            )}
          />
          <SettingRow
            title="Refuse breached passwords"
            description="Looks each new password up in Have I Been Pwned. Only the first 5 characters of the password’s SHA-1 hash are sent to haveibeenpwned.com. If it cannot be reached, the password is accepted."
            actionSlot={({ titleId }) => (
              <Switch
                aria-labelledby={titleId}
                checked={current?.checkBreaches ?? false}
                disabled={isLocked}
                onCheckedChange={(checked) => save.mutate({ checkBreaches: checked })}
              />
            )}
          />
          {save.error !== null && (
            <Alert variant="destructive" title="Setting not saved" description={messageOf(save.error)} />
          )}
        </div>
      }
    />
  );
}
