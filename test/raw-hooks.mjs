import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?raw')) {
    const bare = specifier.slice(0, -'?raw'.length)
    const resolved = await next(bare, context)
    return { ...resolved, url: `${resolved.url}?raw`, format: 'module', shortCircuit: true }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.endsWith('?raw')) {
    const text = await readFile(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)}`
    }
  }
  return next(url, context)
}
