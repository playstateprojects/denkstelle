-- Greeting audio uploaded through the project page, stored privately in R2 and served by /api/public/greeting/:projectId.
-- phone_greeting_url (009) stays as an external-URL override; an uploaded file takes precedence.
alter table projects add column if not exists phone_greeting_key text;
alter table projects add column if not exists phone_greeting_mime text;
alter table projects add column if not exists phone_greeting_updated_at timestamptz;
