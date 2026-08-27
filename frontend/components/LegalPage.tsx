import type { ReactNode } from 'react';
import Link from 'next/link';

interface NavLink { href: string; label: string }

interface Props {
  title: string;
  updated: string;
  navLinks?: NavLink[];
  children: ReactNode;
}

export default function LegalPage({ title, updated, navLinks, children }: Props) {
  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-700 mb-2">Legal</p>
        <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight mb-1">{title}</h1>
        <p className="text-sm text-gray-400">Last updated: {updated}</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-8 items-start">
        {/* Sidebar nav — visible on large screens */}
        {navLinks && navLinks.length > 0 && (
          <nav className="hidden lg:block w-52 shrink-0 sticky top-8">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">On this page</p>
            <ul className="space-y-1">
              {navLinks.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    className="block text-sm text-gray-500 hover:text-brand-700 transition-colors py-0.5"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="mt-8 pt-6 border-t border-gray-100">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">Other policies</p>
              <ul className="space-y-1">
                {[
                  { href: '/legal/terms', label: 'Terms of Service' },
                  { href: '/legal/privacy', label: 'Privacy Policy' },
                  { href: '/legal/buyer-protection', label: 'Buyer Protection' },
                  { href: '/legal/refunds', label: 'Refunds & Cancellations' },
                  { href: '/legal/prohibited-items', label: 'Prohibited Items' },
                ].map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="block text-sm text-gray-500 hover:text-brand-700 transition-colors py-0.5">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        )}

        {/* Main content */}
        <div className="flex-1 bg-white rounded-2xl border border-gray-200 shadow-sm px-8 py-10 sm:px-12">
          {children}
        </div>
      </div>
    </div>
  );
}

// Shared prose typography helpers exported for use inside legal pages
export function H2({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-xl font-bold text-gray-900 mt-10 mb-3 first:mt-0 scroll-mt-6">
      {children}
    </h2>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="text-base font-semibold text-gray-800 mt-6 mb-2">{children}</h3>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-gray-600 leading-relaxed mb-4">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="list-disc pl-6 space-y-1.5 text-gray-600 mb-4">{children}</ul>;
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="leading-relaxed">{children}</li>;
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="bg-brand-50 border border-brand-100 rounded-xl px-5 py-4 mb-4 text-sm text-brand-800 leading-relaxed">
      {children}
    </div>
  );
}
