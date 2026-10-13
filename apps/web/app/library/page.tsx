'use client';
import { useState } from 'react';
import { api, fmtDate, money } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, Table, useAction } from '@/components/ui';

export default function Library() {
  const s = useSession();
  const [q, setQ] = useState('');
  const books = useAsync(() => api<any[]>(`/library/books${q ? `?q=${encodeURIComponent(q)}` : ''}`), [q]);
  return <><h1>Library</h1><p className="sub">Search the catalogue; librarians manage circulation.</p>
    <Card title="Catalogue"><Input label="Search title, author or ISBN" value={q} onChange={(e) => setQ(e.target.value)} />
      <Async q={books} what="catalogue" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Title' }, { key: 'author', label: 'Author' }, { key: 'category', label: 'Category' }, { key: 'kind', label: 'Format' }, { key: 'available', label: 'Available', render: (r) => (r.kind === 'digital' ? <a href={r.url} rel="noreferrer" target="_blank">Open</a> : `${r.available}/${r.copies}`) }]} rows={d.slice(0, 40)} />}</Async></Card>
    {s.can('library.manage') && <Desk />}</>;
}
function Desk() {
  const od = useAsync(() => api<any[]>('/library/overdue'));
  const students = useAsync(() => api<any[]>('/students?limit=200'));
  const [barcode, setBarcode] = useState(''); const [studentId, setStudentId] = useState(''); const [ret, setRet] = useState('');
  const act = useAction();
  return <>
    <div className="grid g2">
      <Card title="Issue a book"><form onSubmit={async (e) => { e.preventDefault(); if (await act.run(async () => { const r = await api<any>('/library/issue', { body: { barcode, studentId } }); setBarcode(''); void r; }, 'Book issued.')) od.reload(); }}>
        <Input label="Copy barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} required placeholder="e.g. GW-0005-1" />
        <Async q={students} what="students">{(d) => <Select label="Student" value={studentId} onChange={(e) => setStudentId(e.target.value)} required placeholder="Choose…" options={d.map((x) => ({ value: x.id, label: `${x.admission_no} ${x.first_name} ${x.last_name}` }))} />}</Async>
        <Button type="submit" busy={act.busy}>Issue</Button></form></Card>
      <Card title="Return a book"><form onSubmit={async (e) => { e.preventDefault(); let r: any; if (await act.run(async () => { r = await api('/library/return', { body: { barcode: ret } }); setRet(''); }, 'Book returned.')) { void r; od.reload(); } }}>
        <Input label="Copy barcode" value={ret} onChange={(e) => setRet(e.target.value)} required /><Button type="submit" busy={act.busy}>Return</Button></form></Card>
    </div>{act.node}
    <Card title="Overdue loans"><Async q={od} what="overdue loans" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Title' }, { key: 'n', label: 'Borrower', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'due_on', label: 'Due', render: (r) => fmtDate(r.due_on) }, { key: 'days_overdue', label: 'Days late' }, { key: 'fine_so_far_minor', label: 'Fine so far', align: 'right', render: (r) => money(r.fine_so_far_minor) }]} rows={d} />}</Async></Card></>;
}
