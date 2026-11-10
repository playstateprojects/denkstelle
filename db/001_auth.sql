-- Adapted from Space Between db/auth.sql; Better Auth owns these tables.
create table if not exists "user" (id text primary key,name text not null default '',email text not null unique,"emailVerified" boolean not null default false,image text,"createdAt" timestamptz not null default now(),"updatedAt" timestamptz not null default now());
create table if not exists session (id text primary key,"expiresAt" timestamptz not null,token text not null unique,"createdAt" timestamptz not null default now(),"updatedAt" timestamptz not null default now(),"ipAddress" text,"userAgent" text,"userId" text not null references "user"(id) on delete cascade);
create index if not exists session_user_idx on session ("userId");
create table if not exists account (id text primary key,"accountId" text not null,"providerId" text not null,"userId" text not null references "user"(id) on delete cascade,"accessToken" text,"refreshToken" text,"idToken" text,"accessTokenExpiresAt" timestamptz,"refreshTokenExpiresAt" timestamptz,scope text,password text,"createdAt" timestamptz not null default now(),"updatedAt" timestamptz not null default now());
create index if not exists account_user_idx on account ("userId");
create table if not exists verification (id text primary key,identifier text not null,value text not null,"expiresAt" timestamptz not null,"createdAt" timestamptz not null default now(),"updatedAt" timestamptz not null default now());
create index if not exists verification_identifier_idx on verification(identifier);
create table if not exists "rateLimit" (id text primary key,key text not null unique,count integer not null,"lastRequest" bigint not null);
-- The server uses its database role; browser clients never receive database credentials.
alter table "user" enable row level security;
alter table session enable row level security;
alter table account enable row level security;
alter table verification enable row level security;
alter table "rateLimit" enable row level security;
