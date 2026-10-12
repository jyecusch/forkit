import { describe, expect, it } from "vitest"
import { languageOf, loadLanguage } from "./languages"
import { syntaxStyles, tokenStride } from "./styles"
import { highlightLines } from "./tokens"

/** Renders tokens as "line:text=style" for readable assertions. */
const describeTokens = (text: string, tokens: Int32Array) => {
  const lines = text.split("\n")
  const out: Array<string> = []
  for (let i = 0; i < tokens.length; i += tokenStride) {
    const [line, from, to, style] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!, tokens[i + 3]!]
    out.push(`${line}:${lines[line]!.slice(from, to)}=${syntaxStyles[style]}`)
  }
  return out
}

describe("highlightLines", () => {
  it("colours tokens by kind, with positions per line", async () => {
    const text = 'const greet = (name: string) => format("hi")\n// done'
    const tokens = describeTokens(text, highlightLines(await loadLanguage("typescript"), text))
    expect(tokens).toEqual(
      expect.arrayContaining(["0:const=keyword", "0:string=type", '0:"hi"=string', "0:format=function", "1:// done=comment"]),
    )
  })

  it("splits a token that spans lines into one per line", async () => {
    const text = "a = 1\n/* first\nsecond */\nb = 2"
    const tokens = describeTokens(text, highlightLines(await loadLanguage("javascript"), text))
    expect(tokens).toEqual(expect.arrayContaining(["1:/* first=comment", "2:second */=comment"]))
  })
})

describe("languageOf", () => {
  it("knows files by extension and by name", () => {
    expect(languageOf("src/app.tsx")).toBe("tsx")
    expect(languageOf("internal/repo/diff.go")).toBe("go")
    expect(languageOf("build/Dockerfile")).toBe("dockerfile")
    expect(languageOf(".env.local")).toBe("properties")
    expect(languageOf("notes")).toBeUndefined()
  })
})
