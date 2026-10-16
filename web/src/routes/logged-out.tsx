import { createFileRoute } from '@tanstack/react-router';
import { CenteredLayout } from '@/components/centered-layout';
import { CircleCheck } from '@/components/ui/icons';
import { loggedOutSearchSchema } from '@/provider/search';

export const Route = createFileRoute('/logged-out')({
  validateSearch: (search) => loggedOutSearchSchema.parse(search),
  component: LoggedOutPage,
});

/**
 * "You're signed out." Shown after signing out when the app gave no page to go back to.
 */
function LoggedOutPage() {
  const { client } = Route.useSearch();
  const from = client === undefined ? 'Heautou' : `${client} and Heautou`;

  return (
    <CenteredLayout
      level={1}
      iconSlot={<CircleCheck />}
      title="You're signed out"
      description={`You've been signed out of ${from}. You can close this tab.`}
    />
  );
}
