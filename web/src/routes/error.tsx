import { createFileRoute, Link } from '@tanstack/react-router';
import { CenteredLayout } from '@/components/centered-layout';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { TriangleAlert } from '@/components/ui/icons';
import { errorCopyOf } from '@/provider/error-copy';
import { errorSearchSchema, goBack } from '@/provider/search';

export const Route = createFileRoute('/error')({
  validateSearch: (search) => errorSearchSchema.parse(search),
  component: ErrorPage,
});

/**
 * Says what went wrong mid-sign-in, in words, with the provider's own details underneath for
 * whoever sets the app up.
 */
function ErrorPage() {
  const { error, description, client, redirect_uri: redirectUri } = Route.useSearch();
  const copy = errorCopyOf(error);

  const rows = [
    client === undefined ? null : <PropertyRow key="client" label="App" value={client} />,
    redirectUri === undefined ? null : (
      <PropertyRow
        key="redirect"
        label="Redirect URI sent"
        value={redirectUri}
        valueClassName="font-mono break-all"
        actionSlot={<CopyButton value={redirectUri} label="Copy redirect URI" />}
      />
    ),
    error === undefined ? null : <PropertyRow key="code" label="Error" value={error} valueClassName="font-mono" />,
    description === undefined ? null : <PropertyRow key="detail" label="Details" value={description} />,
  ].filter((row) => row !== null);

  return (
    <CenteredLayout
      level={1}
      iconSlot={<TriangleAlert />}
      title={copy.title}
      description={copy.description}
      contentSlot={rows.length === 0 ? undefined : <DescriptionList contentSlot={rows} />}
      footerActionsSlot={
        <>
          {copy.isClientSetup && <Button variant="outline" content="Open clients" linkSlot={<Link to="/clients" />} />}
          <Button variant="info" content="Go back" onClick={goBack} />
        </>
      }
    />
  );
}
