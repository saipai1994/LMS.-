-- Core: tenants, campuses, users, sessions, RBAC, audit, academic calendar, numbering.
create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gist;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null,
  status text not null default 'active' check (status in ('active','suspended','offboarding','offboarded')),
  plan text not null default 'standard',
  features jsonb not null default '{}'::jsonb,
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table campuses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null,
  name text not null,
  is_boarding boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  email citext not null,
  full_name text not null,
  password_hash text,
  status text not null default 'invited' check (status in ('invited','active','locked','disabled')),
  mfa_secret text,
  mfa_enabled boolean not null default false,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  invite_token_hash text,
  invite_expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, email),
  unique (tenant_id, id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  key text not null,
  name text not null,
  is_system boolean not null default false,
  unique (tenant_id, key),
  unique (tenant_id, id)
);

create table role_permissions (
  tenant_id uuid not null references tenants(id),
  role_id uuid not null,
  permission text not null,
  primary key (role_id, permission),
  foreign key (tenant_id, role_id) references roles(tenant_id, id) on delete cascade
);

-- campus_id null = tenant-wide scope
create table user_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  role_id uuid not null,
  campus_id uuid,
  foreign key (tenant_id, user_id) references users(tenant_id, id),
  foreign key (tenant_id, role_id) references roles(tenant_id, id),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id)
);
create unique index user_roles_unique on user_roles (user_id, role_id, coalesce(campus_id, '00000000-0000-0000-0000-000000000000'));

create table audit_log (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  actor_user_id uuid,
  action text not null,
  entity_type text,
  entity_id text,
  campus_id uuid,
  details jsonb not null default '{}'::jsonb,
  ip text,
  at timestamptz not null default now()
);
create index audit_log_tenant_at on audit_log (tenant_id, at desc);

create function audit_log_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

create table academic_years (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  starts_on date not null,
  ends_on date not null,
  is_current boolean not null default false,
  check (ends_on > starts_on),
  unique (tenant_id, name),
  unique (tenant_id, id)
);
create unique index academic_years_one_current on academic_years (tenant_id) where is_current;

create table document_sequences (
  tenant_id uuid not null references tenants(id),
  key text not null,
  prefix text not null default '',
  next_value bigint not null default 1,
  primary key (tenant_id, key)
);

-- Row level security on every tenant-owned table (forced so the table owner is also bound).
do $$
declare t text;
begin
  foreach t in array array['campuses','users','sessions','roles','role_permissions','user_roles','audit_log','academic_years','document_sequences']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
