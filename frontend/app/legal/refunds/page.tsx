import type { Metadata } from 'next';
import LegalPage, { H2, H3, P, UL, LI, Note } from '@/components/LegalPage';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Refund & Cancellation Policy — Cricket Market',
  description: 'When and how you can cancel orders or receive refunds on Cricket Market.',
};

const NAV = [
  { href: '#cancellations', label: 'Cancellations' },
  { href: '#platform-fee', label: 'Platform Fee on Cancel' },
  { href: '#post-shipment', label: 'Post-Shipment' },
  { href: '#dispute-refunds', label: 'Dispute-Based Refunds' },
  { href: '#processing', label: 'Refund Processing' },
  { href: '#non-refundable', label: 'Non-Refundable Situations' },
  { href: '#contact', label: 'Contact' },
];

export default function RefundsPage() {
  return (
    <LegalPage title="Refund & Cancellation Policy" updated="August 27, 2026" navLinks={NAV}>
      <Note>
        This is a draft for attorney review. It does not constitute legal advice and is subject
        to revision before public launch.
      </Note>

      <P>
        This policy describes when orders can be cancelled, when refunds are issued, and how
        they are processed. It should be read alongside the{' '}
        <a href="/legal/buyer-protection" className="text-brand-700 hover:underline">
          Buyer Protection &amp; Dispute Policy
        </a>
        .
      </P>

      <H2 id="cancellations">1. Pre-Shipment Cancellations</H2>
      <H3>1.1 Who Can Cancel</H3>
      <P>
        Only the buyer (or an admin) may cancel an order before it has been marked shipped by
        the seller. Sellers cannot unilaterally cancel a paid order; they should contact the
        buyer and request the buyer initiate cancellation, or contact us at {SITE.email}.
      </P>
      <H3>1.2 When Cancellation Is Allowed</H3>
      <P>
        Cancellation is permitted only while the order is in &ldquo;Payment Held&rdquo;
        (HELD) status — that is, after payment has been captured but before the seller marks
        the order as shipped.
      </P>
      <UL>
        <LI>Once the seller marks the order as shipped, cancellation is no longer available.</LI>
        <LI>
          Orders in CREATED status (payment not yet captured) can be abandoned; no charge has
          been made.
        </LI>
      </UL>
      <H3>1.3 How to Cancel</H3>
      <P>
        Navigate to your order page and click &ldquo;Cancel Order.&rdquo; You will be asked to
        provide an optional cancellation reason. The cancellation is processed immediately.
      </P>
      <H3>1.4 Refund Amount on Cancellation</H3>
      <P>
        When you cancel a HELD order, the platform fee ({SITE.platformFeePct} of the transaction
        amount, minimum {SITE.platformFeeMin}) is retained by Cricket Market. The remainder is
        refunded to your original payment method.
      </P>
      <P>
        <strong>Example:</strong> If you paid $100.00, the platform fee is $8.00. You would
        receive a refund of $92.00. For orders under $25.00, the {SITE.platformFeeMin} minimum
        fee applies; for example, a $20.00 order would carry a {SITE.platformFeeMin} fee and a
        $18.00 refund.
      </P>

      <H2 id="platform-fee">2. Platform Fee on Cancellation</H2>
      <P>
        The {SITE.platformFeePct} platform fee ({SITE.platformFeeMin} minimum) is non-refundable
        on any pre-shipment cancellation, regardless of who initiates the cancellation or the
        reason for it. This fee covers payment processing costs and Platform operating expenses
        already incurred at the time of payment capture.
      </P>

      <H2 id="post-shipment">3. Post-Shipment: No Cancellation</H2>
      <P>
        Once a seller marks an order as shipped, cancellation is not available. If you have a
        problem with the item after delivery, you must use the dispute process described in the{' '}
        <a href="/legal/buyer-protection" className="text-brand-700 hover:underline">
          Buyer Protection &amp; Dispute Policy
        </a>
        .
      </P>
      <P>
        We do not offer exchanges. If you and the seller agree to an exchange after delivery,
        you must transact as a new listing on the Platform.
      </P>

      <H2 id="dispute-refunds">4. Dispute-Based Refunds</H2>
      <P>
        If our team resolves a dispute in your favor (buyer wins), you receive a full refund of
        the transaction amount &mdash; including the platform fee portion &mdash; to your original
        payment method. The platform collects no fee from a transaction resolved in the
        buyer&rsquo;s favor. The seller receives no payment and no transfer is made on their
        behalf.
      </P>
      <P>
        Dispute-based refunds are only available:
      </P>
      <UL>
        <LI>While the order is in DELIVERED status (before the auto-release fires).</LI>
        <LI>For reasons that qualify under our Buyer Protection Policy.</LI>
        <LI>
          After our team completes its review (typically 3&ndash;5 business days after the
          dispute is filed).
        </LI>
      </UL>

      <H2 id="processing">5. Refund Processing</H2>
      <P>
        All refunds are processed through Stripe to the original payment method used at
        checkout. We do not issue refunds by cash, check, or store credit.
      </P>
      <P>Typical refund timelines:</P>
      <UL>
        <LI>
          <strong>Credit cards:</strong> 5&ndash;10 business days to appear on your statement,
          depending on your card issuer.
        </LI>
        <LI>
          <strong>Debit cards:</strong> 2&ndash;5 business days in most cases.
        </LI>
      </UL>
      <P>
        We process the refund on our end immediately upon decision, but we cannot control your
        bank&rsquo;s processing timeline. If you do not see a refund within 10 business days,
        contact us at {SITE.email}.
      </P>

      <H2 id="non-refundable">6. Non-Refundable Situations</H2>
      <P>Refunds are not available in the following situations:</P>
      <UL>
        <LI>
          The {SITE.deliveryWindowHours}-hour delivery window has expired and funds have been
          automatically released to the seller.
        </LI>
        <LI>
          You confirmed delivery and the funds were released to the seller.
        </LI>
        <LI>
          A dispute was filed but resolved in the seller&rsquo;s favor.
        </LI>
        <LI>
          The item was accurately described and matches the listing (buyer&rsquo;s remorse).
        </LI>
        <LI>
          You conducted a transaction off-platform to circumvent fees or dispute protections.
        </LI>
        <LI>
          Your account was suspended for policy violations.
        </LI>
      </UL>

      <H2 id="contact">7. Contact</H2>
      <P>
        For questions about a refund or cancellation:
        <br />
        <a href={`mailto:${SITE.email}`} className="text-brand-700 hover:underline">
          {SITE.email}
        </a>
        <br />
        {SITE.legalName} d/b/a {SITE.dba}
        <br />
        {SITE.address}
      </P>
    </LegalPage>
  );
}
