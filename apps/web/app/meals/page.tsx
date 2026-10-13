'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Alert, Async, Button, Card, Select, Stat, Table, useAction } from '@/components/ui';
import { useEffect } from 'react';

export default function Meals() {
  const s = useSession();
  const today = new Date().toISOString().slice(0, 10);
  const [meal, setMeal] = useState('lunch');
  const menus = useAsync(() => api<any[]>('/meals/menus'));
  const hc = useAsync(() => (s.can('meals.read') ? api<any>(`/meals/headcount?date=${today}&meal=${meal}`) : Promise.resolve(null)), [meal]);
  return <><h1>Meals & nutrition</h1><p className="sub">Menus with allergen tags. Kitchen staff see dietary flags only — never the medical record behind them.</p>
    <Card title="This week’s menu"><Async q={menus} what="menus" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'menu_date', label: 'Date', render: (r) => fmtDate(r.menu_date) }, { key: 'meal', label: 'Meal' }, { key: 'items', label: 'Menu' }, { key: 'allergen_tags', label: 'Contains', render: (r) => (r.allergen_tags.length ? r.allergen_tags.join(', ') : '—') }, { key: 'nutrition_note', label: 'Nutrition' }]} rows={d} />}</Async></Card>
    {s.can('meals.read') && <Card title={`Today’s headcount — ${meal}`} action={<Select label="Meal" value={meal} onChange={(e) => setMeal(e.target.value)} options={['breakfast', 'lunch', 'snack', 'dinner'].map((v) => ({ value: v, label: v }))} />}>
      <Async q={hc} what="headcount">{(d) => d && <>
        <div className="grid g4"><Stat label="Expected (boarders on campus)" value={d.expected} /><Stat label="Served" value={d.served} tone="good" /><Stat label="Dietary alerts" value={d.allergenAlerts.length} tone={d.allergenAlerts.length ? 'bad' : 'good'} /></div>
        {d.menu ? <p>Menu: {d.menu.items} · contains: {d.menu.allergenTags.join(', ') || 'no listed allergens'}</p> : <Alert kind="info">No menu is set for this meal today.</Alert>}
        {d.allergenAlerts.length > 0 && <><h3>Do not serve the standard dish to:</h3><Table cols={[{ key: 'admissionNo', label: 'Adm. no.' }, { key: 'name', label: 'Student' }, { key: 'conflicts', label: 'Conflict', render: (r) => r.conflicts.join(', ') }]} rows={d.allergenAlerts} /></>}
        {s.can('meals.manage') && <Serve d={d} date={today} meal={meal} onDone={hc.reload} />}</>}</Async></Card>}</>;
}

function Serve({ d, date, meal, onDone }: { d: any; date: string; meal: string; onDone: () => void }) {
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const act = useAction();
  const [warn, setWarn] = useState<string | null>(null);
  useEffect(() => setPicked({}), [meal]);
  const pending = d.students.filter((x: any) => !x.served);
  return <><h3>Record meal attendance</h3>{act.node}{warn && <Alert kind="error">{warn}</Alert>}
    <Table cols={[{ key: 'admissionNo', label: 'Adm. no.' }, { key: 'name', label: 'Student' }, { key: 'flags', label: 'Dietary flags', render: (r) => (r.flags.length ? r.flags.join(', ') : '—') },
      { key: 'p', label: 'Served', render: (r) => (r.served ? '✔' : <input type="checkbox" aria-label={`Served ${r.name}`} checked={!!picked[r.id]} onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked })} />) }]} rows={d.students.slice(0, 60)} />
    <div style={{ marginTop: '.75rem' }}><Button disabled={!Object.values(picked).some(Boolean)} busy={act.busy} onClick={async () => { const ids = Object.keys(picked).filter((k) => picked[k]); let r: any; if (await act.run(async () => { r = await api('/meals/attendance', { body: { date, meal, studentIds: ids } }); }, 'Meal attendance saved.')) { setWarn(r.dietaryConflictsServed.length ? `${r.dietaryConflictsServed.length} student(s) with a dietary conflict were marked served — check immediately.` : null); setPicked({}); onDone(); } }}>Save ({pending.length} pending)</Button></div></>;
}
