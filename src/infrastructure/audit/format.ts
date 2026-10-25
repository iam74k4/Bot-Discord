/**
 * Format audit target mention by action type
 */
export function formatAuditTarget(
  action: string,
  targetId: string | null | undefined
): string | null {
  if (!targetId) {
    return null;
  }

  if (action === 'AUDIT_SETUP') {
    return `<#${targetId}>`;
  }

  return `<@${targetId}>`;
}

/**
 * An unclosed Discord markup token at the end of a string: a user, role,
 * channel or command mention, a custom emoji or a timestamp cut short.
 */
const UNCLOSED_MARKUP = /<(?:@[!&]?|#|\/|a?:|t:)[^<>]*$/;

/**
 * Stored details shortened for a list line. Details are free text written by
 * each caller (and old rows may be long English prose), so a list of them
 * would otherwise overflow an embed description.
 *
 * Counted in code points, so an emoji in a role or channel name is never
 * split in half; and a mention the cut would break (`<@&12…`) is dropped
 * whole rather than shown as raw markup.
 */
export function shortenAuditDetails(details: string, max = 90): string {
  const singleLine = details.replace(/\s*\n\s*/g, ' ').trim();
  const chars = Array.from(singleLine);
  if (chars.length <= max) return singleLine;
  const kept = chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .replace(UNCLOSED_MARKUP, '');
  return `${kept.trimEnd()}…`;
}
