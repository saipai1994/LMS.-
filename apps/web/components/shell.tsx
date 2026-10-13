'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { SessionCtx, useSession, useSessionLoader } from '@/lib/hooks';
import { api } from '@/lib/api';
import { Loading } from './ui';

interface NavItem { href: string; label: string; show: (s: ReturnType<typeof useSession>) => boolean }
const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', show: () => true },
  { href: '/students', label: 'Students', show: (s) => s.can('student.read') },
  { href: '/admissions', label: 'Admissions', show: (s) => s.can('admissions.read') },
  { href: '/attendance', label: 'Attendance', show: (s) => s.can('attendance.manage') || s.hasRole('teacher') },
  { href: '/learning', label: 'Learning', show: (s) => s.hasRole('teacher', 'student', 'lms_admin') },
  { href: '/hostel', label: 'Hostel & leave', show: (s) => s.can('hostel.read') || s.can('gate.record') || s.hasRole('parent') },
  { href: '/dismissal', label: 'Dismissal', show: (s) => s.can('dismissal.record') },
  { href: '/finance', label: 'Fees & finance', show: (s) => s.can('finance.read') || s.hasRole('parent') },
  { href: '/grades', label: 'Result approvals', show: (s) => s.can('grades.approve') },
  { href: '/incidents', label: 'Incidents', show: (s) => s.can('incident.report') || s.can('incident.manage') },
  { href: '/notifications', label: 'Notifications', show: () => true },
];

export function Shell({ children }: { children: ReactNode }) {
  const session = useSessionLoader();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [demo, setDemo] = useState<string | null>(null);
  useEffect(() => { api<{ banner: string }>('/demo/info').then((d) => setDemo(d.banner)).catch(() => setDemo(null)); }, []);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => { if (!session.loading && !session.profile && path !== '/login') router.replace('/login'); }, [session.loading, session.profile, path, router]);

  const banner = demo ? <div className="demo-banner" role="note">{demo}</div> : null;
  if (path === '/login') return <SessionCtx.Provider value={session}>{banner}{children}</SessionCtx.Provider>;
  if (session.loading || !session.profile) return <SessionCtx.Provider value={session}>{banner}<main id="main"><Loading what="your workspace" /></main></SessionCtx.Provider>;

  return (
    <SessionCtx.Provider value={session}>
      {banner}
      <div className="shell">
        <aside className={`side ${open ? 'open' : ''}`} aria-label="Primary">
          <div className="brand">{session.profile.tenant?.name ?? 'School'}</div>
          <nav>{NAV.filter((n) => n.show(session)).map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href || (n.href !== '/' && path.startsWith(n.href)) ? 'page' : undefined}>{n.label}</Link>
          ))}</nav>
          <div className="user">
            <strong>{session.profile.fullName}</strong><br />{session.profile.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}<br />
            <button className="link" onClick={() => session.logout()}>Sign out</button>
          </div>
        </aside>
        <div>
          <button className="btn secondary sm menu-btn" aria-expanded={open} aria-controls="main" onClick={() => setOpen(!open)}>☰ Menu</button>
          <main id="main" tabIndex={-1}>{children}</main>
        </div>
      </div>
    </SessionCtx.Provider>
  );
}
