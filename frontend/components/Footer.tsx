import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-400 mt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-8 mb-10">
          {/* Brand */}
          <div className="sm:col-span-2 lg:col-span-1">
            <p className="text-xl font-extrabold text-white tracking-tight mb-3">
              Cricket<span className="text-brand-500">Market</span>
            </p>
            <p className="text-sm leading-relaxed">
              USA&apos;s trusted C2C marketplace for cricket equipment. Buy and sell with confidence — payments are protected until you confirm delivery.
            </p>
          </div>

          {/* Shop */}
          <div>
            <p className="text-white font-semibold text-sm mb-3">Shop</p>
            <ul className="space-y-2 text-sm">
              {[
                { href: '/listings?category=bat',     label: 'Cricket Bats' },
                { href: '/listings?category=helmet',  label: 'Helmets' },
                { href: '/listings?category=pads',    label: 'Batting Pads' },
                { href: '/listings?category=gloves',  label: 'Gloves' },
                { href: '/listings?category=kit-bag', label: 'Kit Bags' },
                { href: '/listings?category=other',   label: 'Accessories' },
              ].map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Account */}
          <div>
            <p className="text-white font-semibold text-sm mb-3">Account</p>
            <ul className="space-y-2 text-sm">
              {[
                { href: '/login',             label: 'Login' },
                { href: '/register',          label: 'Register' },
                { href: '/dashboard/buyer',   label: 'Buyer Dashboard' },
                { href: '/listings/new',      label: 'Sell Equipment' },
              ].map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <p className="text-white font-semibold text-sm mb-3">Legal</p>
            <ul className="space-y-2 text-sm">
              {[
                { href: '/legal/terms',            label: 'Terms of Service' },
                { href: '/legal/privacy',          label: 'Privacy Policy' },
                { href: '/legal/buyer-protection', label: 'Buyer Protection' },
                { href: '/legal/refunds',          label: 'Refunds & Cancellations' },
                { href: '/legal/prohibited-items', label: 'Prohibited Items' },
              ].map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Trust */}
          <div>
            <p className="text-white font-semibold text-sm mb-3">Why Cricket Market?</p>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <svg className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Secure payments
              </li>
              <li className="flex items-start gap-2">
                <svg className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Buyer protection & disputes
              </li>
              <li className="flex items-start gap-2">
                <svg className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Cricket-only community
              </li>
              <li className="flex items-start gap-2">
                <svg className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Low platform fee (8%)
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-800 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <p>&copy; {new Date().getFullYear()} Cricket Market &mdash; SNA2 LLC d/b/a Cricket Sport Shop. All rights reserved.</p>
          <div className="flex flex-wrap justify-center sm:justify-end gap-x-4 gap-y-1">
            <Link href="/legal/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/legal/buyer-protection" className="hover:text-white transition-colors">Buyer Protection</Link>
            <Link href="/legal/refunds" className="hover:text-white transition-colors">Refunds</Link>
            <Link href="/legal/prohibited-items" className="hover:text-white transition-colors">Prohibited Items</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
