create table privacy_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('access','correction','erasure')),
  student_id uuid not null,
  requested_by uuid not null,
  details text not null,
  status text not null default 'open' check (status in ('open','in_review','completed','rejected')),
  due_at timestamptz not null default (now() + interval '30 days'),
  handled_by uuid,
  outcome text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, requested_by) references users(tenant_id, id)
);
create table retention_settings (
  tenant_id uuid primary key references tenants(id),
  student_record_years int not null default 7 check (student_record_years between 1 and 50),
  configured_by uuid
);
alter table students add column anonymised_at timestamptz;
do $$
declare t text;
begin
  foreach t in array array['privacy_requests','retention_settings']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
