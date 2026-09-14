/**
 * MiniMarkdown — small, self-contained markdown renderer for Floe-authored
 * text. No external runtime dependency (react-markdown/marked
 * are not installed and adding them risks a slow/blocked `npm install`).
 *
 * Supported subset, deliberately small but enough for actor instructions:
 *  - headings (#, ##, ###)
 *  - bold (**x**), italic (*x*)
 *  - inline code (`x`) and fenced code blocks (```)
 *  - unordered lists (-, *) and ordered lists (1.)
 *  - links ([text](url))
 *  - paragraphs (blank-line separated)
 *
 * This is intentionally not a full CommonMark implementation. It exists so
 * actor instructions and conversation messages can be rendered consistently
 * without taking on a new dependency.
 */
import React from "react";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block
    if (/^```/.test(line.trim())) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test((lines[i] ?? "").trim())) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: headingMatch[2]!.trim() });
      i++;
      continue;
    }

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // List (unordered: -/* , ordered: "1.")
    const isUnordered = /^[-*]\s+/.test(line);
    const isOrdered = /^\d+\.\s+/.test(line);
    if (isUnordered || isOrdered) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        const ul = /^[-*]\s+(.*)$/.exec(cur);
        const ol = /^\d+\.\s+(.*)$/.exec(cur);
        if (isUnordered && ul) {
          items.push(ul[1]!.trim());
          i++;
        } else if (isOrdered && ol) {
          items.push(ol[1]!.trim());
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    // Paragraph — collect contiguous non-blank, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,3})\s+/.test(lines[i] ?? "") &&
      !/^```/.test((lines[i] ?? "").trim()) &&
      !/^[-*]\s+/.test(lines[i] ?? "") &&
      !/^\d+\.\s+/.test(lines[i] ?? "")
    ) {
      paraLines.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join(" ").trim() });
  }

  return blocks;
}

/** Render inline spans: bold, italic, inline code, links. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Tokenize left-to-right with a single combined regex.
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${key++}`}>{match[2]}</strong>);
    } else if (match[4] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${key++}`}>{match[4]}</em>);
    } else if (match[6] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-${key++}`} style={{ background: "rgba(255,255,255,0.08)", borderRadius: 3, padding: "1px 4px", fontSize: "0.92em" }}>
          {match[6]}
        </code>
      );
    } else if (match[8] !== undefined && match[9] !== undefined) {
      const href = safeLinkHref(match[9]);
      nodes.push(href ? (
        <a key={`${keyPrefix}-${key++}`} href={href} target="_blank" rel="noreferrer" style={{ color: "#8aa89c" }}>
          {match[8]}
        </a>
      ) : (
        <span key={`${keyPrefix}-${key++}`}>{match[8]}</span>
      ));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

/** Chat content is untrusted; only schemes that cannot execute app code become links. */
function safeLinkHref(value: string): string | null {
  const trimmed = value.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

const headingSize: Record<1 | 2 | 3, number> = { 1: 20, 2: 17, 3: 14.5 };

/** Render a small markdown subset to React elements. No external deps. */
export function MiniMarkdown({ source, fontSize = 13 }: { source: string; fontSize?: number }): React.ReactElement {
  const blocks = parseBlocks(source);

  if (blocks.length === 0) {
    return <p style={{ fontSize: 12.5, color: "#62666d", fontStyle: "italic", margin: 0 }}>(empty)</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {blocks.map((block, idx) => {
        const key = `block-${idx}`;
        if (block.type === "heading") {
          return (
            <div key={key} style={{ fontSize: headingSize[block.level], fontWeight: 590, color: "#f7f8f8", margin: 0 }}>
              {renderInline(block.text, key)}
            </div>
          );
        }
        if (block.type === "code") {
          return (
            <pre
              key={key}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 5,
                padding: "8px 10px",
                fontSize: 12,
                overflow: "auto",
                margin: 0,
                fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
              }}
            >
              {block.text}
            </pre>
          );
        }
        if (block.type === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag key={key} style={{ margin: 0, paddingLeft: 20, fontSize, color: "#d0d6e0", lineHeight: 1.65 }}>
              {block.items.map((item, itemIdx) => (
                <li key={`${key}-item-${itemIdx}`}>{renderInline(item, `${key}-${itemIdx}`)}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={key} style={{ margin: 0, fontSize, color: "#d0d6e0", lineHeight: 1.65 }}>
            {renderInline(block.text, key)}
          </p>
        );
      })}
    </div>
  );
}
