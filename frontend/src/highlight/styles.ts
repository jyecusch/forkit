/**
 * The kinds of token coloured, each a CSS class with a colour from the
 * theme. Order matters: a token's encoded style is its index here. Kept apart
 * from the parsers, which load only in the highlighting worker.
 */
export const syntaxStyles = [
  "keyword",
  "string",
  "number",
  "comment",
  "function",
  "type",
  "property",
  "tag",
  "attribute",
  "constant",
  "regexp",
  "meta",
  "heading",
  "emphasis",
  "strong",
  "link",
] as const

export type SyntaxStyle = (typeof syntaxStyles)[number]

/** Each token takes four numbers: line, start column, end column and style. */
export const tokenStride = 4
