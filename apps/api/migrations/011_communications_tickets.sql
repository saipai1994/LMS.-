create table message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  key text not null,
  channel text not null check (channel in ('in_app','email','sms')),
  language text not null default 'en',
  subject text,
  body text not null,
  unique (tenant_id, key, channel, language)
);
create table announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text not null,
  body text not null,
  audience_type text not null check (audience_type in ('all','staff','parents','students','grade','section','hostel')),
  audience_ref uuid,
  channels text[] not null default '{in_app}',
  priority text not null default 'normal' check (priority in ('normal','emergency')),
  scheduled_for timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled','sent','cancelled')),
  created_by uuid not null,
  sent_at timestamptz,
  recipients int,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table delivery_attempts (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  announcement_id uuid not null,
  user_id uuid not null,
  channel text not null check (channel in ('email','sms')),
  status text not null check (status in ('not_configured','sent','failed','skipped_by_preference')),
  error text,
  at timestamptz not null default now(),
  foreign key (tenant_id, announcement_id) references announcements(tenant_id, id)
);
create table notification_prefs (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  channel text not null check (channel in ('in_app','email','sms')),
  enabled boolean not null,
  primary key (user_id, channel),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);
create table tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  requester_id uuid not null,
  student_id uuid,
  category text not null check (category in ('request','complaint','fees','academic','transport','hostel','other')),
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  assigned_to uuid,
  sla_due_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, requester_id) references users(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, assigned_to) references users(tenant_id, id),
  unique (tenant_id, id)
);
create table ticket_comments (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  ticket_id uuid not null,
  author_id uuid not null,
  body text not null,
  internal boolean not null default false,
  at timestamptz not null default now(),
  foreign key (tenant_id, ticket_id) references tickets(tenant_id, id)
);
do $$
declare t text;
begin
  foreach t in array array['message_templates','announcements','delivery_attempts','notification_prefs','tickets','ticket_comments']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
