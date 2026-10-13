create table password_resets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);
alter table password_resets enable row level security;
alter table password_resets force row level security;
create policy tenant_isolation on password_resets using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
