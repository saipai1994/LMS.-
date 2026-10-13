import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Shell } from '@/components/shell';

export const metadata: Metadata = { title: 'Greenwood ERP + LMS', description: 'K-12 school ERP and learning platform (demo build)' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
