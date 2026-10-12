import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight"
import type { Language } from "./languages"
import { syntaxStyles } from "./styles"

const highlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], class: "keyword" },
  { tag: [t.string, t.special(t.string), t.character, t.docString], class: "string" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], class: "number" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "comment" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName],
    class: "function",
  },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.standard(t.typeName)], class: "type" },
  { tag: [t.propertyName, t.definition(t.propertyName)], class: "property" },
  { tag: [t.tagName, t.angleBracket], class: "tag" },
  { tag: [t.attributeName], class: "attribute" },
  { tag: [t.constant(t.name), t.standard(t.variableName), t.labelName], class: "constant" },
  { tag: [t.regexp, t.escape, t.special(t.regexp)], class: "regexp" },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], class: "meta" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: "heading" },
  { tag: [t.emphasis], class: "emphasis" },
  { tag: [t.strong], class: "strong" },
  { tag: [t.link, t.url], class: "link" },
])

const styleIndex = new Map<string, number>(syntaxStyles.map((style, i) => [style, i]))

/**
 * Highlights text and lists its tokens line by line, as [line, from, to,
 * style] quads with zero-based lines and columns. A token that spans lines,
 * such as a block comment, is split into one per line.
 */
export const highlightLines = (language: Language, text: string): Int32Array => {
  const lineStarts = [0]
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1)

  const out: Array<number> = []
  let line = 0
  highlightTree(language.parse(text), highlighter, (from, to, classes) => {
    // Several tags can match; the first is the most specific.
    const style = styleIndex.get(classes.split(" ")[0]!)
    if (style === undefined) return
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= from) line++
    for (let at = line, start = from; start < to; at++) {
      const lineEnd = at + 1 < lineStarts.length ? lineStarts[at + 1]! - 1 : text.length
      const end = Math.min(to, lineEnd)
      if (end > start) out.push(at, start - lineStarts[at]!, end - lineStarts[at]!, style)
      start = lineEnd + 1
    }
  })
  return Int32Array.from(out)
}
