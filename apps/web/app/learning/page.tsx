'use client';
import { FormEvent, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, StatusBadge, Table, useAction, Select } from '@/components/ui';

export default function Learning() {
  const s = useSession();
  return <><h1>Learning</h1><p className="sub">{s.hasRole('teacher') ? 'Create homework, review submissions and grade.' : 'Your courses, lessons and homework.'}</p>
    {s.hasRole('teacher') ? <TeacherView /> : <StudentView />}</>;
}

function StudentView() {
  const courses = useAsync(() => api<any[]>('/me/courses'));
  const work = useAsync(() => api<any>('/me/learning'));
  const [courseId, setCourseId] = useState('');
  const [open, setOpen] = useState<any>(null);
  return <>
    <Card title="Homework"><Async q={work} what="homework" empty={(d) => !d.assignments.length}>{(d) => <Table cols={[{ key: 'course', label: 'Course' }, { key: 'title', label: 'Task' }, { key: 'due_at', label: 'Due', render: (r) => fmtDateTime(r.due_at) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.missing ? 'missing' : r.status} /> },
      { key: 'marks', label: 'Marks', render: (r) => (r.marks != null ? `${Number(r.marks)}/${Number(r.max_marks)}` : '—') }, { key: 'feedback', label: 'Feedback' },
      { key: 'a', label: '', render: (r) => (r.status !== 'graded' ? <Button small onClick={() => setOpen(r)}>{r.status === 'submitted' ? 'Resubmit' : 'Open'}</Button> : null) }]} rows={d.assignments} />}</Async></Card>
    {open && <Submit a={open} onDone={() => { setOpen(null); work.reload(); }} />}
    <Card title="Course lessons"><Async q={courses} what="courses" empty={(d) => !d.length}>{(d) => <><Select label="Course" value={courseId} onChange={(e) => setCourseId(e.target.value)} placeholder="Choose…" options={d.map((c) => ({ value: c.id, label: c.title }))} />{courseId && <Lessons id={courseId} />}</>}</Async></Card>
  </>;
}
function Lessons({ id }: { id: string }) {
  const q = useAsync(() => api<any[]>(`/courses/${id}/lessons`), [id]);
  const act = useAction();
  return <Async q={q} what="lessons" empty={(d) => !d.length}>{(d) => <ul className="timeline">{d.map((l) => <li key={l.id}><strong>{l.title}</strong> {l.completed && <StatusBadge s="graded" />}
    {l.locked ? <div className="sub">🔒 {l.reason === 'not_yet_released' ? `Opens ${fmtDate(l.release_at)}` : 'Finish the previous lesson first'}</div> : <><p>{l.body}</p>{!l.completed && <Button small variant="secondary" onClick={async () => { if (await act.run(() => api(`/lessons/${l.id}/complete`, { method: 'POST', body: {} }), 'Marked complete.')) q.reload(); }}>Mark complete</Button>}</>}</li>)}</ul>}</Async>;
}
function Submit({ a, onDone }: { a: any; onDone: () => void }) {
  const [text, setText] = useState('');
  const act = useAction();
  return <Card title={`${a.course}: ${a.title}`}><p>{a.instructions}</p><p className="sub">Due {fmtDateTime(a.due_at)}{!a.allow_late && ' — late work is not accepted'}</p>
    {a.feedback && <div className="alert info">Teacher feedback: {a.feedback}</div>}
    <form onSubmit={async (e: FormEvent) => { e.preventDefault(); if (await act.run(() => api(`/assignments/${a.id}/submission`, { method: 'PUT', body: { answerText: text, submit: true } }), 'Submitted.')) onDone(); }}>
      <div className="field"><label htmlFor="ans">Your answer</label><textarea id="ans" value={text} onChange={(e) => setText(e.target.value)} required /></div>
      <div className="row"><Button type="submit" busy={act.busy}>Submit</Button><Button variant="secondary" onClick={onDone}>Close</Button></div>{act.node}</form></Card>;
}

