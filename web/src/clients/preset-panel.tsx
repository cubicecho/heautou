import { Link } from '@tanstack/react-router';
import type { ClientFieldsFragment } from '@/__generated__/graphql';
import {
  baseUrlOfClient,
  type ClientPreset,
  envText,
  heautouUrlOf,
  PRESET_SECTION_LABELS,
  PRESETS,
  type PresetConfig,
  presetById,
  SITE_PRESETS,
  type SitePreset,
  sitePresetById,
  UNSUPPORTED_APPS,
} from '@/clients/presets';
import { maskSecret, SecretToggle } from '@/clients/secret';
import type { SelectEntry } from '@/components/app-form';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { ExternalLink, ShieldCheck } from '@/core/app-icons';
import { useProviderInfo } from '@/core/provider';

/** What the panel shows for the app's address when no redirect URI holds it any more. */
const UNKNOWN_BASE_URL = '<app address>';

/** The picker's value for no preset. No preset has it as its ID, since they are stored on clients. */
export const BLANK_PRESET = 'blank';

/** The order the apps are listed in, clients, forward-auth guides and unsupported apps alike. */
const APP_ORDER = [
  'mealie',
  'frigate',
  'home-assistant',
  'immich',
  'jellyfin',
  'music-assistant',
  'omada-controller',
] as const;

/**
 * The picker's row for one app under the Apps heading.
 *
 * @param id - The app.
 * @returns Its option, disabled with the reason for an app Heautou cannot sign in.
 */
function appOption(id: string): SelectEntry {
  const group = PRESET_SECTION_LABELS.apps;
  const unsupported = UNSUPPORTED_APPS.find((app) => app.id === id);
  if (unsupported !== undefined) {
    return { value: id, label: unsupported.name, group, disabled: true, hint: unsupported.reason };
  }
  const site = sitePresetById(id);
  if (site !== undefined) {
    return { value: id, label: site.name, group, meta: 'Forward auth' };
  }
  return { value: id, label: presetById(id)?.name ?? id, group };
}

/** The apps in `APP_ORDER`, then any preset added to the list without being placed there. */
const APP_IDS = [
  ...APP_ORDER,
  ...[...PRESETS, ...SITE_PRESETS]
    .filter((preset) => preset.section === 'apps' && (APP_ORDER as readonly string[]).includes(preset.id) === false)
    .map((preset) => preset.id),
];

/** The "Start from" picker's rows: a blank client, the apps, then the cubicecho apps under their own heading. */
export const PRESET_OPTIONS: readonly SelectEntry[] = [
  { value: BLANK_PRESET, label: 'Blank client' },
  { separator: true },
  ...APP_IDS.map(appOption),
  { separator: true },
  ...PRESETS.filter((preset) => preset.section === 'cubicecho').map((preset) => ({
    value: preset.id,
    label: preset.name,
    group: PRESET_SECTION_LABELS.cubicecho,
  })),
];

/**
 * What the address field says under itself: what the address is for, and the app's docs.
 *
 * @param props - The preset.
 */
export function PresetLinks({ preset }: { preset: ClientPreset }) {
  return (
    <>
      The address you open {preset.name} at. The redirect URIs are built from it.{' '}
      <a className="underline" href={preset.docsUrl} target="_blank" rel="noreferrer">
        {preset.name}'s sign-in docs
      </a>
      .
    </>
  );
}

/**
 * A preset's steps or caveats, as a list inside an alert.
 *
 * @param props - The notes.
 * @param props.notes - One sentence each.
 */
