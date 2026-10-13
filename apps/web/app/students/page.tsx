'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Async, Card, Input, StatusBadge, Table } from '@/components/ui';

export default function Students() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const data = useAsync(() => api<any[]>(`/students?limit=25&offset=${page * 25}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q, page]);
  return <>
    <h1>Students</h1><p className="sub">Search by name or admission number.</p>
    <Card>
      <Input label="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="e.g. GIA-00008 or Sharma" />
      <Async q={data} what="students" empty={(d) => !d.length}>{(d) => <>
        <Table caption="Students" cols={[{ key: 'admission_no', label: 'Admission no.' }, { key: 'name', label: 'Name', render: (r) => <Link href={`/students/${r.id}`}>{r.first_name} {r.last_name}</Link> }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }]} rows={d} />
        <div className="row" style={{ marginTop: '.75rem' }}><button className="btn secondary sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><button className="btn secondary sm" disabled={d.length < 25} onClick={() => setPage(page + 1)}>Next</button></div>
      </>}</Async>
    </Card>
  </>;
}
