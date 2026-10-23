import { UPSTREAM_ID_PATTERN } from '@server/store/upstream-id.ts';
import { useRef, useState } from 'react';
import type { UnknownIdentity, UpstreamFieldsFragment, UpstreamInput, UpstreamKind } from '@/__generated__/graphql';
import { ComboboxField, InputField, SelectField, SwitchField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Disclosure } from '@/components/disclosure';
import { PasswordField } from '@/components/password-field';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { FormElement } from '@/components/ui/form-element';
import { useBackupInfo } from '@/core/backup';
import { useGroupOptions } from '@/core/groups';
import { commaListOf, linesOf, pairsOf } from '@/core/lists';
import { SaveFailure } from '@/core/save-failure';
import { useCreateUpstream, useUpdateUpstream, useUpstreamRedirectUri } from '@/core/upstreams';
import {
  OTHER_UPSTREAM,
  UPSTREAM_PRESET_OPTIONS,
  type UpstreamPreset,
  upstreamIdOf,
  upstreamPresetById,
} from '@/upstreams/presets';

const KIND_OPTIONS: { value: UpstreamKind; label: string }[] = [
  { value: 'OIDC', label: 'OpenID Connect (Google, Microsoft, GitLab, Authentik…)' },
  { value: 'GITHUB', label: 'GitHub' },
];
const UNKNOWN_OPTIONS: { value: UnknownIdentity; label: string }[] = [
  { value: 'REFUSE', label: 'Turn them away until a user links the account' },
  { value: 'CREATE', label: 'Make a user for them' },
];
const MAPPING_ROWS = 3;
/** The fields under Advanced, so it stays open while one of them is wrong. */
const ADVANCED_FIELDS = ['createDomains', 'groupsClaim', 'groupMappings'] as const;
/** What separates the upstream group from the local one in a mapping line. */
const MAPPING_SEPARATOR = '=';

/**
 * Reads a kind from the select.
 *
 * @param value - The select's value.
 * @returns The kind.
 */
function kindOf(value: string): UpstreamKind {
  return value === 'GITHUB' ? 'GITHUB' : 'OIDC';
}

/**
 * Reads the mapping lines, `upstream = local` each.
 *
 * @param text - The field's text.
 * @returns The mappings.
 */
function mappingsOf(text: string): { upstream: string; local: string }[] {
  return pairsOf(text, MAPPING_SEPARATOR).map(({ name, value }) => ({ upstream: name, local: value }));
}

/**
 * Checks the mapping lines.
 *
 * @param text - The field's text.
 * @returns What is wrong, or undefined.
 */
function mappingsProblem(text: string): string | undefined {
  const bad = linesOf(text).find((line) => {
    const at = line.indexOf(MAPPING_SEPARATOR);
    return at <= 0 || line.slice(at + 1).trim() === '';
  });
  return bad === undefined ? undefined : `Write "${bad}" as upstream-group = local-group.`;
}

