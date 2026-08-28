import type { Metadata } from 'next';
import LegalPage, { H2, H3, P, UL, LI, Note } from '@/components/LegalPage';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Terms of Service — Cricket Market',
  description: 'Terms governing use of the Cricket Market platform.',
};

const NAV = [
  { href: '#acceptance', label: 'Acceptance' },
  { href: '#platform-role', label: 'Platform Role' },
  { href: '#accounts', label: 'Accounts' },
  { href: '#sellers', label: 'Seller Obligations' },
  { href: '#buyers', label: 'Buyer Obligations' },
  { href: '#payments', label: 'Payments & Fees' },
  { href: '#content', label: 'User Content' },
  { href: '#suspension', label: 'Suspension' },
  { href: '#liability', label: 'Liability' },
  { href: '#governing-law', label: 'Governing Law' },
  { href: '#contact', label: 'Contact' },
];

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="August 27, 2026" navLinks={NAV}>
      <Note>
        This is a draft for attorney review. It does not constitute legal advice and is subject
        to revision before public launch.
      </Note>

      <H2 id="acceptance">1. Acceptance of Terms</H2>
      <P>
        By creating an account or using Cricket Market (the &ldquo;Platform&rdquo;), you agree to
        be bound by these Terms of Service (&ldquo;Terms&rdquo;). If you do not agree, do not use
        the Platform. These Terms constitute a binding agreement between you and {SITE.legalName},
        doing business as {SITE.dba}, operating Cricket Market (&ldquo;we,&rdquo; &ldquo;us,&rdquo;
        or &ldquo;Company&rdquo;), a Texas limited liability company located at {SITE.address}.
      </P>
      <P>
        We may update these Terms at any time. Continued use of the Platform after notice of
        changes constitutes acceptance of the revised Terms.
      </P>

      <H2 id="platform-role">2. Platform Role</H2>
      <P>
        Cricket Market is a peer-to-peer (&ldquo;C2C&rdquo;) marketplace that connects independent
        buyers and sellers of used and new cricket equipment. We are not a party to any transaction
        between users. We do not own, inspect, warehouse, or ship any items listed on the Platform.
      </P>
      <P>
        We provide an escrow payment service as a neutral third party to hold buyer funds until
        delivery is confirmed. This service does not make us a buyer, seller, agent, or guarantor
        of any transaction.
      </P>

      <H2 id="accounts">3. Accounts</H2>
      <H3>3.1 Eligibility</H3>
      <P>
        You must be at least 18 years old and legally capable of entering contracts under Texas
        law to create an account. By registering, you represent that this is the case.
      </P>
      <H3>3.2 Account Security</H3>
      <P>
        You are responsible for maintaining the confidentiality of your password and for all
        activity that occurs under your account. Notify us immediately at {SITE.email} if you
        suspect unauthorized access.
      </P>
      <H3>3.3 One Account Per Person</H3>
      <P>
        Each person may hold one buyer account and one seller account. Creating duplicate accounts
        to evade suspension or circumvent Platform policies is prohibited.
      </P>

      <H2 id="sellers">4. Seller Obligations</H2>
      <UL>
        <LI>List only items you legally own and have the right to sell.</LI>
        <LI>
          Provide accurate titles, descriptions, condition disclosures, and photographs. Materially
          misleading listings are grounds for immediate removal and account suspension.
        </LI>
        <LI>
          Ship items within 3 business days of payment capture and provide tracking information
          when available.
        </LI>
        <LI>
          List only cricket equipment permitted under the Prohibited Items Policy. See{' '}
          <a href="/legal/prohibited-items" className="text-brand-700 hover:underline">
            Prohibited Items Policy
          </a>
          .
        </LI>
        <LI>
          Connect a Stripe account to receive payouts. Funds are held in escrow until the buyer
          confirms delivery or the {SITE.deliveryWindowHours}-hour auto-release window expires.
        </LI>
        <LI>Do not solicit off-platform payment to avoid fees or dispute protections.</LI>
      </UL>
      <P>
        Sellers are solely responsible for determining and collecting any applicable sales tax,
        income tax, or other taxes on their transactions.
      </P>

      <H2 id="buyers">5. Buyer Obligations</H2>
      <UL>
        <LI>
          Complete payment promptly after placing an order. Orders not captured within a
          reasonable period may be cancelled.
        </LI>
        <LI>
          Inspect items upon receipt and confirm delivery or file a dispute within{' '}
          {SITE.deliveryWindowHours} hours of the seller marking the order delivered. Failure to
          act results in automatic fund release to the seller.
        </LI>
        <LI>File disputes only for legitimate reasons as defined in the Buyer Protection Policy.</LI>
        <LI>Do not file false, fraudulent, or retaliatory disputes.</LI>
      </UL>

      <H2 id="payments">6. Payments &amp; Fees</H2>
      <H3>6.1 Escrow Model</H3>
      <P>
        Payments are processed by Stripe. When a buyer completes checkout, funds are authorized
        on the buyer&rsquo;s card and held until delivery is confirmed. We use Stripe Connect to
        transfer seller proceeds to the seller&rsquo;s linked Stripe account upon release.
      </P>
      <H3>6.2 Platform Fee</H3>
      <P>
        We retain a platform fee of {SITE.platformFeePct} of the transaction amount. This fee is
        deducted from the amount transferred to the seller. For pre-shipment cancellations, the
        platform fee is non-refundable regardless of the reason for cancellation. In the event of
        a dispute resolved in the buyer&rsquo;s favor, the full transaction amount &mdash;
        including the platform fee &mdash; is refunded to the buyer, and the platform collects no
        fee from that transaction.
      </P>
      <H3>6.3 Refunds</H3>
      <P>
        Refunds are governed by the{' '}
        <a href="/legal/refunds" className="text-brand-700 hover:underline">
          Refund and Cancellation Policy
        </a>
        . Stripe&rsquo;s processing timeline typically results in funds appearing on the
        buyer&rsquo;s statement within 5&ndash;10 business days.
      </P>
      <H3>6.4 Stripe Terms</H3>
      <P>
        By using the Platform, you also agree to Stripe&rsquo;s{' '}
        <a
          href="https://stripe.com/legal/ssa"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-700 hover:underline"
        >
          Services Agreement
        </a>{' '}
        and, for sellers connecting a Stripe account, Stripe&rsquo;s{' '}
        <a
          href="https://stripe.com/legal/connect-account"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-700 hover:underline"
        >
          Connected Account Agreement
        </a>
        .
      </P>

      <H2 id="content">7. User Content</H2>
      <P>
        By posting listing photos, descriptions, or messages on the Platform, you grant us a
        non-exclusive, royalty-free, worldwide license to display, reproduce, and distribute that
        content solely for the purpose of operating the Platform. You represent that you own or
        have the right to use all content you submit and that it does not infringe any third-party
        rights.
      </P>
      <P>
        We may remove any content that violates these Terms or that we deem inappropriate in our
        sole discretion without prior notice.
      </P>

      <H2 id="suspension">8. Account Suspension &amp; Termination</H2>
      <P>We may suspend or terminate any account, with or without notice, for reasons including:</P>
      <UL>
        <LI>Violation of these Terms or any Platform policy.</LI>
        <LI>Fraudulent, misleading, or harmful conduct.</LI>
        <LI>Repeated or severe policy violations.</LI>
        <LI>Requests from law enforcement or regulatory authorities.</LI>
      </UL>
      <P>
        Upon termination, any pending transactions will be completed or refunded at our
        discretion. You may not create a new account after suspension without our written
        permission.
      </P>

      <H2 id="liability">9. Disclaimers &amp; Limitation of Liability</H2>
      <H3>9.1 As-Is Platform</H3>
      <P>
        THE PLATFORM IS PROVIDED &ldquo;AS IS&rdquo; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR
        NON-INFRINGEMENT.
      </P>
      <H3>9.2 Transaction Disclaimer</H3>
      <P>
        WE ARE NOT RESPONSIBLE FOR THE QUALITY, SAFETY, LEGALITY, OR DELIVERY OF ITEMS LISTED
        BY SELLERS. ALL TRANSACTIONS ARE BETWEEN BUYERS AND SELLERS.
      </P>
      <H3>9.3 Liability Cap</H3>
      <P>
        TO THE MAXIMUM EXTENT PERMITTED BY TEXAS LAW, OUR TOTAL LIABILITY TO YOU FOR ANY CLAIM
        ARISING OUT OF THESE TERMS OR YOUR USE OF THE PLATFORM SHALL NOT EXCEED THE GREATER OF
        (A) THE PLATFORM FEES WE COLLECTED FROM YOUR TRANSACTIONS IN THE 12 MONTHS PRECEDING THE
        CLAIM, OR (B) ONE HUNDRED DOLLARS ($100).
      </P>
      <P>
        WE SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
        DAMAGES, EVEN IF ADVISED OF THEIR POSSIBILITY.
      </P>

      <H2 id="governing-law">10. Governing Law &amp; Dispute Resolution</H2>
      <P>
        These Terms are governed by the laws of the State of Texas, without regard to conflict of
        law principles. Any dispute not resolved informally shall be brought exclusively in the
        state or federal courts located in Harris County, Texas. You consent to personal
        jurisdiction in those courts.
      </P>
      <P>
        Before filing any legal action, you agree to contact us at {SITE.email} and attempt
        good-faith resolution for at least 30 days.
      </P>

      <H2 id="contact">11. Contact</H2>
      <P>
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
