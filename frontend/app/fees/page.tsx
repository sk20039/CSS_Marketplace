import type { Metadata } from 'next';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.cricketmarketusa.com';

export const metadata: Metadata = {
  title: 'Fees — Cricket Market',
  description:
    'Understand Cricket Market fees. Buyers pay the listed price. Sellers pay 8% of the item price with a $2.00 minimum.',
  alternates: {
    canonical: `${APP_URL}/fees`,
  },
  openGraph: {
    title: 'Fees — Cricket Market',
    description:
      'Understand Cricket Market fees. Buyers pay the listed price. Sellers pay 8% of the item price with a $2.00 minimum.',
    url: `${APP_URL}/fees`,
    type: 'website',
  },
};

export default function FeesPage() {
  return (
    <div className="max-w-2xl mx-auto py-10">
      <h1 className="text-3xl font-extrabold text-gray-900 mb-2">Fees</h1>
      <p className="text-gray-500 text-sm mb-10">
        Simple, transparent pricing for buyers and sellers.
      </p>

      {/* Buyers */}
      <section className="mb-10">
        <h2 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
          Buyers
        </h2>
        <ul className="space-y-3 text-gray-700">
          <li className="flex items-start gap-2">
            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-brand-700 shrink-0" />
            Buyers pay the listed item price plus any applicable sales tax. Buyers are not charged
            a shipping fee.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-brand-700 shrink-0" />
            Applicable sales tax may be calculated and added at checkout based on your delivery
            address.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-brand-700 shrink-0" />
            Stripe payment processing fees are absorbed by Cricket Market and are not charged
            separately to buyers or sellers.
          </li>
        </ul>
      </section>

      {/* Sellers */}
      <section className="mb-10">
        <h2 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b border-gray-200">
          Sellers
        </h2>
        <ul className="space-y-3 text-gray-700">
          <li className="flex items-start gap-2">
            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-brand-700 shrink-0" />
            Sellers pay 8% of the item price, with a minimum fee of $2.00. The fee is deducted
            from the seller payout when funds are released.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-brand-700 shrink-0" />
            If a seller purchases a shipping label through Cricket Market, the label cost is also
            deducted from the seller payout. Sellers who use their own label pay their carrier
            directly.
          </li>
        </ul>
      </section>

      {/* Example */}
      <section className="bg-gray-50 border border-gray-200 rounded-xl p-6 mb-10">
        <h2 className="text-lg font-bold text-gray-900 mb-4">Example — $100 sale</h2>
        <div className="divide-y divide-gray-200 text-sm">
          <div className="flex justify-between py-2.5">
            <span className="text-gray-600">Item price</span>
            <span className="font-medium text-gray-900">$100.00</span>
          </div>
          <div className="flex justify-between py-2.5">
            <span className="text-gray-600">Platform fee (8%)</span>
            <span className="font-medium text-gray-900">$8.00</span>
          </div>
          <div className="flex justify-between py-2.5">
            <span className="text-gray-600">Seller payout before shipping label cost</span>
            <span className="font-medium text-gray-900">$92.00</span>
          </div>
          <div className="flex justify-between py-2.5">
            <span className="text-gray-600">Buyer shipping fee</span>
            <span className="font-medium text-gray-900">$0.00</span>
          </div>
          <div className="flex justify-between py-2.5">
            <span className="text-gray-600">Applicable sales tax</span>
            <span className="font-medium text-gray-500 italic">May be added to buyer total</span>
          </div>
        </div>
      </section>

      <p className="text-sm text-gray-500">
        Questions about fees?{' '}
        <a
          href="mailto:support@cricketmarketusa.com"
          className="text-brand-700 hover:underline"
        >
          Contact us
        </a>
        .
      </p>
    </div>
  );
}
