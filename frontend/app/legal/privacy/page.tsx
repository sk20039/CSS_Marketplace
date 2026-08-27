import type { Metadata } from 'next';
import LegalPage, { H2, H3, P, UL, LI, Note } from '@/components/LegalPage';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Privacy Policy — Cricket Market',
  description: 'How Cricket Market collects, uses, and protects your personal information.',
};

const NAV = [
  { href: '#information-we-collect', label: 'Information We Collect' },
  { href: '#how-we-use', label: 'How We Use It' },
  { href: '#sharing', label: 'Sharing' },
  { href: '#stripe', label: 'Stripe & Payments' },
  { href: '#cookies', label: 'Cookies & Tokens' },
  { href: '#retention', label: 'Data Retention' },
  { href: '#your-rights', label: 'Your Rights' },
  { href: '#security', label: 'Security' },
  { href: '#changes', label: 'Policy Changes' },
  { href: '#contact', label: 'Contact' },
];

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="August 27, 2026" navLinks={NAV}>
      <Note>
        This is a draft for attorney review. It does not constitute legal advice and is subject
        to revision before public launch.
      </Note>

      <P>
        This Privacy Policy explains how {SITE.legalName}, doing business as {SITE.dba},
        operating Cricket Market (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;Company&rdquo;),
        collects, uses, and protects information about you when you use our Platform at{' '}
        <a href={SITE.url} className="text-brand-700 hover:underline">
          {SITE.url}
        </a>
        .
      </P>

      <H2 id="information-we-collect">1. Information We Collect</H2>
      <H3>1.1 Information You Provide</H3>
      <UL>
        <LI>
          <strong>Account registration:</strong> Name, email address, and role (buyer or seller).
        </LI>
        <LI>
          <strong>Listings:</strong> Item title, description, category, condition, price, and
          photos you upload.
        </LI>
        <LI>
          <strong>Messages:</strong> In-platform messages between buyers and sellers related to
          orders.
        </LI>
        <LI>
          <strong>Dispute filings:</strong> Reason text you submit when filing a dispute.
        </LI>
        <LI>
          <strong>Reviews:</strong> Star ratings and optional review text you leave after a
          completed order.
        </LI>
      </UL>
      <H3>1.2 Information Collected Automatically</H3>
      <UL>
        <LI>
          <strong>Order data:</strong> Transaction amounts, order status history, timestamps, and
          Stripe payment identifiers (charge ID, transfer ID).
        </LI>
        <LI>
          <strong>Log data:</strong> Server request logs including IP address, browser type, and
          pages visited, retained for security and debugging.
        </LI>
      </UL>
      <H3>1.3 Payment Information</H3>
      <P>
        We do not store your full card number, CVV, or bank account details. All payment card
        data is handled directly by Stripe, Inc., which is PCI-DSS compliant. We receive only
        tokenized references (payment intent IDs, charge IDs) from Stripe.
      </P>

      <H2 id="how-we-use">2. How We Use Your Information</H2>
      <UL>
        <LI>To create and manage your account and authenticate your sessions.</LI>
        <LI>To process transactions, hold funds in escrow, and release payments to sellers.</LI>
        <LI>To display listings to other users and power search.</LI>
        <LI>To facilitate messaging between buyers and sellers within orders.</LI>
        <LI>To send transactional emails (order updates, dispute notifications, verification links).</LI>
        <LI>To detect fraud, enforce Platform policies, and comply with legal obligations.</LI>
        <LI>To improve the Platform through aggregate, anonymized analytics.</LI>
      </UL>
      <P>
        We do not sell your personal information to third parties. We do not use your data for
        targeted advertising on third-party platforms.
      </P>

      <H2 id="sharing">3. Information Sharing</H2>
      <H3>3.1 Between Users</H3>
      <P>
        When you buy or sell, your name and order status are visible to the other party.
        Seller reviews are publicly visible on seller profiles. Your email address is never
        shared with other users.
      </P>
      <H3>3.2 Service Providers</H3>
      <P>We share data with the following third-party service providers:</P>
      <UL>
        <LI>
          <strong>Stripe, Inc.</strong> &mdash; payment processing and seller payout. Stripe
          receives transaction amounts, buyer card data, and seller banking details for connected
          accounts.
        </LI>
        <LI>
          <strong>Railway Technologies, Inc.</strong> &mdash; cloud hosting and database
          infrastructure. All backend services and databases run on Railway&rsquo;s platform.
        </LI>
        <LI>
          <strong>Vercel, Inc.</strong> &mdash; frontend hosting and content delivery.
        </LI>
      </UL>
      <H3>3.3 Legal Requirements</H3>
      <P>
        We may disclose your information if required by law, court order, or government
        authority, or when we believe disclosure is necessary to protect the rights, property,
        or safety of the Company, our users, or the public.
      </P>
      <H3>3.4 Business Transfer</H3>
      <P>
        If we are involved in a merger, acquisition, or sale of assets, your information may be
        transferred as part of that transaction. We will notify you via email before your
        information becomes subject to a different privacy policy.
      </P>

      <H2 id="stripe">4. Stripe &amp; Payment Data</H2>
      <P>
        For sellers, connecting a Stripe account requires you to provide Stripe with personal
        and banking information directly on Stripe&rsquo;s hosted onboarding pages. We never
        see or store that information; it is governed by{' '}
        <a
          href="https://stripe.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-700 hover:underline"
        >
          Stripe&rsquo;s Privacy Policy
        </a>
        . We store only your Stripe connected account identifier to route payouts.
      </P>

      <H2 id="cookies">5. Cookies &amp; Session Tokens</H2>
      <P>We use a minimal number of cookies and tokens:</P>
      <UL>
        <LI>
          <strong>Refresh token cookie</strong> &mdash; an HTTP-only cookie used to refresh your
          login session without re-entering your password. It expires after 7 days.
        </LI>
        <LI>
          <strong>Access token</strong> &mdash; a short-lived JWT stored in memory (not in
          localStorage or a persistent cookie) used to authenticate API requests. It expires
          after 15 minutes.
        </LI>
      </UL>
      <P>
        We do not use advertising cookies, analytics cookies, or third-party tracking pixels.
      </P>

      <H2 id="retention">6. Data Retention</H2>
      <P>
        We retain your account information and order history for as long as your account is
        active and for a minimum of 5 years thereafter to comply with financial record-keeping
        obligations. You may request deletion of your account; however, we may retain
        transaction records required by law or for dispute resolution.
      </P>

      <H2 id="your-rights">7. Your Rights</H2>
      <P>You have the right to:</P>
      <UL>
        <LI>Access the personal information we hold about you.</LI>
        <LI>Correct inaccurate information.</LI>
        <LI>Request deletion of your account (subject to legal retention requirements).</LI>
        <LI>
          Opt out of non-transactional communications. Note: we cannot opt you out of
          transactional emails (order updates, dispute notices) while your account is active.
        </LI>
      </UL>
      <P>
        To exercise these rights, email us at{' '}
        <a href={`mailto:${SITE.email}`} className="text-brand-700 hover:underline">
          {SITE.email}
        </a>{' '}
        with the subject line &ldquo;Privacy Request.&rdquo; We will respond within 30 days.
      </P>
      <P>
        Texas residents may have additional rights under the Texas Data Privacy and Security Act
        (TDPSA). Contact us at {SITE.email} to submit a request under the TDPSA.
      </P>

      <H2 id="security">8. Security</H2>
      <P>
        We implement technical safeguards including HTTPS encryption in transit, HTTP-only and
        Secure-flagged session cookies, JWT-based authentication with short-lived access tokens,
        and database access restricted to private network infrastructure. No system is completely
        secure; we cannot guarantee absolute security of your data.
      </P>

      <H2 id="changes">9. Changes to This Policy</H2>
      <P>
        We will post any material changes to this Privacy Policy on this page and update the
        &ldquo;Last updated&rdquo; date above. If changes are significant, we will notify
        registered users by email at least 14 days before they take effect.
      </P>

      <H2 id="contact">10. Contact</H2>
      <P>
        For privacy questions or requests:
        <br />
        {SITE.legalName} d/b/a {SITE.dba}
        <br />
        {SITE.address}
        <br />
        <a href={`mailto:${SITE.email}`} className="text-brand-700 hover:underline">
          {SITE.email}
        </a>
      </P>
    </LegalPage>
  );
}
