import type { Metadata } from 'next';
import LegalPage, { H2, H3, P, UL, LI, Note } from '@/components/LegalPage';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Buyer Protection & Dispute Policy — Cricket Market',
  description: 'How Cricket Market protects buyers through escrow and the dispute process.',
};

const NAV = [
  { href: '#how-escrow-works', label: 'How Escrow Works' },
  { href: '#delivery-window', label: 'Delivery Window' },
  { href: '#filing-a-dispute', label: 'Filing a Dispute' },
  { href: '#valid-disputes', label: 'Valid Disputes' },
  { href: '#invalid-disputes', label: 'Invalid Disputes' },
  { href: '#dispute-process', label: 'Dispute Process' },
  { href: '#resolutions', label: 'Resolutions' },
  { href: '#limitations', label: 'Limitations' },
  { href: '#contact', label: 'Contact' },
];

export default function BuyerProtectionPage() {
  return (
    <LegalPage title="Buyer Protection & Dispute Policy" updated="August 27, 2026" navLinks={NAV}>
      <Note>
        This is a draft for attorney review. It does not constitute legal advice and is subject
        to revision before public launch.
      </Note>

      <P>
        Cricket Market holds buyer funds in escrow until delivery is confirmed. This policy
        explains how that protection works, when you can file a dispute, and how disputes are
        resolved.
      </P>

      <H2 id="how-escrow-works">1. How Escrow Works</H2>
      <P>
        When you complete checkout, your payment is authorized and captured by Stripe. The funds
        are held by our payment processor and are not released to the seller until one of the
        following occurs:
      </P>
      <UL>
        <LI>You confirm receipt of the item and its condition is as described.</LI>
        <LI>
          The {SITE.deliveryWindowHours}-hour auto-release window expires after the seller marks
          the order delivered, without any action from you.
        </LI>
        <LI>
          A dispute you filed is resolved by our team in the seller&rsquo;s favor.
        </LI>
      </UL>
      <P>
        If a valid dispute is resolved in your favor, funds are refunded to your original payment
        method instead of released to the seller.
      </P>

      <H2 id="delivery-window">2. The {SITE.deliveryWindowHours}-Hour Delivery Window</H2>
      <P>
        Once the seller marks an order as delivered in the Platform, you have{' '}
        {SITE.deliveryWindowHours} hours to:
      </P>
      <UL>
        <LI>Confirm receipt (releases funds to the seller immediately), or</LI>
        <LI>File a dispute (pauses the auto-release).</LI>
      </UL>
      <P>
        If you take no action within {SITE.deliveryWindowHours} hours, funds are automatically
        released to the seller. This auto-release is irreversible. Please inspect your item
        promptly upon arrival and act within the window.
      </P>
      <Note>
        If you will be unavailable to receive or inspect your item, plan your purchase timing
        accordingly. We cannot extend the {SITE.deliveryWindowHours}-hour window after it has
        started.
      </Note>

      <H2 id="filing-a-dispute">3. Filing a Dispute</H2>
      <P>To file a dispute:</P>
      <UL>
        <LI>The order must be in &ldquo;Delivered&rdquo; status.</LI>
        <LI>
          You must file within the {SITE.deliveryWindowHours}-hour window after the seller marks
          the order delivered.
        </LI>
        <LI>Navigate to your order page and click &ldquo;File Dispute.&rdquo;</LI>
        <LI>Provide a clear, specific reason for your dispute.</LI>
      </UL>
      <P>
        Filing a dispute pauses the auto-release timer. Funds remain in escrow while our team
        reviews the case.
      </P>

      <H2 id="valid-disputes">4. Valid Dispute Reasons</H2>
      <P>We will consider a dispute valid when the buyer provides evidence of:</P>
      <UL>
        <LI>
          <strong>Item not as described:</strong> The item received is materially different from
          the listing (e.g., wrong model, wrong size, undisclosed damage, counterfeit goods).
        </LI>
        <LI>
          <strong>Item not received:</strong> The order was marked delivered but no item arrived
          and carrier tracking confirms non-delivery or loss.
        </LI>
        <LI>
          <strong>Significantly damaged in transit:</strong> The item arrived with damage not
          present at listing that renders it substantially different from what was described.
        </LI>
        <LI>
          <strong>Prohibited item:</strong> The seller shipped an item that violates our
          Prohibited Items Policy.
        </LI>
      </UL>

      <H2 id="invalid-disputes">5. Invalid Dispute Reasons</H2>
      <P>The following are not covered by Buyer Protection:</P>
      <UL>
        <LI>
          <strong>Buyer&rsquo;s remorse:</strong> You changed your mind or found a better price
          elsewhere.
        </LI>
        <LI>
          <strong>Minor cosmetic differences:</strong> Small aesthetic variations consistent with
          the disclosed condition (&ldquo;used – good&rdquo; or &ldquo;used – fair&rdquo;) that
          were reasonably expected.
        </LI>
        <LI>
          <strong>Fit or preference:</strong> The item does not fit your playing style or personal
          preference when the listing was accurate.
        </LI>
        <LI>
          <strong>Late delivery:</strong> Shipping delays caused by carriers are not grounds for
          a dispute unless the item is confirmed lost.
        </LI>
        <LI>
          <strong>Post-window disputes:</strong> Disputes filed after the {SITE.deliveryWindowHours}
          -hour window has closed and funds have been released.
        </LI>
      </UL>

      <H2 id="dispute-process">6. Dispute Review Process</H2>
      <H3>6.1 Submission</H3>
      <P>
        Upon filing, both the buyer and seller are notified. The seller has an opportunity to
        respond through the Platform messaging system.
      </P>
      <H3>6.2 Review</H3>
      <P>
        Our team reviews the dispute reason, listing description, photos, order history, and any
        evidence provided by either party. We aim to respond within 3&ndash;5 business days.
        Complex cases may take longer. We may contact you at {SITE.email} for additional
        information.
      </P>
      <H3>6.3 Decision</H3>
      <P>
        Our dispute decision is final and binding. By using the Platform, both parties agree to
        accept our determination as part of these Terms of Service.
      </P>

      <H2 id="resolutions">7. Resolutions</H2>
      <H3>Buyer wins</H3>
      <P>
        Funds are refunded to the buyer&rsquo;s original payment method. The seller retains the
        item (or arranges a return at their own discretion). The platform fee is not refunded to
        the seller.
      </P>
      <H3>Seller wins</H3>
      <P>
        Funds are released to the seller&rsquo;s Stripe account, minus the platform fee.
        The buyer retains the item.
      </P>
      <P>
        We do not mediate returns or arrange shipping of items back to the seller. If a return is
        mutually agreed upon, buyers and sellers must arrange it independently. We are not
        responsible for the condition of returned items.
      </P>

      <H2 id="limitations">8. Limitations</H2>
      <UL>
        <LI>
          Buyer Protection applies only to transactions completed through Cricket Market&rsquo;s
          payment system. Transactions conducted off-platform are not covered.
        </LI>
        <LI>
          We are not responsible for items lost or damaged after the delivery window closes and
          funds have been released.
        </LI>
        <LI>
          We do not guarantee that disputed items will be returned to sellers, or that buyers
          will receive replacement items.
        </LI>
        <LI>
          Abuse of the dispute system (repeated baseless disputes, fraudulent claims) may result
          in account suspension.
        </LI>
      </UL>

      <H2 id="contact">9. Contact</H2>
      <P>
        For questions about a dispute or this policy:
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
