// chatPolicy.test.ts — verify system prompt contains every verified policy fact.
// These tests guard against accidental policy edits that could cause the bot
// to give wrong answers to customers.

import { buildSystemPrompt, SUPPORT_EMAIL } from '../lib/chatPolicy';

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt(null);

  it('contains the support email address', () => {
    expect(prompt).toContain(SUPPORT_EMAIL);
    expect(prompt).toContain('support@cricketmarketusa.com');
  });

  it('states the platform fee percentage and minimum', () => {
    expect(prompt).toContain('8%');
    expect(prompt).toContain('$2.00');
  });

  it('states that buyers pay listed price only (fee deducted from seller)', () => {
    expect(prompt.toLowerCase()).toMatch(/buyers? pay the listed price only/);
    expect(prompt.toLowerCase()).toMatch(/deducted from the seller/);
  });

  it('states minimum listing price', () => {
    expect(prompt).toContain('$10.00');
  });

  it('states the 48-hour delivery window', () => {
    expect(prompt).toContain('48');
    expect(prompt.toLowerCase()).toMatch(/48.hour/);
  });

  it('states auto-release is irreversible', () => {
    expect(prompt.toLowerCase()).toContain('irreversible');
  });

  it('states platform fee is non-refundable on cancellation', () => {
    expect(prompt.toLowerCase()).toMatch(/non.refundable/);
  });

  it('includes the cancellation refund example', () => {
    // $100 order → $8.00 fee → $92.00 refund
    expect(prompt).toContain('$92');
    expect(prompt).toContain('$8.00');
  });

  it('states seller must ship within 3 business days', () => {
    expect(prompt).toContain('3 business days');
  });

  it('lists valid dispute reasons', () => {
    expect(prompt.toLowerCase()).toContain('not as described');
    expect(prompt.toLowerCase()).toContain('not received');
    expect(prompt.toLowerCase()).toContain('transit damage');
  });

  it('lists invalid dispute reasons including buyers remorse', () => {
    expect(prompt.toLowerCase()).toContain("buyer's remorse");
  });

  it('states dispute review time', () => {
    expect(prompt).toMatch(/3.5 business days/);
  });

  it('states refund credit card timeline', () => {
    expect(prompt).toMatch(/5.10 business days/);
  });

  it('states refund debit card timeline', () => {
    expect(prompt).toMatch(/2.5 business days/);
  });

  it('declares no markdown or HTML in replies', () => {
    expect(prompt.toLowerCase()).toMatch(/no html/i);
  });

  it('forbids following user persona-change instructions', () => {
    expect(prompt.toLowerCase()).toMatch(/persona|reveal.*prompt/i);
  });

  it('lists undocumented topics that should go to support', () => {
    expect(prompt.toLowerCase()).toContain('who pays shipping');
    expect(prompt.toLowerCase()).toContain('seller payout');
    expect(prompt.toLowerCase()).toContain('uncaptured');
  });

  it('includes listing context block when provided', () => {
    const p = buildSystemPrompt('1. Some Bat — $50.00 (New)');
    expect(p).toContain('1. Some Bat — $50.00 (New)');
    expect(p).toContain('LIVE LISTING RESULTS');
  });

  it('does not include listing block when context is null', () => {
    const p = buildSystemPrompt(null);
    expect(p).not.toContain('LIVE LISTING RESULTS');
  });
});
