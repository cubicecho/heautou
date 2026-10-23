import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { BackupSection } from '@/backup/backup-section';
import { BrandingSection } from '@/branding/branding-section';
import { RedirectUrisSection } from '@/clients/redirect-uris-section';
import { PageLayout } from '@/components/page-layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBranding } from '@/core/branding';
import { KeysSection } from '@/keys/keys-section';
import type { SlotNode } from '@/lib/utils';
import { MailSection } from '@/mail/mail-section';
import { PasswordRulesSection } from '@/passwords/password-rules-section';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  validateSearch: (search) => settingsSearchSchema.parse(search),
});

/** The parts of the settings page, each a tab, in the order the tabs show them. */
const SETTINGS_SECTIONS = ['sign-in', 'email', 'branding', 'maintenance'] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** What each tab is called. */
const SECTION_LABELS = {
  'sign-in': 'Sign-in',
  email: 'Email',
  branding: 'Branding',
  maintenance: 'Keys and backup',
} as const satisfies Record<SettingsSection, string>;

/** The tab in the URL, so a link can open one. Left out, or one the page does not have, is the first. */
const settingsSearchSchema = z.object({ section: z.enum(SETTINGS_SECTIONS).optional().catch(undefined) });

/**
 * The branding tab, which waits for the saved name since the name field starts from it.
 */
function BrandingTab() {
  const branding = useBranding();
  return branding.isPending ? null : <BrandingSection />;
}

/** What each tab holds. */
const SECTION_CONTENT = {
  'sign-in': () => (
    <>
      <PasswordRulesSection />
      <RedirectUrisSection />
    </>
  ),
  email: () => <MailSection />,
  branding: () => <BrandingTab />,
  maintenance: () => (
    <>
      <KeysSection />
      <BackupSection />
    </>
  ),
} as const satisfies Record<SettingsSection, () => SlotNode>;

/**
 * The provider's own settings, in tabs: sign-in (password rules and redirect URIs), email, branding, and keys and
 * backups. Sign-in providers are on the Users page.
 */
function SettingsPage() {
  const { section = 'sign-in' } = Route.useSearch();
  const Content = SECTION_CONTENT[section];
  return (
    <Tabs value={section} className="h-full">
      <PageLayout
        title="Settings"
        description="How this provider checks passwords and redirect URIs, sends email, presents itself, signs tokens and backs up its data."
        width="prose"
        headerContentSlot={
          <TabsList aria-label="Settings">
            {SETTINGS_SECTIONS.map((each) => (
              <TabsTrigger key={each} value={each} linkSlot={<Link to="/settings" search={{ section: each }} />}>
                {SECTION_LABELS[each]}
              </TabsTrigger>
            ))}
          </TabsList>
        }
        contentClassName="gap-6"
        contentSlot={
          <TabsContent value={section} className="flex flex-col gap-6">
            <Content />
          </TabsContent>
        }
      />
    </Tabs>
  );
}
