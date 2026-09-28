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
