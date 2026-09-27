import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './lib/config.ts'

serve({ fetch: createApp().fetch, port: config.PORT })
console.log(`api on http://localhost:${config.PORT}`)
