'use client';

// ChatWidget — floating customer chat button and panel.
//
// Security notes:
//   • All user input and AI replies are rendered as React text nodes — never
//     via dangerouslySetInnerHTML. The model is instructed to return plain
//     prose; the widget displays it as-is as text.
//   • Listing cards are rendered from validated API response fields (id,
//     title, price_cents, condition) — never from raw model output.
//   • User messages are trimmed and capped at MAX_CHARS before sending.
//   • No account, order, or payment data is read or displayed here.

import { useState, useRef, useEffect, FormEvent, KeyboardEvent } from 'react';
import Link from 'next/link';

const MAX_CHARS = 500;
const MAX_HISTORY = 6; // must match server MAX_MESSAGES

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ListingResult {
  id: number;
  title: string;
  price_cents: number;
  condition: string;
  category: string;
}

function conditionLabel(c: string): string {
  if (c === 'new')       return 'New';
  if (c === 'used_good') return 'Used – Good';
  if (c === 'used_fair') return 'Used – Fair';
  return c;
}

function formatPrice(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

// ListingCard renders a single search result. Uses Next.js Link for routing.
function ListingCard({ listing }: { listing: ListingResult }) {
  return (
    <Link
      href={`/listings/${listing.id}`}
      className="block border border-gray-200 rounded-lg p-2 hover:border-brand-500 hover:bg-brand-50 transition-colors"
    >
      <p className="text-sm font-medium text-gray-900 leading-snug line-clamp-2">
        {listing.title}
      </p>
      <p className="text-xs text-gray-500 mt-1">
        {formatPrice(listing.price_cents)} &middot; {conditionLabel(listing.condition)}
      </p>
    </Link>
  );
}

export default function ChatWidget() {
  const [open, setOpen]                     = useState(false);
  const [history, setHistory]               = useState<Message[]>([]);
  const [input, setInput]                   = useState('');
  const [loading, setLoading]               = useState(false);
  const [errorMsg, setErrorMsg]             = useState<string | null>(null);
  const [pendingResults, setPendingResults] = useState<ListingResult[]>([]);
  const bottomRef                           = useRef<HTMLDivElement>(null);

  // Scroll to bottom whenever a new message is added.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, pendingResults]);

  async function sendMessage(text: string) {
    const trimmed = text.trim().slice(0, MAX_CHARS);
    if (!trimmed) return;

    setErrorMsg(null);
    setPendingResults([]);

    const userMsg: Message = { role: 'user', content: trimmed };
    const newHistory: Message[] = [...history, userMsg].slice(-MAX_HISTORY);
    setHistory(newHistory);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newHistory }),
      });

      if (res.status === 429) {
        setErrorMsg('Too many messages — please wait a moment and try again.');
        setHistory((h) => h.slice(0, -1)); // remove the optimistic user message
        return;
      }
      if (res.status === 503) {
        setErrorMsg('Chat is not available right now. Try again later.');
        setHistory((h) => h.slice(0, -1));
        return;
      }
      if (!res.ok) {
        setErrorMsg('Something went wrong. Please try again.');
        setHistory((h) => h.slice(0, -1));
        return;
      }

      const data = await res.json() as { reply: string; search_results?: ListingResult[] };

      if (typeof data.reply !== 'string' || !data.reply) {
        setErrorMsg('Received an unexpected response. Please try again.');
        setHistory((h) => h.slice(0, -1));
        return;
      }

      const assistantMsg: Message = { role: 'assistant', content: data.reply };
      setHistory((h) => [...h, assistantMsg].slice(-MAX_HISTORY));

      if (Array.isArray(data.search_results) && data.search_results.length > 0) {
        // Validate each result has the required numeric id before rendering.
        const valid = data.search_results.filter(
          (r): r is ListingResult =>
            typeof r.id === 'number' &&
            typeof r.title === 'string' &&
            typeof r.price_cents === 'number'
        );
        setPendingResults(valid);
      }
    } catch {
      setErrorMsg('Connection error. Please check your network and try again.');
      setHistory((h) => h.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close chat' : 'Open Cricket Market assistant'}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-brand-700 text-white shadow-lg
                   hover:bg-brand-800 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2
                   flex items-center justify-center transition-colors"
      >
        {open ? (
          /* X icon */
          <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          /* Chat bubble icon */
          <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          role="dialog"
          aria-label="Cricket Market assistant"
          className="fixed bottom-24 right-6 z-50 w-80 sm:w-96 bg-white rounded-2xl shadow-2xl
                     border border-gray-200 flex flex-col overflow-hidden"
          style={{ maxHeight: '75vh' }}
        >
          {/* Header */}
          <div className="bg-brand-700 px-4 py-3 flex items-center justify-between shrink-0">
            <div>
              <p className="text-white font-semibold text-sm">Cricket Market Assistant</p>
              <p className="text-brand-200 text-xs">Ask about listings, fees, or policies</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="text-brand-200 hover:text-white transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Message area */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {history.length === 0 && !loading && (
              <div className="text-center text-gray-400 text-sm pt-4">
                <p className="mb-2">Hi! I can help with:</p>
                <ul className="text-left space-y-1 mx-auto inline-block">
                  {[
                    'Finding cricket bats and gear',
                    'Platform fees and payments',
                    'How escrow and buyer protection work',
                    'Cancellations and refunds',
                  ].map((item) => (
                    <li key={item} className="text-xs text-gray-500 flex gap-1">
                      <span className="text-brand-600 shrink-0">•</span> {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {history.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                    msg.role === 'user'
                      ? 'bg-brand-700 text-white rounded-br-sm'
                      : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {/* Listing cards — shown after the last assistant message */}
            {pendingResults.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">
                  Listings found
                </p>
                {pendingResults.map((listing) => (
                  <ListingCard key={listing.id} listing={listing} />
                ))}
              </div>
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2">
                  <span className="flex gap-1 items-center">
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {errorMsg}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input area */}
          <form
            onSubmit={handleSubmit}
            className="shrink-0 border-t border-gray-200 px-3 py-2 flex gap-2 items-end bg-white"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value.slice(0, MAX_CHARS))}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question…"
              rows={1}
              maxLength={MAX_CHARS}
              disabled={loading}
              aria-label="Chat message"
              className="flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent
                         placeholder-gray-400 disabled:bg-gray-50 max-h-28 overflow-y-auto"
              style={{ lineHeight: '1.4' }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              aria-label="Send message"
              className="shrink-0 w-9 h-9 rounded-xl bg-brand-700 text-white flex items-center justify-center
                         hover:bg-brand-800 disabled:opacity-40 disabled:cursor-not-allowed
                         focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 rotate-90" fill="currentColor" viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </form>

          {/* Character counter */}
          {input.length > 400 && (
            <p className="shrink-0 text-right text-xs text-gray-400 pb-1 pr-3 bg-white">
              {MAX_CHARS - input.length} characters remaining
            </p>
          )}
        </div>
      )}
    </>
  );
}
