import type { HighlighterCore } from 'shiki/core'

export type Language = 'json' | 'yaml'

let highlighter: Promise<HighlighterCore> | null = null

/**
 * Shiki, loaded on first use and shared after. It is imported piece by piece —
 * the core, two grammars, the JavaScript regex engine — so the bundle carries
 * JSON and YAML rather than every language Shiki knows, and no WebAssembly.
 * Nothing here is in the main bundle; a page without a code view never loads it.
 *
 * Colours come from CSS variables (`--shiki-*` in index.css) rather than a
 * stock theme, so highlighting follows the portal's palette.
 */
export function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }, json, yaml] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/yaml.mjs'),
      ])
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: 'portal', variablePrefix: '--shiki-', fontStyle: true })],
      langs: [json.default, yaml.default],
      engine: createJavaScriptRegexEngine(),
    })
  })().catch((err) => {
    highlighter = null // let a later view try again
    throw err
  })
  return highlighter
}

/** Highlighted HTML. Shiki escapes every token, so user text cannot inject markup. */
export async function highlight(code: string, lang: Language): Promise<string> {
  return (await getHighlighter()).codeToHtml(code, { lang, theme: 'portal' })
}

/**
 * The languages a chat answer's code blocks may be in, each its own chunk,
 * fetched the first time a block in it appears. Spelled out one by one so the
 * bundler can split them; a language not listed is shown plain.
 */
const MORE: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
}

const ALIAS: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  jenkinsfile: 'groovy', dockerfile: 'docker', yml: 'yaml', cs: 'csharp', py: 'python',
  properties: 'ini', toml: 'ini', ps: 'powershell', ps1: 'powershell', html: 'xml',
}

/** The language a fence names, as Shiki knows it — or null when it is not one we highlight. */
export function languageOf(fence: string): string | null {
  const name = ALIAS[fence.toLowerCase()] ?? fence.toLowerCase()
  return name === 'json' || name === 'yaml' || name in MORE ? name : null
}

const loading = new Map<string, Promise<void>>()

/** Highlighted HTML for a code block in any language `languageOf` accepts; escaped by Shiki, like `highlight`. */
export async function highlightCode(code: string, language: string): Promise<string> {
  const h = await getHighlighter()
  if (!h.getLoadedLanguages().includes(language)) {
    let pending = loading.get(language)
    if (!pending) {
      pending = MORE[language]!().then((mod) => h.loadLanguage(mod.default as Parameters<HighlighterCore['loadLanguage']>[0]))
      loading.set(language, pending)
    }
    await pending
  }
  return h.codeToHtml(code, { lang: language, theme: 'portal' })
}
