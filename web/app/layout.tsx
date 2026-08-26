import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'FluxA Flight Desk',
  description: 'A conversational agent that searches, prices, and manages flight bookings.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
