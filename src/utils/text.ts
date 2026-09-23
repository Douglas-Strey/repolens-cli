/**
 * Sanitizing untrusted repository text before it reaches any output.
 *
 * Every format (terminal, Markdown, agent files, debug logs) removes the same
 * characters; escaping stays format-specific. Every pattern runs in linear time.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
// Line and paragraph separators, plus tabs and newlines when a single line is wanted.
const BREAKS = /[\t\n\r\u2028\u2029]+/g
// Invisible and bidi format characters could disguise what is printed; Unicode tag
// characters (U+E0000-U+E007F) can smuggle hidden text into files read by AI agents.
// Tag characters are matched as surrogate pairs so the pattern needs no `u` flag.
const INVISIBLE = /[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]|\udb40[\udc00-\udc7f]/g

/**
 * Remove control, invisible and bidi characters. Keeps tabs and newlines
 * unless `oneLine` is set, in which case whitespace runs become one space.
 */
export function cleanUntrusted(text: string, options: { oneLine?: boolean } = {}): string {
  let out = text.replace(CONTROL, '').replace(INVISIBLE, '')
  if (options.oneLine) out = out.replace(BREAKS, ' ').trim()
  return out
}