function NoteList({ notes }: { notes: readonly string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/** A client secret in the settings, and whether it is shown. */
interface SecretView {
  /** The secret, or null for a public client. */
  value: string | null;
  isShown: boolean;
  onShownChange: (isShown: boolean) => void;
}

/**
 * The settings to copy into the app: an env block, a file, or a row per field.
 *
 * @param props - What to set, and the client secret in it, masked until shown. A copy copies the real value.
 */
function ConfigView({ config, secret }: { config: PresetConfig; secret?: SecretView | undefined }) {
  const shown = (text: string): string =>
    secret === undefined ? text : maskSecret(text, secret.value, secret.isShown);
  const toggleFor = (text: string) =>
    secret === undefined || secret.value === null || text.includes(secret.value) === false ? null : (
      <SecretToggle isShown={secret.isShown} onShownChange={secret.onShownChange} />
    );
  if (config.format === 'file') {
    return (
      <CodeBlock
        title={config.fileName}
        language={config.language}
        content={shown(config.text)}
        actionSlot={
          // The block's action column stacks what it is given, so the two buttons share a row.
          <div className="flex gap-1">
            {toggleFor(config.text)}
            <CopyButton value={config.text} />
          </div>
        }
      />
    );
  }
  if (config.format === 'env') {
    const text = envText(config.settings);
    return (
      <div className="flex flex-col gap-2">
        <CodeBlock
          title=".env"
          content={shown(text)}
          actionSlot={
            <div className="flex gap-1">
              {toggleFor(text)}
              <CopyButton value={text} />
            </div>
          }
        />
        <DescriptionList
          layout="stacked"
          contentSlot={config.settings
            .filter((setting) => setting.note !== undefined)
            .map((setting) => (
              <PropertyRow
                key={setting.name}
                label={setting.name}
                labelClassName="font-mono font-normal"
                value={setting.note}
                valueClassName="text-foreground/70 text-sm"
              />
            ))}
        />
      </div>
    );
  }
  return (
    <DescriptionList
      contentSlot={config.settings.map((setting) => (
        <PropertyRow
          key={setting.name}
          label={setting.name}
          value={shown(setting.value)}
          hint={setting.note}
          valueClassName="font-mono break-all whitespace-pre-line"
          actionSlot={
            <>
              {toggleFor(setting.value)}
              <CopyButton value={setting.value} label={`Copy ${setting.name}`} />
            </>
          }
        />
      ))}
    />
  );
}

/**
 * How to configure the app a client was started from, filled in with the client's values.
 *
 * @param props - The client and its preset, and whether the client secret in the settings is shown.
 */
export function PresetPanel({
  client,
  preset,
  isSecretShown,
  onSecretShownChange,
}: {
  client: ClientFieldsFragment;
  preset: ClientPreset;
  isSecretShown: boolean;
  onSecretShownChange: (isShown: boolean) => void;
}) {
  const provider = useProviderInfo().data;
  if (provider === undefined) {
    return null;
  }
  const config = preset.configure({
    issuer: provider.issuer,
    discoveryUrl: provider.discoveryUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret ?? null,
    baseUrl: baseUrlOfClient(preset, client.redirectUris) ?? UNKNOWN_BASE_URL,
    allowedGroups: client.allowedGroups,
  });

  return (
    <Section
      title={`Configure ${preset.name}`}
      description={preset.where}
      actionSlot={
        <Button
          variant="outline"
          size="sm"
          iconSlot={<ExternalLink />}
          content="Docs"
          linkSlot={<a href={preset.docsUrl} target="_blank" rel="noreferrer" aria-label={`${preset.name}'s docs`} />}
        />
      }
      contentSlot={
        <div className="flex flex-col gap-3">
          {preset.notes !== undefined && <Alert variant="info" description={<NoteList notes={preset.notes} />} />}
          <ConfigView
            config={config}
            secret={{ value: client.clientSecret ?? null, isShown: isSecretShown, onShownChange: onSecretShownChange }}
          />
        </div>
      }
    />
  );
}

/**
 * The guide for an app that goes behind forward auth: no client, a protected site and the app's own settings.
 *
 * @param props - The guide.
 */
export function SitePresetGuide({ preset }: { preset: SitePreset }) {
  const provider = useProviderInfo().data;
  const config = provider === undefined ? null : preset.configure({ heautouUrl: heautouUrlOf(provider.issuer) });

  return (
    <div className="flex flex-col gap-4">
      <Alert
        variant="info"
        title={`${preset.name} needs no client`}
        description={
          <>
            <p>It signs in through forward auth. Add it as a protected site, then set it up as below.</p>
            <NoteList notes={preset.notes} />
          </>
        }
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="info"
          size="sm"
          iconSlot={<ShieldCheck />}
          content="Open Protected sites"
          linkSlot={<Link to="/sites" />}
        />
        <Button
          variant="outline"
          size="sm"
          iconSlot={<ExternalLink />}
          content={`${preset.name}'s docs`}
          linkSlot={<a href={preset.docsUrl} target="_blank" rel="noreferrer" />}
        />
      </div>
      <p className="text-foreground/70 text-sm">{preset.where}</p>
      {config !== null && <ConfigView config={config} />}
    </div>
  );
}
