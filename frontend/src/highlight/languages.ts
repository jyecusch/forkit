import type { Parser } from "@lezer/common"

/** Something that turns source text into a syntax tree carrying highlight tags. */
export interface Language {
  readonly parse: Parser["parse"]
}

type Loader = () => Promise<Language>

/** Stream-mode languages run through CodeMirror's adapter, loaded only when needed. */
const legacy = (load: () => Promise<Parameters<typeof import("@codemirror/language").StreamLanguage.define>[0]>): Loader => async () => {
  const [{ StreamLanguage }, mode] = await Promise.all([import("@codemirror/language"), load()])
  return StreamLanguage.define(mode).parser
}

const javascript = (dialect: string): Loader => async () => (await import("@lezer/javascript")).parser.configure({ dialect })

/** Every language highlighted, by name; each loads on first use. */
const loaders = {
  javascript: javascript("jsx"),
  typescript: javascript("ts"),
  tsx: javascript("ts jsx"),
  python: async () => (await import("@lezer/python")).parser,
  rust: async () => (await import("@lezer/rust")).parser,
  go: async () => (await import("@lezer/go")).parser,
  css: async () => (await import("@lezer/css")).parser,
  scss: async () => (await import("@lezer/sass")).parser,
  html: async () => (await import("@lezer/html")).parser,
  json: async () => (await import("@lezer/json")).parser,
  markdown: async () => (await import("@lezer/markdown")).parser,
  java: async () => (await import("@lezer/java")).parser,
  cpp: async () => (await import("@lezer/cpp")).parser,
  php: async () => (await import("@lezer/php")).parser,
  xml: async () => (await import("@lezer/xml")).parser,
  yaml: async () => (await import("@lezer/yaml")).parser,
  sql: async () => (await import("@codemirror/lang-sql")).StandardSQL.language.parser,
  shell: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  toml: legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml),
  dockerfile: legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
  ruby: legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby),
  swift: legacy(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift),
  kotlin: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin),
  csharp: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp),
  scala: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).scala),
  dart: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).dart),
  lua: legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua),
  perl: legacy(async () => (await import("@codemirror/legacy-modes/mode/perl")).perl),
  r: legacy(async () => (await import("@codemirror/legacy-modes/mode/r")).r),
  protobuf: legacy(async () => (await import("@codemirror/legacy-modes/mode/protobuf")).protobuf),
  powershell: legacy(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
  properties: legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties),
  nginx: legacy(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx),
} satisfies Record<string, Loader>

export type LanguageName = keyof typeof loaders

const byExtension: Record<string, LanguageName> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  py: "python", pyi: "python",
  rs: "rust",
  go: "go",
  css: "css", scss: "scss", sass: "scss", less: "scss",
  html: "html", htm: "html", vue: "html", svelte: "html",
  json: "json", jsonc: "json", json5: "json",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  java: "java",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "cpp", mm: "cpp",
  php: "php",
  xml: "xml", svg: "xml", plist: "xml", xaml: "xml", csproj: "xml",
  yml: "yaml", yaml: "yaml",
  sql: "sql",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  toml: "toml",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  cs: "csharp",
  scala: "scala", sc: "scala",
  dart: "dart",
  lua: "lua",
  pl: "perl", pm: "perl",
  r: "r",
  proto: "protobuf",
  ps1: "powershell", psm1: "powershell",
  properties: "properties", ini: "properties", cfg: "properties", conf: "properties", env: "properties",
}

const byFileName: Record<string, LanguageName> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  "nginx.conf": "nginx",
  "go.mod": "go",
  "bun.lock": "json",
  "cargo.lock": "toml",
  "go.sum": "properties",
  ".gitconfig": "properties",
  ".editorconfig": "properties",
}

/** The language of a file, from its name, or undefined when it is not highlighted. */
export const languageOf = (path: string): LanguageName | undefined => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  if (name in byFileName) return byFileName[name]
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile"
  if (name.startsWith(".env")) return "properties"
  const dot = name.lastIndexOf(".")
  return dot > 0 ? byExtension[name.slice(dot + 1)] : undefined
}

const loaded = new Map<LanguageName, Promise<Language>>()

/** Loads a language's parser once, sharing it between requests. */
export const loadLanguage = (name: LanguageName): Promise<Language> => {
  let language = loaded.get(name)
  if (!language) {
    language = loaders[name]()
    loaded.set(name, language)
  }
  return language
}