function TeacherView() {
  const courses = useAsync(() => api<any[]>('/me/courses').then((c) => c.filter((x) => x.teaching)));
  const [courseId, setCourseId] = useState('');
  return <><Card><Async q={courses} what="courses" empty={(d) => !d.length}>{(d) => <Select label="Course" value={courseId} onChange={(e) => setCourseId(e.target.value)} placeholder="Choose a course…" options={d.map((c) => ({ value: c.id, label: `${c.title} (${c.students} students)` }))} />}</Async></Card>
    {courseId && <Course id={courseId} key={courseId} />}</>;
}
function Course({ id }: { id: string }) {
  const asg = useAsync(() => api<any[]>(`/courses/${id}/assignments`), [id]);
  const gb = useAsync(() => api<any>(`/courses/${id}/gradebook`), [id]);
  const [sel, setSel] = useState<any>(null);
  const [f, setF] = useState<any>({ maxMarks: 20 });
  const act = useAction();
  return <>
    <Card title="Assignments"><Async q={asg} what="assignments" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Title' }, { key: 'due_at', label: 'Due', render: (r) => fmtDateTime(r.due_at) }, { key: 'max_marks', label: 'Max', render: (r) => Number(r.max_marks) }, { key: 'submitted', label: 'Submitted' }, { key: 'published', label: 'Status', render: (r) => <StatusBadge s={r.published ? 'active' : 'draft'} /> },
      { key: 'a', label: '', render: (r) => <span className="row" style={{ gap: '.3rem' }}><Button small variant="secondary" onClick={() => setSel(r)}>Submissions</Button>{!r.published && <Button small onClick={async () => { if (await act.run(() => api(`/assignments/${r.id}/publish`, { method: 'POST', body: {} }), 'Published; students and guardians notified.')) asg.reload(); }}>Publish</Button>}</span> }]} rows={d} />}</Async>{act.node}</Card>
    {sel && <Submissions a={sel} onChange={() => { asg.reload(); gb.reload(); }} />}
    <Card title="New assignment"><form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api(`/courses/${id}/assignments`, { body: { title: f.title, instructions: f.instructions ?? '', dueAt: new Date(f.due).toISOString(), maxMarks: Number(f.maxMarks), published: true } }), 'Assignment created and published.')) { setF({ maxMarks: 20 }); asg.reload(); } }}>
      <div className="row"><Input label="Title" value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} required /><Input label="Due" type="datetime-local" value={f.due ?? ''} onChange={(e) => setF({ ...f, due: e.target.value })} required /><Input label="Max marks" type="number" min={1} value={f.maxMarks} onChange={(e) => setF({ ...f, maxMarks: e.target.value })} required /></div>
      <Input label="Instructions" value={f.instructions ?? ''} onChange={(e) => setF({ ...f, instructions: e.target.value })} /><Button type="submit" busy={act.busy}>Create & publish</Button></form></Card>
    <Card title="Gradebook"><Async q={gb} what="gradebook">{(d) => <Table cols={[{ key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, ...d.assignments.map((a: any) => ({ key: a.id, label: a.title, render: (r: any) => { const w = r.work[a.id]; return w ? (w.marks != null ? `${Number(w.marks)}/${Number(a.max_marks)}` : w.status) : '—'; } }))]} rows={d.students} />}</Async></Card>
  </>;
}
function Submissions({ a, onChange }: { a: any; onChange: () => void }) {
  const q = useAsync(() => api<any[]>(`/assignments/${a.id}/submissions`), [a.id]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const act = useAction();
  return <Card title={`Submissions — ${a.title}`}><Async q={q} what="submissions" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status === 'not_submitted' ? 'missing' : r.status} /> }, { key: 'is_late', label: 'Late', render: (r) => (r.is_late ? 'Yes' : '') }, { key: 'answer_text', label: 'Answer' },
    { key: 'g', label: 'Grade', render: (r) => (r.submission_id && r.status !== 'draft' ? <span className="row" style={{ gap: '.3rem' }}><input aria-label={`Marks for ${r.first_name}`} style={{ width: 80 }} type="number" min={0} max={Number(a.max_marks)} defaultValue={r.marks ?? ''} onChange={(e) => setMarks({ ...marks, [r.submission_id]: e.target.value })} /><Button small onClick={async () => { if (await act.run(() => api(`/submissions/${r.submission_id}/grade`, { body: { marks: Number(marks[r.submission_id] ?? r.marks) } }), 'Graded; guardians notified.')) { q.reload(); onChange(); } }}>Save</Button></span> : null) }]} rows={d} />}</Async>{act.node}</Card>;
}
