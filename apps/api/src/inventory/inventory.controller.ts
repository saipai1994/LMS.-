import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';

const itemS = z.object({ campusId: uuid, sku: z.string().min(2).max(40), name: z.string().min(2).max(200), category: z.string().min(2).max(60), unit: z.string().max(20).default('pcs'), reorderLevel: z.number().int().min(0).default(0), location: z.string().max(100).optional() });
const supplierS = z.object({ name: z.string().min(2).max(200), contact: z.string().max(200).optional() });
const reqS = z.object({ campusId: uuid, justification: z.string().min(5).max(500), lines: z.array(z.object({ itemId: uuid, qty: z.number().int().positive().max(100000), estUnitCostMinor: z.number().int().min(0) })).min(1).max(50) });
const poS = z.object({ supplierId: uuid, unitCosts: z.record(uuid, z.number().int().min(0)).optional() });
const recvS = z.object({ lines: z.array(z.object({ itemId: uuid, qty: z.number().int().positive() })).min(1) });
const issueS = z.object({ itemId: uuid, qty: z.number().int().positive(), issuedTo: z.string().min(2).max(200) });
const assetS = z.object({ campusId: uuid, tag: z.string().min(2).max(40), name: z.string().min(2).max(200), assignedTo: z.string().max(200).optional(), purchaseCostMinor: z.number().int().min(0).optional(), warrantyExpiry: z.string().date().optional() });

const STOCK_SQL = `select i.id, i.sku, i.name, i.category, i.unit, i.reorder_level, i.location, i.campus_id, coalesce((select sum(qty_delta) from stock_movements m where m.item_id = i.id), 0)::int as on_hand from inventory_items i`;

@Controller()
export class InventoryController {
  constructor(private db: DbService) {}

