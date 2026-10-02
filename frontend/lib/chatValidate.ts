// chatValidate.ts — input validation for POST /api/chat.
//
// Rejects:
//   • bodies larger than MAX_BODY_BYTES
//   • non-array or empty messages
//   • more than MAX_MESSAGES messages
//   • any message with role other than 'user' or 'assistant'
//     (prevents client-supplied system instructions)
//   • messages whose content exceeds MAX_MESSAGE_CHARS
//   • last message not being a user message

export const MAX_BODY_BYTES   = 10_240;   // 10 KB
export const MAX_MESSAGES     = 6;        // 3 conversation turns
export const MAX_MESSAGE_CHARS = 500;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ValidationResult =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; status: number; error: string };

export function validateMessages(raw: unknown): ValidationResult {
  if (!Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'messages must be an array' };
  }
  if (raw.length === 0) {
    return { ok: false, status: 400, error: 'messages array is empty' };
  }
  if (raw.length > MAX_MESSAGES) {
    return {
      ok: false,
      status: 400,
      error: `messages exceeds maximum of ${MAX_MESSAGES}`,
    };
  }

  const messages: ChatMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i];
    if (typeof msg !== 'object' || msg === null) {
      return { ok: false, status: 400, error: `messages[${i}] is not an object` };
    }
    const { role, content } = msg as Record<string, unknown>;

    if (role !== 'user' && role !== 'assistant') {
      return {
        ok: false,
        status: 400,
        error: `messages[${i}].role must be "user" or "assistant"`,
      };
    }
    if (typeof content !== 'string') {
      return { ok: false, status: 400, error: `messages[${i}].content must be a string` };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        status: 400,
        error: `messages[${i}].content exceeds ${MAX_MESSAGE_CHARS} characters`,
      };
    }
    messages.push({ role, content });
  }

  if (messages[messages.length - 1].role !== 'user') {
    return { ok: false, status: 400, error: 'last message must have role "user"' };
  }

  return { ok: true, messages };
}
