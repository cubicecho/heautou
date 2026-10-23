import { Alert } from '@/components/ui/alert';
import { messageOf } from '@/core/errors';

interface SaveFailureProps {
  /** What the save threw, or null while it has not failed. */
  error: Error | null;
}

/** Says why a form dialog's save failed, or nothing while it has not. */
export function SaveFailure({ error }: SaveFailureProps) {
  if (!error) {
    return null;
  }
  return <Alert variant="destructive" title="Not saved" description={messageOf(error)} />;
}
