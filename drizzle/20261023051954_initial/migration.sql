CREATE TYPE "audit_target_kind" AS ENUM('client', 'user', 'group', 'pairing', 'keys', 'branding', 'settings', 'upstream', 'api', 'protected_site');--> statement-breakpoint
CREATE TYPE "audit_type" AS ENUM('sign_in_succeeded', 'sign_in_failed', 'sign_in_throttled', 'sign_in_refused', 'app_signed_in', 'app_sign_in_failed', 'app_token_refused', 'app_signed_out', 'app_logout_failed', 'machine_token_issued', 'device_code_issued', 'device_approved', 'device_refused', 'web_signed_in', 'web_signed_out', 'client_created', 'client_updated', 'client_secret_rotated', 'client_deleted', 'pairing_started', 'pairing_cancelled', 'pairing_completed', 'pairing_finished', 'registration_updated', 'registration_deleted', 'user_created', 'user_updated', 'user_password_set', 'user_deleted', 'user_disabled', 'user_enabled', 'user_session_ended', 'user_signed_out', 'password_link_created', 'password_link_used', 'group_renamed', 'group_deleted', 'keys_rotated', 'branding_name_set', 'branding_logo_set', 'http_redirects_set', 'password_rules_set', 'account_password_changed', 'account_password_failed', 'account_signed_out_everywhere', 'admin_set_up', 'second_factor_failed', 'totp_added', 'totp_removed', 'recovery_codes_made', 'passkey_added', 'passkey_removed', 'user_second_factors_reset', 'backup_downloaded', 'data_restored', 'upstream_created', 'upstream_updated', 'upstream_deleted', 'upstream_linked', 'upstream_unlinked', 'upstream_groups_applied', 'api_created', 'api_updated', 'api_deleted', 'mail_sent', 'mail_failed', 'mail_server_set', 'mail_server_removed', 'mail_options_set', 'password_reset_requested', 'picture_set', 'picture_removed', 'proxy_signed_in', 'proxy_signed_out', 'proxy_refused', 'protected_site_created', 'protected_site_updated', 'protected_site_deleted', 'proxy_cookie_domain_set');--> statement-breakpoint
CREATE TYPE "client_auth_method" AS ENUM('client_secret_basic', 'client_secret_post', 'none');--> statement-breakpoint
CREATE TYPE "client_source" AS ENUM('admin', 'paired');--> statement-breakpoint
CREATE TYPE "token_format" AS ENUM('jwt', 'opaque');--> statement-breakpoint
CREATE TYPE "unknown_identity" AS ENUM('refuse', 'create');--> statement-breakpoint
CREATE TYPE "upstream_kind" AS ENUM('oidc', 'github');--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"token_hash" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_clients" (
	"api_identifier" text,
	"client_id" text,
	"position" integer NOT NULL,
	CONSTRAINT "pk_api_clients" PRIMARY KEY("api_identifier","client_id")
);
--> statement-breakpoint
CREATE TABLE "apis" (
	"identifier" text PRIMARY KEY,
	"name" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_format" "token_format" NOT NULL,
	"access_token_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" text PRIMARY KEY,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_entries_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone NOT NULL,
	"type" "audit_type" NOT NULL,
	"actor_user_id" text,
	"actor_username" text,
	"ip" text,
	"target_kind" "audit_target_kind",
	"target_id" text,
	"target_name" text,
	"detail" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"client_id" text PRIMARY KEY,
	"name" text NOT NULL,
	"client_secret" text,
	"auth_method" "client_auth_method" NOT NULL,
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"post_logout_redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"groups_claim" text NOT NULL,
	"allow_client_credentials" boolean DEFAULT false NOT NULL,
	"allow_device_flow" boolean DEFAULT false NOT NULL,
	"source" "client_source" DEFAULT 'admin'::"client_source" NOT NULL,
	"logo_uri" text,
	"access_token_seconds" integer,
	"id_token_seconds" integer,
	"refresh_token_seconds" integer,
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean DEFAULT true NOT NULL,
	"preset" text,
	"pairing_id" text,
	"client_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"name" text PRIMARY KEY,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_models" (
	"model" text,
	"id" text,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "pk_oidc_models" PRIMARY KEY("model","id")
);
--> statement-breakpoint
CREATE TABLE "pairings" (
	"id" text PRIMARY KEY,
	"token_hash" text NOT NULL,
	"allowed_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"groups_claim" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"client_id" text,
	"client_uri" text,
	"device_client_id" text,
	"is_finished" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_links" (
	"token_hash" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protected_sites" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"path_prefix" text DEFAULT '' NOT NULL,
	"allowed_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"require_second_factor" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_sessions" (
	"token_hash" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"amr" text[] DEFAULT '{}'::text[] NOT NULL,
	"acr" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"user_id" text,
	"code_hash" text,
	"position" integer NOT NULL,
	CONSTRAINT "pk_recovery_codes" PRIMARY KEY("user_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "totp_factors" (
	"user_id" text PRIMARY KEY,
	"secret" text NOT NULL,
	"last_step" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_group_mappings" (
	"upstream_id" text,
	"position" integer,
	"upstream" text NOT NULL,
	"local" text NOT NULL,
	CONSTRAINT "pk_upstream_group_mappings" PRIMARY KEY("upstream_id","position")
);
--> statement-breakpoint
CREATE TABLE "upstream_links" (
	"provider_id" text,
	"issuer" text,
	"subject" text,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "pk_upstream_links" PRIMARY KEY("provider_id","issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "upstreams" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"kind" "upstream_kind" NOT NULL,
	"issuer" text,
	"client_id" text NOT NULL,
	"client_secret" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"unknown_identity" "unknown_identity" NOT NULL,
	"create_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"create_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"counts_as_both_factors" boolean DEFAULT false NOT NULL,
	"groups_claim" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"username" text NOT NULL,
	"password_hash" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"claims" jsonb DEFAULT '{}' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"picture_version" text
);
--> statement-breakpoint
CREATE INDEX "idx_api_clients_client_id" ON "api_clients" ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_audit_entries_seq" ON "audit_entries" ("seq");--> statement-breakpoint
CREATE INDEX "idx_audit_entries_actor_user_id" ON "audit_entries" ("actor_user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_entries_target" ON "audit_entries" ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "idx_oidc_models_expires_at" ON "oidc_models" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_passkeys_user_id" ON "passkeys" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_protected_sites_host_path_prefix" ON "protected_sites" ("host","path_prefix");--> statement-breakpoint
CREATE INDEX "idx_upstream_links_user_id" ON "upstream_links" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_username" ON "users" ("username");--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_api_identifier_apis_identifier_fkey" FOREIGN KEY ("api_identifier") REFERENCES "apis"("identifier") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "upstream_group_mappings" ADD CONSTRAINT "upstream_group_mappings_upstream_id_upstreams_id_fkey" FOREIGN KEY ("upstream_id") REFERENCES "upstreams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "upstream_links" ADD CONSTRAINT "upstream_links_provider_id_upstreams_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "upstreams"("id") ON DELETE CASCADE;