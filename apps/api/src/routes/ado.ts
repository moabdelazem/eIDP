import { Hono } from 'hono'
import { ApiError } from '../lib/errors.ts'
import { requireAuth, type AppEnv } from '../middleware/auth.ts'
import { adoConfig, listCollections, listProjects } from '../integrations/ado/index.ts'

/** What the request form needs to offer choices rather than free text. */
export const adoRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/collections', async (c) => {
    const { defaultCollection } = adoConfig()
    let names: string[]
    try {
      names = (await listCollections()).map(({ name }) => name)
    } catch (err) {
      // Listing collections is a server-level call. A PAT scoped to one
      // collection is refused there, which is a common and reasonable setup —
      // so offer the collection we can reach rather than failing the form.
      const code = err instanceof ApiError ? err.code : ''
      if (code !== 'ado_forbidden' && code !== 'ado_not_authenticated') throw err
      console.warn(`ado: cannot list collections (${code}); offering ${defaultCollection} only`)
      names = [defaultCollection]
    }
    return c.json({
      collections: names.sort((a, b) => a.localeCompare(b)),
      // Preselected in the form: the collection the portal already reads.
      defaultCollection,
      // Lets the form show the exact clone URL before anything is created.
      serverUrl: adoConfig().serverUrl,
    })
  })

  .get('/collections/:collection/projects', async (c) => {
    const projects = await listProjects(c.req.param('collection'))
    return c.json(
      projects
        .map(({ name, description }) => ({ name, description: description ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  })
