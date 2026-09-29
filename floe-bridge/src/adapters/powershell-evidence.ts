/**
 * @invariant Reduces a complete PowerShell command text to policy evidence:
 * one executable name per pipeline segment, whether output is redirected to a
 * file, and the literal URLs it names. Anything the reader cannot classify with
 * certainty becomes null (unclassified), never a guess. The text itself is
 * not kept.
 */

export type ShellEvidence = {
  /** One entry per segment; null when the command could not be classified. */
  executables: (string | null)[];
  write_redirection: boolean;
  urls: string[];
};

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`;|()<>{}]+/gi;
const EXECUTABLE_SUFFIX = /\.(exe|cmd|bat|com)$/;
const PLAIN_NAME = /^[A-Za-z0-9_.:\\/ -]+$/;

type Segment = { tokens: string[]; complex: boolean };

export function powershellEvidence(command: string): ShellEvidence {
  const urls = [...new Set(command.match(URL_PATTERN) ?? [])];
  const split = splitSegments(command);
  if (!split) return { executables: [null], write_redirection: /[>]/.test(command), urls };
  return {
    executables: split.segments
      .filter((segment) => segment.tokens.length > 0 || segment.complex)
      .map(executableOf),
    write_redirection: split.writeRedirection,
    urls,
  };
}

function executableOf(segment: Segment): string | null {
  if (segment.complex) return null;
  let [first, second] = segment.tokens;
  if (first === "&" || first === ".") first = second;
  if (!first || first.startsWith("$") || first.startsWith("-") || !PLAIN_NAME.test(first)) return null;
  const name = first.split(/[\\/]/).pop()!.toLowerCase().replace(EXECUTABLE_SUFFIX, "");
  return name || null;
}

/** Splits on unquoted ; | && || & and newlines. Null when quoting is unbalanced. */
function splitSegments(text: string): { segments: Segment[]; writeRedirection: boolean } | null {
  const segments: Segment[] = [];
  let segment: Segment = { tokens: [], complex: false };
  let token = "";
  let quoted = false;
  let writeRedirection = false;
  const endToken = () => {
    if (token || quoted) segment.tokens.push(token);
    token = "";
    quoted = false;
  };
  const endSegment = () => {
    endToken();
    segments.push(segment);
    segment = { tokens: [], complex: false };
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") {
      const close = singleQuoteEnd(text, i + 1);
      if (close < 0) return null;
      token += text.slice(i + 1, close).replace(/''/g, "'");
      quoted = true;
      i = close;
    } else if (ch === "\"") {
      const close = doubleQuoteEnd(text, i + 1);
      if (close < 0) return null;
      const body = text.slice(i + 1, close);
      if (/[$`]/.test(body)) segment.complex = true;
      token += body;
      quoted = true;
      i = close;
    } else if (
      ch === "`" || ch === "(" || ch === ")" || ch === "{" || ch === "}"
      || (ch === "@" && /["'({]/.test(text[i + 1] ?? ""))
      || (ch === "[" && !token)
    ) {
      // Escapes, subexpressions, script blocks, splats, here-strings and type literals.
      segment.complex = true;
      token += ch;
      if (ch === "`") i++;
    } else if (ch === ">") {
      // N>&M merges streams; every other redirection writes to a file.
      if (!/^>&\d/.test(text.slice(i, i + 3))) writeRedirection = true;
      if (/\d$/.test(token)) token = token.slice(0, -1);
      endToken();
      segment.complex = segment.complex || !segment.tokens.length;
      i = skipRedirectTarget(text, i);
    } else if (ch === "<") {
      segment.complex = true;
    } else if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|") {
      endSegment();
      if (text[i + 1] === ch) i++;
    } else if (ch === "&") {
      if (text[i + 1] === "&") {
        endSegment();
        i++;
      } else if (!token && segment.tokens.length === 0) {
        segment.tokens.push("&");
      } else {
        endSegment();
      }
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token += ch;
    }
  }
  endSegment();
  return { segments, writeRedirection };
}

/** Skips the redirection operator and its target so the target is not read as an argument. */
function skipRedirectTarget(text: string, at: number): number {
  let i = at;
  while (text[i + 1] === ">" || text[i + 1] === "&") i++;
  while (i + 1 < text.length && /[ \t]/.test(text[i + 1]!)) i++;
  while (i + 1 < text.length && !/[\s;|&]/.test(text[i + 1]!)) i++;
  return i;
}

function singleQuoteEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "'") continue;
    if (text[i + 1] === "'") {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

function doubleQuoteEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "`") {
      i++;
      continue;
    }
    if (text[i] === "\"") return i;
  }
  return -1;
}
