import type { Metadata } from 'next';
import LegalPage, { H2, H3, P, UL, LI, Note } from '@/components/LegalPage';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Prohibited Items Policy — Cricket Market',
  description: 'What you can and cannot list or sell on Cricket Market.',
};

const NAV = [
  { href: '#permitted', label: 'Permitted Items' },
  { href: '#prohibited', label: 'Prohibited Items' },
  { href: '#listing-standards', label: 'Listing Standards' },
  { href: '#enforcement', label: 'Enforcement' },
  { href: '#reporting', label: 'Reporting Violations' },
  { href: '#contact', label: 'Contact' },
];

export default function ProhibitedItemsPage() {
  return (
    <LegalPage title="Prohibited Items Policy" updated="August 27, 2026" navLinks={NAV}>
      <Note>
        This is a draft for attorney review. It does not constitute legal advice and is subject
        to revision before public launch.
      </Note>

      <P>
        Cricket Market is a cricket-equipment-only marketplace. This policy defines what may and
        may not be listed. Sellers are responsible for ensuring every listing complies with this
        policy before it is published. Violations may result in immediate listing removal and
        account suspension.
      </P>

      <H2 id="permitted">1. Permitted Items</H2>
      <P>
        Only the following categories of cricket-related equipment may be listed for sale:
      </P>
      <UL>
        <LI>
          <strong>Cricket bats</strong> &mdash; all formats and willow grades (English willow,
          Kashmir willow), including youth bats.
        </LI>
        <LI>
          <strong>Batting pads</strong> &mdash; front-leg and back-leg pads, thigh guards.
        </LI>
        <LI>
          <strong>Helmets</strong> &mdash; cricket-specific batting and wicket-keeping helmets.
          Helmets must comply with applicable safety standards (e.g., BS 7928, ASTM F2772).
        </LI>
        <LI>
          <strong>Gloves</strong> &mdash; batting gloves and wicket-keeping gloves.
        </LI>
        <LI>
          <strong>Kit bags</strong> &mdash; cricket kit bags, wheels bags, and duffle bags
          marketed for cricket use.
        </LI>
        <LI>
          <strong>Accessories and other cricket equipment</strong> &mdash; including cricket
          balls (match and practice), stumps and bails, batting grip tape, toe guards, bat
          covers, arm guards, abdominal guards, chest guards, inner gloves, elbow guards, ankle
          guards, batting tees, and bowling machines.
        </LI>
      </UL>
      <P>
        Items must be physical goods that can be shipped within the United States. Digital goods,
        services, and lessons are not permitted.
      </P>

      <H2 id="prohibited">2. Prohibited Items</H2>
      <H3>2.1 Non-Cricket Items</H3>
      <P>
        Any item not directly related to the sport of cricket is prohibited, including general
        sporting goods, apparel not branded or designed for cricket, electronics, and
        personal items.
      </P>
      <H3>2.2 Counterfeit &amp; Unauthorized Goods</H3>
      <P>
        Listing counterfeit, replica, or unauthorized copies of branded cricket equipment (e.g.,
        fake Kookaburra, Gray-Nicolls, or Dukes items) is strictly prohibited and may result in
        referral to law enforcement.
      </P>
      <H3>2.3 Unsafe or Recalled Equipment</H3>
      <UL>
        <LI>
          Helmets that do not meet applicable safety standards or that have been recalled by
          the manufacturer or a regulatory authority.
        </LI>
        <LI>
          Equipment that has been structurally compromised (e.g., cracked bat handle splice,
          helmet with a damaged grill) that is not disclosed as such in the listing.
        </LI>
        <LI>
          Any item subject to a current product safety recall in the United States.
        </LI>
      </UL>
      <H3>2.4 Stolen Goods</H3>
      <P>
        Listing items that are stolen, misappropriated, or obtained through fraud is prohibited
        and may result in referral to law enforcement.
      </P>
      <H3>2.5 Hazardous Materials</H3>
      <P>
        Items containing hazardous materials that cannot be legally shipped via standard
        carriers (USPS, UPS, FedEx, etc.) are prohibited.
      </P>
      <H3>2.6 Items Prohibited for Sale in Texas</H3>
      <P>
        Any item whose sale is prohibited under Texas law or applicable federal law may not be
        listed, regardless of category.
      </P>

      <H2 id="listing-standards">3. Listing Standards</H2>
      <P>All listings must meet the following minimum standards:</P>
      <UL>
        <LI>
          <strong>Accurate title:</strong> The item title must accurately identify the product
          (e.g., brand, model, size where relevant). Keyword stuffing or misleading titles are
          prohibited.
        </LI>
        <LI>
          <strong>Accurate description:</strong> All material defects, damage, or wear must be
          disclosed. Omitting known defects is a policy violation and grounds for dispute.
        </LI>
        <LI>
          <strong>Accurate condition:</strong> Select the condition (New / Used – Good /
          Used – Fair) that accurately reflects the item. &ldquo;New&rdquo; must mean unused,
          in original packaging or equivalent condition.
        </LI>
        <LI>
          <strong>Real photographs:</strong> At least one photo must be of the actual item you
          are selling (not a stock photo). Photos must not be digitally altered to conceal
          damage.
        </LI>
        <LI>
          <strong>Accurate price:</strong> The listed price must be the final purchase price.
          Fees and shipping are separate; do not embed undisclosed charges in the item price.
        </LI>
      </UL>

      <H2 id="enforcement">4. Enforcement</H2>
      <P>
        We reserve the right to remove any listing and take the following actions against
        violating accounts at our sole discretion:
      </P>
      <UL>
        <LI>
          <strong>Warning:</strong> First-time or minor violations may receive a written warning.
        </LI>
        <LI>
          <strong>Listing removal:</strong> The violating listing is removed without prior
          notice.
        </LI>
        <LI>
          <strong>Temporary suspension:</strong> The seller&rsquo;s account is suspended for a
          defined period.
        </LI>
        <LI>
          <strong>Permanent ban:</strong> Repeated violations, fraud, or prohibited-item sales
          result in permanent account termination.
        </LI>
        <LI>
          <strong>Law enforcement referral:</strong> Counterfeit goods, stolen property, and
          fraud may be reported to federal or Texas state authorities.
        </LI>
      </UL>
      <P>
        Suspended sellers with active orders will have those orders cancelled and buyers
        refunded at our discretion.
      </P>

      <H2 id="reporting">5. Reporting Violations</H2>
      <P>
        If you see a listing that violates this policy, please report it to us at{' '}
        <a href={`mailto:${SITE.email}`} className="text-brand-700 hover:underline">
          {SITE.email}
        </a>{' '}
        with the listing URL and a brief description of the concern. We review all reports and
        respond within 2 business days.
      </P>

      <H2 id="contact">6. Contact</H2>
      <P>
        Questions about whether a specific item is permitted:
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
