'use client';
import { useState } from 'react';
import { api, money } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, Stat, StatusBadge, Table, useAction } from '@/components/ui';

export default function Inventory() {
  const s = useSession();
  const items = useAsync(() => api<any[]>('/inventory/items').catch(() => []));
  const low = useAsync(() => api<any[]>('/inventory/low-stock').catch(() => []));
  const reqs = useAsync(() => api<any[]>('/procurement/requisitions'));
  const orders = useAsync(() => api<any[]>('/procurement/orders').catch(() => []));
  const suppliers = useAsync(() => api<any[]>('/procurement/suppliers').catch(() => []));
  const act = useAction();
  const refresh = () => { items.reload(); low.reload(); reqs.reload(); orders.reload(); };
  const [supplierId, setSupplierId] = useState('');
  return <><h1>Inventory & procurement</h1><p className="sub">Stock levels, requisitions with approval, purchase orders and goods receipt.</p>
    <Async q={low} what="stock">{(d) => <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="Items tracked" value={items.data?.length ?? '—'} /><Stat label="Below reorder level" value={d.length} tone={d.length ? 'bad' : 'good'} /></div>}</Async>
    {low.data && low.data.length > 0 && <Card title="Low stock"><Table cols={[{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'on_hand', label: 'On hand' }, { key: 'reorder_level', label: 'Reorder at' }]} rows={low.data} /></Card>}
    <Card title="Requisitions">{act.node}<Async q={reqs} what="requisitions" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'number', label: 'No.' }, { key: 'justification', label: 'Purpose' }, { key: 'est_total_minor', label: 'Estimate', align: 'right', render: (r) => money(r.est_total_minor) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> },
      { key: 'a', label: '', render: (r) => <span className="row" style={{ gap: '.3rem' }}>
        {s.can('inventory.approve') && r.status === 'submitted' && <><Button small onClick={async () => { if (await act.run(() => api(`/procurement/requisitions/${r.id}/decision`, { body: { decision: 'approve' } }), 'Approved.')) refresh(); }}>Approve</Button><Button small variant="danger" onClick={async () => { if (await act.run(() => api(`/procurement/requisitions/${r.id}/decision`, { body: { decision: 'reject' } }), 'Rejected.')) refresh(); }}>Reject</Button></>}
        {s.can('inventory.manage') && r.status === 'approved' && supplierId && <Button small onClick={async () => { if (await act.run(() => api(`/procurement/requisitions/${r.id}/order`, { body: { supplierId } }), 'Purchase order created.')) refresh(); }}>Create PO</Button>}</span> }]} rows={d} />}</Async>
      {s.can('inventory.manage') && <Async q={suppliers} what="suppliers">{(d) => <Select label="Supplier for new purchase orders" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="Choose…" options={d.map((x) => ({ value: x.id, label: x.name }))} />}</Async>}</Card>
    {s.can('inventory.read') && <Card title="Purchase orders"><Async q={orders} what="orders" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'number', label: 'PO' }, { key: 'supplier', label: 'Supplier' }, { key: 'total_minor', label: 'Total', align: 'right', render: (r) => money(r.total_minor) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> },
      { key: 'a', label: '', render: (r) => (s.can('inventory.manage') && r.status !== 'received' ? <Button small variant="secondary" onClick={async () => { if (await act.run(() => api(`/procurement/orders/${r.id}/receive`, { body: { lines: r.lines.filter((l: any) => l.received < l.qty).map((l: any) => ({ itemId: l.itemId, qty: l.qty - l.received })) } }), 'Goods received into stock.')) refresh(); }}>Receive remaining</Button> : null) }]} rows={d} />}</Async></Card>}
    <Card title="Stock"><Async q={items} what="stock" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'category', label: 'Category' }, { key: 'location', label: 'Location' }, { key: 'on_hand', label: 'On hand', render: (r) => <span style={{ color: r.on_hand <= r.reorder_level && r.reorder_level > 0 ? 'var(--bad)' : undefined }}>{r.on_hand} {r.unit}</span> }]} rows={d.slice(0, 40)} />}</Async></Card>
    {s.can('inventory.request') && <NewRequisition items={items.data ?? []} onDone={refresh} />}</>;
}
function NewRequisition({ items, onDone }: { items: any[]; onDone: () => void }) {
  const [itemId, setItemId] = useState(''); const [qty, setQty] = useState('10'); const [cost, setCost] = useState('100'); const [why, setWhy] = useState('');
  const act = useAction();
  return <Card title="New requisition"><form onSubmit={async (e) => { e.preventDefault(); const it = items.find((x) => x.id === itemId); if (await act.run(() => api('/procurement/requisitions', { body: { campusId: it.campus_id, justification: why, lines: [{ itemId, qty: Number(qty), estUnitCostMinor: Math.round(Number(cost) * 100) }] } }), 'Requisition submitted for approval.')) { setWhy(''); onDone(); } }}>
    <div className="row"><Select label="Item" value={itemId} onChange={(e) => setItemId(e.target.value)} required placeholder="Choose…" options={items.map((x) => ({ value: x.id, label: `${x.sku} ${x.name}` }))} /><Input label="Quantity" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} required /><Input label="Est. unit cost (INR)" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} required /></div>
    <Input label="Justification" value={why} onChange={(e) => setWhy(e.target.value)} required minLength={5} /><Button type="submit" busy={act.busy}>Submit</Button>{act.node}</form></Card>;
}
