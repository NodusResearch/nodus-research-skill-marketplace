/** The little the chemistry engine needs to know about fenced blocks.
 *
 *  The package receives a parsed tree from the host, so it never re-parses a whole reply.
 *  What is left is reading one model answer the package asked for itself — a repair, a
 *  fallback drawing — and those only ever contain a fenced block or prose. */

export interface Fence { kind: 'markdown' | 'chemistry-plan' | 'svg' | 'chemfig' | 'other'; content: string; complete: boolean }

const PATTERN = /(^[ \t]*(`{3,}|~{3,})([^\n]*)\n)|(<svg\b)/gim;

export function splitFences(content: string): Fence[] {
  const parts: Fence[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = PATTERN.exec(content))) {
    const start = match.index;
    let end: number, body: string, kind: Fence['kind'], complete: boolean;
    if (match[2]) {
      const fence = match[2];
      const language = match[3].trim().toLowerCase();
      const tail = content.slice(PATTERN.lastIndex);
      const closing = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, 'm').exec(tail);
      end = closing ? PATTERN.lastIndex + closing.index + closing[0].length : content.length;
      body = tail.slice(0, closing?.index ?? tail.length).trim();
      complete = !!closing;
      if (/^(svg|xml|html)?$/.test(language)) body = body.replace(/^<\?xml[\s\S]*?\?>\s*/i, '');
      const isChemfig = language === 'chemfig'
        || ((language === 'latex' || language === 'tex') && /\\(?:chemfig|schemestart|chemname|lewis)\b/.test(body));
      kind = language === 'chemistry-plan' ? 'chemistry-plan'
        : isChemfig ? 'chemfig'
          : /^(svg|xml|html)?$/.test(language) && /^<svg\b/i.test(body) ? 'svg'
            : language ? 'other' : 'markdown';
      if (kind === 'markdown') { PATTERN.lastIndex = end; continue; }
    } else {
      const closing = /<\/svg\s*>/i.exec(content.slice(PATTERN.lastIndex));
      end = closing ? PATTERN.lastIndex + closing.index + closing[0].length : content.length;
      body = content.slice(start, end);
      complete = !!closing;
      kind = 'svg';
    }
    if (start > cursor) parts.push({ kind: 'markdown', content: content.slice(cursor, start), complete: true });
    parts.push({ kind, content: body, complete: complete && (kind !== 'svg' || /<\/svg\s*>$/i.test(body)) });
    cursor = end;
    PATTERN.lastIndex = end;
  }
  if (cursor < content.length) parts.push({ kind: 'markdown', content: content.slice(cursor), complete: true });
  return parts;
}

/** Compatibility shape for the ported engine, which asked for chat visual parts. */
export const splitChatVisuals = splitFences;
