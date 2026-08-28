import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { QueryProvider } from '@/app/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Field Research Pipeline',
  description: 'Configurable research and data enrichment pipelines.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <Shell>{children}</Shell>
        </QueryProvider>
      </body>
    </html>
  );
}