  @Post('inventory/items')
  addItem(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(itemS, body); needs(a, 'inventory.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into inventory_items(tenant_id, campus_id, sku, name, category, unit, reorder_level, location) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *', [a.tenantId, b.campusId, b.sku, b.name, b.category, b.unit, b.reorderLevel, b.location ?? null])).rows[0]);
  }
  @Get('inventory/items')
  items(@Auth() a: AuthContext) {
    needs(a, 'inventory.read'); const scope = campusScope(a, 'inventory.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select * from (${STOCK_SQL}) s where ($1::uuid[] is null or s.campus_id = any($1)) order by name`, [scope])).rows);
  }
  @Get('inventory/low-stock')
  low(@Auth() a: AuthContext) {
    needs(a, 'inventory.read'); const scope = campusScope(a, 'inventory.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select * from (${STOCK_SQL}) s where on_hand <= reorder_level and reorder_level > 0 and ($1::uuid[] is null or s.campus_id = any($1)) order by name`, [scope])).rows);
  }
  @Post('inventory/issue')
  issue(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(issueS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const it = await this.item(tx, a, b.itemId, 'inventory.manage');
      await tx.query('select id from inventory_items where id = $1 for update', [b.itemId]);   // serialize stock changes per item
      const onHand = (await tx.query('select coalesce(sum(qty_delta),0)::int n from stock_movements where item_id = $1', [b.itemId])).rows[0].n;
      if (b.qty > onHand) throw new ConflictException({ error: 'insufficient_stock', onHand });
      await tx.query(`insert into stock_movements(tenant_id, item_id, qty_delta, kind, ref, by_user) values ($1,$2,$3,'issue',$4,$5)`, [a.tenantId, b.itemId, -b.qty, `to ${b.issuedTo}`, a.userId]);
      await audit(tx, a, a.tenantId, 'inventory.issue', 'item', b.itemId, it.campus_id, { qty: b.qty, issuedTo: b.issuedTo });
      return { onHand: onHand - b.qty, belowReorderLevel: onHand - b.qty <= it.reorder_level };
    });
  }
  @Post('inventory/items/:id/adjust')
  adjust(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ qtyDelta: z.number().int().refine((n) => n !== 0), reason: z.string().min(3).max(200) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const it = await this.item(tx, a, id, 'inventory.approve');
      await tx.query('select id from inventory_items where id = $1 for update', [id]);
      const onHand = (await tx.query('select coalesce(sum(qty_delta),0)::int n from stock_movements where item_id = $1', [id])).rows[0].n;
      if (onHand + b.qtyDelta < 0) throw new ConflictException({ error: 'would_go_negative', onHand });
      await tx.query(`insert into stock_movements(tenant_id, item_id, qty_delta, kind, note, by_user) values ($1,$2,$3,'adjustment',$4,$5)`, [a.tenantId, id, b.qtyDelta, b.reason, a.userId]);
      await audit(tx, a, a.tenantId, 'inventory.adjust', 'item', id, it.campus_id, { qtyDelta: b.qtyDelta, reason: b.reason });
      return { onHand: onHand + b.qtyDelta };
    });
  }

  @Post('procurement/suppliers')
  addSupplier(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'inventory.manage'); const b = parse(supplierS, body);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into suppliers(tenant_id, name, contact) values ($1,$2,$3) returning *', [a.tenantId, b.name, b.contact ?? null])).rows[0]);
  }
  @Get('procurement/suppliers')
  suppliers(@Auth() a: AuthContext) {
    needs(a, 'inventory.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select * from suppliers order by name')).rows);
  }

  @Post('procurement/requisitions')
  requisition(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(reqS, body); needs(a, 'inventory.request', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const items = (await tx.query('select id from inventory_items where id = any($1) and campus_id = $2', [b.lines.map((l) => l.itemId), b.campusId])).rowCount;
      if (items !== new Set(b.lines.map((l) => l.itemId)).size) throw new UnprocessableEntityException({ error: 'unknown_item' });
      const number = await this.next(tx, a.tenantId, 'requisition', 'PR-');
      const r = (await tx.query('insert into purchase_requisitions(tenant_id, campus_id, number, requested_by, justification) values ($1,$2,$3,$4,$5) returning id, number, status', [a.tenantId, b.campusId, number, a.userId, b.justification])).rows[0];
      for (const l of b.lines) await tx.query('insert into requisition_lines(tenant_id, requisition_id, item_id, qty, est_unit_cost_minor) values ($1,$2,$3,$4,$5)', [a.tenantId, r.id, l.itemId, l.qty, l.estUnitCostMinor]);
      await audit(tx, a, a.tenantId, 'procurement.requisition', 'requisition', r.id, b.campusId);
      return r;
    });
  }
  @Get('procurement/requisitions')
  reqs(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select r.id, r.number, r.status, r.justification, r.created_at, r.requested_by, r.campus_id,
         (select coalesce(sum(qty * est_unit_cost_minor),0)::bigint from requisition_lines l where l.requisition_id = r.id) as est_total_minor,
         (select json_agg(json_build_object('item', i.name, 'qty', l.qty)) from requisition_lines l join inventory_items i on i.id = l.item_id where l.requisition_id = r.id) as lines
       from purchase_requisitions r order by r.created_at desc`)).rows
      .filter((r) => r.requested_by === a.userId || can(a, 'inventory.read', r.campus_id) || can(a, 'inventory.approve', r.campus_id)).map((r) => ({ ...r, est_total_minor: Number(r.est_total_minor) })));
  }
  @Post('procurement/requisitions/:id/decision')
  decide(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select * from purchase_requisitions where id = $1 for update', [id]);
      if (!r || !can(a, 'inventory.approve', r.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (r.status !== 'submitted') throw new ConflictException({ error: 'already_decided', status: r.status });
      if (r.requested_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_request' });
      await tx.query('update purchase_requisitions set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      await audit(tx, a, a.tenantId, `procurement.requisition_${decision}`, 'requisition', id, r.campus_id);
      return { decision };
    });
  }
  @Post('procurement/requisitions/:id/order')
  order(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(poS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select * from purchase_requisitions where id = $1 for update', [id]);
      if (!r || !can(a, 'inventory.manage', r.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (r.status !== 'approved') throw new ConflictException({ error: 'not_approved', status: r.status });
      if (!(await tx.query('select 1 from suppliers where id = $1', [b.supplierId])).rowCount) throw new UnprocessableEntityException({ error: 'unknown_supplier' });
      const lines = (await tx.query('select * from requisition_lines where requisition_id = $1', [id])).rows;
      const cost = (l: any) => b.unitCosts?.[l.item_id] ?? Number(l.est_unit_cost_minor);
      const total = lines.reduce((t, l) => t + cost(l) * l.qty, 0);
      const number = await this.next(tx, a.tenantId, 'purchase_order', 'PO-');
      const po = (await tx.query('insert into purchase_orders(tenant_id, number, requisition_id, supplier_id, total_minor, created_by) values ($1,$2,$3,$4,$5,$6) returning id, number, total_minor', [a.tenantId, number, id, b.supplierId, total, a.userId])).rows[0];
      for (const l of lines) await tx.query('insert into po_lines(tenant_id, po_id, item_id, qty, unit_cost_minor) values ($1,$2,$3,$4,$5)', [a.tenantId, po.id, l.item_id, l.qty, cost(l)]);
      await tx.query(`update purchase_requisitions set status = 'ordered' where id = $1`, [id]);
      await audit(tx, a, a.tenantId, 'procurement.order', 'purchase_order', po.id, r.campus_id, { number, totalMinor: total });
      return { ...po, total_minor: Number(po.total_minor) };
    });
  }
  @Get('procurement/orders')
  orders(@Auth() a: AuthContext) {
    needs(a, 'inventory.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select po.id, po.number, po.status, po.total_minor, s.name as supplier, (select json_agg(json_build_object('itemId', l.item_id, 'item', i.name, 'qty', l.qty, 'received', l.received_qty)) from po_lines l join inventory_items i on i.id = l.item_id where l.po_id = po.id) as lines
       from purchase_orders po join suppliers s on s.id = po.supplier_id order by po.created_at desc`)).rows.map((r) => ({ ...r, total_minor: Number(r.total_minor) })));
  }
  /** Goods receipt: increases stock, cannot receive more than ordered. */
  @Post('procurement/orders/:id/receive')
  receive(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(recvS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [po] } = await tx.query('select po.*, r.campus_id from purchase_orders po join purchase_requisitions r on r.id = po.requisition_id where po.id = $1 for update of po', [id]);
      if (!po || !can(a, 'inventory.manage', po.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (po.status === 'received') throw new ConflictException({ error: 'already_received' });
      for (const l of b.lines) {
        const { rows: [pl] } = await tx.query('select * from po_lines where po_id = $1 and item_id = $2 for update', [id, l.itemId]);
        if (!pl) throw new UnprocessableEntityException({ error: 'item_not_on_order', itemId: l.itemId });
        if (pl.received_qty + l.qty > pl.qty) throw new UnprocessableEntityException({ error: 'over_receipt', ordered: pl.qty, alreadyReceived: pl.received_qty });
        await tx.query('update po_lines set received_qty = received_qty + $3 where po_id = $1 and item_id = $2', [id, l.itemId, l.qty]);
        await tx.query(`insert into stock_movements(tenant_id, item_id, qty_delta, kind, ref, by_user) values ($1,$2,$3,'receipt',$4,$5)`, [a.tenantId, l.itemId, l.qty, po.number, a.userId]);
      }
      const open = (await tx.query('select count(*)::int n from po_lines where po_id = $1 and received_qty < qty', [id])).rows[0].n;
      const status = open ? 'partially_received' : 'received';
      await tx.query('update purchase_orders set status = $2 where id = $1', [id, status]);
      await audit(tx, a, a.tenantId, 'procurement.receive', 'purchase_order', id, po.campus_id, { status });
      return { status };
    });
  }

  @Post('assets')
  addAsset(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(assetS, body); needs(a, 'inventory.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into assets(tenant_id, campus_id, tag, name, assigned_to, purchase_cost_minor, warranty_expiry) values ($1,$2,$3,$4,$5,$6,$7) returning id, tag', [a.tenantId, b.campusId, b.tag, b.name, b.assignedTo ?? null, b.purchaseCostMinor ?? null, b.warrantyExpiry ?? null])).rows[0]);
  }
  @Get('assets/warranty-alerts')
  warranty(@Auth() a: AuthContext) {
    needs(a, 'inventory.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select tag, name, assigned_to, warranty_expiry, (warranty_expiry < current_date) as expired from assets where warranty_expiry is not null and warranty_expiry <= current_date + 60 and status <> 'disposed' order by warranty_expiry`)).rows);
  }

  private async item(tx: Tx, a: AuthContext, id: string, perm: 'inventory.manage' | 'inventory.approve') {
    const { rows: [i] } = await tx.query('select * from inventory_items where id = $1', [id]);
    if (!i || !can(a, perm, i.campus_id)) throw new NotFoundException({ error: 'not_found' });
    return i;
  }
  private async next(tx: Tx, tenantId: string, key: string, prefix: string) {
    const { rows: [s] } = await tx.query(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,$2,$3,2) on conflict (tenant_id, key) do update set next_value = document_sequences.next_value + 1 returning prefix, next_value - 1 as v`, [tenantId, key, prefix]);
    return `${s.prefix}${String(s.v).padStart(5, '0')}`;
  }
}
