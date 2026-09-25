import type { Metadata } from 'next';
import Link from 'next/link';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.cricketmarketusa.com';

export const metadata: Metadata = {
  title: 'About — Cricket Market',
  description:
    'Cricket Market was created to give cricketers in the United States a dedicated place to buy and sell cricket equipment.',
  alternates: {
    canonical: `${APP_URL}/about`,
  },
  openGraph: {
    title: 'About — Cricket Market',
    description:
      'Cricket Market was created to give cricketers in the United States a dedicated place to buy and sell cricket equipment.',
    url: `${APP_URL}/about`,
    type: 'website',
  },
};

export default function AboutPage() {
  return (
    <div className="max-w-2xl mx-auto py-10">
      <h1 className="text-3xl font-extrabold text-gray-900 mb-8">About Cricket Market</h1>

      <div className="prose prose-gray max-w-none space-y-5 text-gray-700 leading-relaxed">
        <p>
          Cricket equipment can be expensive, and finding good used gear in the United States often
          means relying on personal contacts, cricket groups, or general marketplaces.
        </p>

        <p>
          Cricket Market was created to give cricketers a dedicated place to buy and sell cricket
          equipment.
        </p>

        <p>
          Buyer payments are held during the protection period and released according to our{' '}
          <Link href="/legal/buyer-protection" className="text-brand-700 hover:underline">
            Buyer Protection terms
          </Link>
          . Sellers can reach cricket players across the United States without listing their
          equipment on a general marketplace.
        </p>

        <p>
          We are starting small and building carefully around the needs of cricket players, clubs,
          and families.
        </p>

        <p>
          Questions? Contact us at{' '}
          <a href="mailto:support@cricketmarketusa.com" className="text-brand-700 hover:underline">
            support@cricketmarketusa.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
