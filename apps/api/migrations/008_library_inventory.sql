create table books (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  isbn text,
  title text not null,
  author text not null,
  category text,
  kind text not null default 'physical' check (kind in ('physical','digital')),
  url text check (url is null or url ~ '^https?://'),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (tenant_id, id)
);
create table book_copies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  book_id uuid not null,
  barcode text not null,
  status text not null default 'available' check (status in ('available','issued','held','lost','damaged')),
  foreign key (tenant_id, book_id) references books(tenant_id, id),
  unique (tenant_id, barcode),
  unique (tenant_id, id)
);
create table loans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  copy_id uuid not null,
  student_id uuid,
  borrower_user_id uuid,
  issued_on date not null default current_date,
  due_on date not null,
  returned_on date,
  renewals int not null default 0,
  fine_minor bigint not null default 0,
  fine_settled boolean not null default false,
  issued_by uuid not null,
  foreign key (tenant_id, copy_id) references book_copies(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, borrower_user_id) references users(tenant_id, id),
  check ((student_id is not null) <> (borrower_user_id is not null)),
  unique (tenant_id, id)
);
create unique index one_open_loan_per_copy on loans (copy_id) where returned_on is null;
create table reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  book_id uuid not null,
  student_id uuid not null,
  status text not null default 'waiting' check (status in ('waiting','ready','fulfilled','cancelled')),
  held_copy_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, book_id) references books(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create unique index one_active_reservation on reservations (book_id, student_id) where status in ('waiting','ready');

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  contact text,
  unique (tenant_id, name),
  unique (tenant_id, id)
);
create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  sku text not null,
  name text not null,
  category text not null,
  unit text not null default 'pcs',
  reorder_level int not null default 0 check (reorder_level >= 0),
  location text,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (tenant_id, sku),
  unique (tenant_id, id)
);
create table stock_movements (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  item_id uuid not null,
  qty_delta int not null check (qty_delta <> 0),
  kind text not null check (kind in ('receipt','issue','adjustment')),
  ref text,
  note text,
  by_user uuid not null,
  at timestamptz not null default now(),
  foreign key (tenant_id, item_id) references inventory_items(tenant_id, id)
);
create table purchase_requisitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  number text not null,
  requested_by uuid not null,
  justification text not null,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected','ordered')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (tenant_id, number),
  unique (tenant_id, id)
);
create table requisition_lines (
  tenant_id uuid not null references tenants(id),
  requisition_id uuid not null,
  item_id uuid not null,
  qty int not null check (qty > 0),
  est_unit_cost_minor bigint not null check (est_unit_cost_minor >= 0),
  primary key (requisition_id, item_id),
  foreign key (tenant_id, requisition_id) references purchase_requisitions(tenant_id, id),
  foreign key (tenant_id, item_id) references inventory_items(tenant_id, id)
);
create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text not null,
  requisition_id uuid not null,
  supplier_id uuid not null,
  status text not null default 'ordered' check (status in ('ordered','partially_received','received')),
  total_minor bigint not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, requisition_id) references purchase_requisitions(tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers(tenant_id, id),
  unique (tenant_id, number),
  unique (tenant_id, id),
  unique (requisition_id)
);
create table po_lines (
  tenant_id uuid not null references tenants(id),
  po_id uuid not null,
  item_id uuid not null,
  qty int not null check (qty > 0),
  unit_cost_minor bigint not null check (unit_cost_minor >= 0),
  received_qty int not null default 0,
  primary key (po_id, item_id),
  check (received_qty between 0 and qty),
  foreign key (tenant_id, po_id) references purchase_orders(tenant_id, id),
  foreign key (tenant_id, item_id) references inventory_items(tenant_id, id)
);
create table assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  tag text not null,
  name text not null,
  assigned_to text,
  status text not null default 'in_use' check (status in ('in_use','in_store','maintenance','disposed')),
  purchase_cost_minor bigint,
  warranty_expiry date,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (tenant_id, tag)
);
do $$
declare t text;
begin
  foreach t in array array['books','book_copies','loans','reservations','suppliers','inventory_items','stock_movements','purchase_requisitions','requisition_lines','purchase_orders','po_lines','assets']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger stock_movements_immutable before update or delete on stock_movements for each row execute function audit_log_immutable();
