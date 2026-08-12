'use strict';

const { generateTemplatedSuggestions } = require('./seoTemplates');

// ---------------------------------------------------------------------------
// System prompt — used when ANTHROPIC_API_KEY is set and the SDK is installed.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an SEO specialist for a USA cricket equipment marketplace. \
Your job is to improve listing quality to help sellers rank in Google Shopping and organic search. \
Cricket buyers search for brand names (Gray-Nicolls, Kookaburra, GM, SG, MRF), willow type (English, Kashmir), \
grade, weight, and condition. Always write in plain US English. \
Keep meta_description under 155 characters. Keep meta_title under 60 characters. \
Titles should be specific and include brand + item + key spec + condition. \
Return ONLY valid JSON — no prose, no code fences, no markdown.`;

// ---------------------------------------------------------------------------
// Prompt builder — call this to construct the user message for Claude.
// ---------------------------------------------------------------------------
function buildUserPrompt(listing) {
  return `Improve the SEO fields for this cricket equipment listing.

Title: ${listing.title || '(none)'}
Description: ${listing.description || '(none)'}
Category: ${listing.category || '(none)'}
Condition: ${listing.condition || '(none)'}
Price (cents): ${listing.price_cents || 0}
Existing meta_title: ${listing.meta_title || '(none)'}
Existing meta_description: ${listing.meta_description || '(none)'}
Existing tags: ${listing.tags || '[]'}

Return a JSON object with exactly these keys:
{
  "title": "...",          // improved listing title
  "description": "...",    // return unchanged — do not rewrite prose
  "meta_title": "...",     // max 60 chars
  "meta_description": "...", // max 155 chars
  "tags": ["...", "..."]   // array of 5–10 relevant tag strings
}`;
}

// ---------------------------------------------------------------------------
// Main export — dual-mode SEO suggestion generator.
//
// When ANTHROPIC_API_KEY is set the intent is to call the Claude API.
// Because @anthropic-ai/sdk is not yet installed, we fall through to the
// template fallback even when the key is present. To activate Claude:
//   1. npm install @anthropic-ai/sdk  (in listing-service)
//   2. Replace the stub block below with the real SDK call shown in the TODO.
// ---------------------------------------------------------------------------
async function generateSeoSuggestions(listing) {
  if (process.env.ANTHROPIC_API_KEY) {
    // TODO: install @anthropic-ai/sdk, then replace this stub with:
    //
    // const Anthropic = require('@anthropic-ai/sdk');
    // const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // const msg = await client.messages.create({
    //   model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    //   max_tokens: 1024,
    //   system: SYSTEM_PROMPT,
    //   messages: [{ role: 'user', content: buildUserPrompt(listing) }],
    // });
    // // Strip code fences if Claude wrapped the JSON in markdown
    // const raw = msg.content[0].text.replace(/```(?:json)?\n?/g, '').trim();
    // return { ...JSON.parse(raw), claude_used: true };
    //
    // For now, fall through to template fallback even if key is set.
    console.warn('[claudeClient] ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed. Using template fallback.');
  }

  // Always use the rules/template fallback until the SDK is installed.
  return { ...generateTemplatedSuggestions(listing), claude_used: false };
}

module.exports = { generateSeoSuggestions, SYSTEM_PROMPT, buildUserPrompt };
