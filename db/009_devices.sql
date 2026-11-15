-- Telephone devices (Raspberry Pi handsets and the browser simulator) that submit audio through /api/device.
-- Idempotent: scripts/migrate.ts applies each file once, but keep it re-runnable.

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  kind text not null default 'handset' check(kind in ('handset','simulator')),
  -- sha256 of the device credential. The credential itself is shown once at creation and never stored.
  -- Null for simulators: they authenticate with the admin's session instead.
  token_hash text unique,
  owner_user_id text references "user"(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  check((kind='handset' and token_hash is not null) or (kind='simulator' and owner_user_id is not null))
);
create index if not exists devices_project_idx on devices(project_id);
-- One simulator per admin per project, created on first use.
create unique index if not exists devices_simulator_owner_idx on devices(owner_user_id,project_id) where kind='simulator';
alter table devices enable row level security;

-- Prerecorded greeting/question played when the handset is lifted. Shared by every device of the project.
alter table projects add column if not exists phone_greeting_url text;

-- Recordings submitted by a device. client_recording_id is chosen by the device and makes retries idempotent.
alter table sources add column if not exists device_id uuid references devices(id) on delete set null;
alter table sources add column if not exists client_recording_id uuid;
alter table sources add column if not exists checksum_sha256 text;
create unique index if not exists sources_device_recording_idx on sources(device_id,client_recording_id);