interface UpstreamFormDialogProps {
  /** The provider to edit, or null to add one. */
  upstream: UpstreamFieldsFragment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Adds a provider users may sign in through, or changes one. The client secret is never shown back: left blank,
 * the saved one is kept.
 *
 * @param props - The provider and the dialog's open state.
 */
export function UpstreamFormDialog({ upstream, open, onOpenChange }: UpstreamFormDialogProps) {
  const isEdit = upstream !== null;
  const create = useCreateUpstream();
  const update = useUpdateUpstream();
  const failure = isEdit ? update.error : create.error;
  const groupOptions = useGroupOptions();
  // Whether SECRET_KEY seals the client secret, so the field says what happens to it.
  const isSealed = useBackupInfo().data?.isSealed;
  // The ID the name last made, so a typed-over ID stops following the name.
  const autoId = useRef('');
  const [isAdvancedOpen, setAdvancedOpen] = useState(() => hasAdvanced(upstream));

  const form = useAppForm({
    defaultValues: {
      preset: OTHER_UPSTREAM,
      id: upstream?.id ?? '',
      kind: upstream?.kind ?? 'OIDC',
      name: upstream?.name ?? '',
      issuer: upstream?.issuer ?? '',
      clientId: upstream?.clientId ?? '',
      clientSecret: '',
      scopes: upstream?.scopes.join(' ') ?? '',
      unknownIdentity: upstream?.unknownIdentity ?? 'REFUSE',
      createDomains: upstream?.createDomains.join(', ') ?? '',
      createGroups: upstream?.createGroups ?? [],
      countsAsBothFactors: upstream?.countsAsBothFactors ?? false,
      groupsClaim: upstream?.groupsClaim ?? '',
      groupMappings: upstream?.groupMappings.map((each) => `${each.upstream} = ${each.local}`).join('\n') ?? '',
    },
    onSubmit: async ({ value }) => {
      const kind = kindOf(value.kind);
      const vars: { id: string; input: UpstreamInput } = {
        id: value.id.trim(),
        input: {
          name: value.name.trim(),
          kind,
          issuer: kind === 'OIDC' ? value.issuer.trim() : null,
          clientId: value.clientId.trim(),
          clientSecret: value.clientSecret.trim() || null,
          scopes: value.scopes.split(/\s+/).filter((scope) => scope !== ''),
          unknownIdentity: value.unknownIdentity === 'CREATE' ? 'CREATE' : 'REFUSE',
          createDomains: commaListOf(value.createDomains),
          createGroups: value.createGroups,
          countsAsBothFactors: value.countsAsBothFactors,
          groupsClaim: value.groupsClaim.trim() || null,
          groupMappings: mappingsOf(value.groupMappings),
        },
      };
      await (isEdit ? update.mutateAsync(vars) : create.mutateAsync(vars));
      onOpenChange(false);
    },
  });

  /** Makes the ID follow the name, until the ID is typed over. */
  const followName = (name: string): void => {
    if (isEdit || form.getFieldValue('id') !== autoId.current) {
      return;
    }
    autoId.current = upstreamIdOf(name);
    form.setFieldValue('id', autoId.current);
    void form.validateField('id', 'change');
  };

  /** Fills the kind, name, issuer and ID from the provider picked to start from. */
  const applyPreset = (presetId: string): void => {
    const preset = upstreamPresetById(presetId);
    form.setFieldValue('kind', preset.kind);
    form.setFieldValue('issuer', preset.issuer);
    form.setFieldValue('name', preset.name);
    followName(preset.name);
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${upstream.name}` : 'New sign-in provider'}
      description="Lets users sign in with an account they have elsewhere, such as Google, GitHub or a company identity provider."
      size="lg"
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          {isEdit ? (
            <SelectField form={form} name="kind" label="Kind" options={KIND_OPTIONS} />
          ) : (
            <SelectField
              form={form}
              name="preset"
              label="Start from"
              options={UPSTREAM_PRESET_OPTIONS}
              listeners={{ onChange: ({ value }) => applyPreset(value) }}
            />
          )}
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            placeholder="Google"
            description="The sign-in button says Sign in with and this."
            listeners={{ onChange: ({ value }) => followName(value) }}
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the provider a name.') }}
          />
          {isEdit ? null : (
            <InputField
              form={form}
              name="id"
              label="ID"
              required
              placeholder="google"
              description="Made from the name. Lower-case letters, digits and dashes. It is part of the redirect URI, so it cannot change later."
              validators={{
                onChange: ({ value }) =>
                  UPSTREAM_ID_PATTERN.test(value.trim()) ? undefined : 'Use lower-case letters, digits and dashes.',
              }}
            />
          )}
          <form.Subscribe
            selector={(state) => ({
              id: state.values.id.trim(),
              presetId: state.values.preset,
              kind: kindOf(state.values.kind),
            })}
          >
            {({ id, presetId, kind }) => (
              <Section
                level={3}
                title="1. Register Heautou at the provider"
                description={`Add this redirect URI in ${(isEdit ? presetOfKind(kind) : upstreamPresetById(presetId)).registerAt}`}
                contentSlot={<RedirectUri id={isEdit ? upstream.id : UPSTREAM_ID_PATTERN.test(id) ? id : ''} />}
              />
            )}
          </form.Subscribe>
          <Section
            level={3}
            title="2. Paste what it gives you"
            contentSlot={
              <div className="grid gap-4">
                <form.Subscribe
                  selector={(state) => ({
                    kind: kindOf(state.values.kind),
                    issuerExample: upstreamPresetById(state.values.preset).issuerExample,
                  })}
                >
                  {({ kind, issuerExample }) =>
                    kind === 'OIDC' ? (
                      <InputField
                        form={form}
                        name="issuer"
                        label="Issuer URL"
                        required
                        placeholder={issuerExample}
                        description="Its discovery document is read from here, under /.well-known/openid-configuration."
                        validators={{
                          onChange: ({ value, fieldApi }) =>
                            kindOf(fieldApi.form.getFieldValue('kind')) === 'GITHUB' || URL.canParse(value.trim())
                              ? undefined
                              : 'Give the issuer’s https URL.',
                        }}
                      />
                    ) : null
                  }
                </form.Subscribe>
                <InputField
                  form={form}
                  name="clientId"
                  label="Client ID"
                  required
                  description="What the provider gave this server when you registered it there."
                  validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Paste the client ID.') }}
                />
                <PasswordField
                  form={form}
                  name="clientSecret"
                  label="Client secret"
                  autoComplete="off"
                  placeholder={upstream?.hasClientSecret ? 'Saved. Leave blank to keep it.' : undefined}
                  description={`${isSealed === false ? 'Kept in plain text until SECRET_KEY is set' : 'Kept sealed under SECRET_KEY'}, and never shown again. Leave it blank for a public client.`}
                />
                <InputField
                  form={form}
                  name="scopes"
                  label="Scopes"
                  placeholder="Default"
                  description="Separated by spaces. Blank asks for openid profile email, or read:user user:email at GitHub."
                />
                <SwitchField
                  form={form}
                  name="countsAsBothFactors"
                  label="Counts as both factors"
                  description="Trust the provider’s own two-step check, so users who have a second factor here are not asked for it again. Off, they are."
                />
              </div>
            }
          />
          <form.Subscribe
            selector={(state) => ADVANCED_FIELDS.some((name) => (state.fieldMeta[name]?.errors.length ?? 0) > 0)}
          >
            {(hasAdvancedErrors) => (
              <Disclosure
                title="Advanced"
                titleClassName="text-foreground"
                description="New users from this provider, and mapping its groups to groups here."
                // A field in it that is wrong keeps it open, since a closed one would hide why Save is off.
                open={isAdvancedOpen || hasAdvancedErrors}
                onOpenChange={setAdvancedOpen}
                contentClassName="gap-4 pt-2"
                contentSlot={
                  <>
                    <Section
                      level={3}
                      title="New users"
                      description="A user is only ever matched by an account linked to them, never by an email address."
                      contentSlot={
                        <div className="grid gap-4">
                          <SelectField
                            form={form}
                            name="unknownIdentity"
                            label="An account no user has linked"
                            options={UNKNOWN_OPTIONS}
                          />
                          <form.Subscribe selector={(state) => state.values.unknownIdentity === 'CREATE'}>
                            {(isCreating) =>
                              isCreating ? (
                                <>
                                  <InputField
                                    form={form}
                                    name="createDomains"
                                    label="Only for addresses at"
                                    placeholder="Any address"
                                    description="Comma-separated domains, such as example.com. The provider must say the address is verified. Blank makes a user for anybody who can sign in there."
                                  />
                                  <ComboboxField
                                    form={form}
                                    name="createGroups"
                                    label="Their groups"
                                    multiple
                                    freeText
                                    options={groupOptions}
                                    placeholder="None"
                                  />
                                </>
                              ) : null
                            }
                          </form.Subscribe>
                        </div>
                      }
                    />
                    <Section
                      level={3}
                      title="Group mapping"
                      description="Each sign-in puts the user in the groups mapped from theirs upstream, and takes away mapped groups they no longer hold. Other groups are left alone."
                      contentSlot={
                        <div className="grid gap-4">
                          <InputField
                            form={form}
                            name="groupsClaim"
                            label="Groups claim"
                            placeholder="groups"
                            description="The claim the provider lists the user’s groups in. Ask for its scope above if it needs one."
                          />
                          <TextareaField
                            form={form}
                            name="groupMappings"
                            label="Mappings"
                            rows={MAPPING_ROWS}
                            placeholder="engineering = builders"
                            description="One per line: the upstream group, =, the group here. The admin group cannot be mapped."
                            validators={{
                              onChange: ({ value, fieldApi }) =>
                                mappingsProblem(value) ??
                                (linesOf(value).length > 0 && fieldApi.form.getFieldValue('groupsClaim').trim() === ''
                                  ? 'Name the groups claim first.'
                                  : undefined),
                            }}
                          />
                        </div>
                      }
                    />
                  </>
                }
              />
            )}
          </form.Subscribe>
          <SaveFailure error={failure} />
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Add provider'} />
          </form.AppForm>
        </>
      )}
    />
  );
}

/**
 * Shows the redirect URI to register at the provider, with a copy button.
 *
 * @param props - The provider's id, or blank while none is typed.
 */
function RedirectUri({ id }: { id: string }) {
  const uri = useUpstreamRedirectUri(id).data;
  if (uri === undefined) {
    return <p className="text-foreground/60 text-sm">Give the provider an ID to see its redirect URI.</p>;
  }
  return <CodeBlock content={uri} wrap actionSlot={<CopyButton value={uri} label="Copy the redirect URI" />} />;
}

/**
 * Says whether a provider has any of the settings under Advanced changed.
 *
 * @param upstream - The provider, or null for a new one.
 * @returns True when it makes users, or maps groups.
 */
function hasAdvanced(upstream: UpstreamFieldsFragment | null): boolean {
  return (
    upstream !== null &&
    (upstream.unknownIdentity === 'CREATE' || Boolean(upstream.groupsClaim) || upstream.groupMappings.length > 0)
  );
}

/**
 * Finds what step 1 says for a provider being edited, which has no preset.
 *
 * @param kind - The provider's kind.
 * @returns The GitHub preset for GitHub, else the generic one.
 */
function presetOfKind(kind: UpstreamKind): UpstreamPreset {
  return upstreamPresetById(kind === 'GITHUB' ? 'github' : OTHER_UPSTREAM);
}
