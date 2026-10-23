-- The documents are named for their concept, not for the JSON file the data directory kept them in before the
-- database: keys.json becomes keys, admin-sessions.json becomes web-sessions, and so on. Only the single documents
-- (keys, branding, settings, mail, protected sites) have a row here; the rest are listed so every former name maps.
UPDATE "documents" SET "name" = "renamed"."to"
FROM (VALUES
  ('clients.json', 'clients'),
  ('users.json', 'users'),
  ('keys.json', 'keys'),
  ('admin-sessions.json', 'web-sessions'),
  ('password-links.json', 'password-links'),
  ('branding.json', 'branding'),
  ('pairings.json', 'pairings'),
  ('settings.json', 'settings'),
  ('factors.json', 'factors'),
  ('upstreams.json', 'upstreams'),
  ('apis.json', 'apis'),
  ('mail.json', 'mail'),
  ('protected-sites.json', 'protected-sites'),
  ('proxy-sessions.json', 'proxy-sessions')
) AS "renamed" ("from", "to")
WHERE "documents"."name" = "renamed"."from";
