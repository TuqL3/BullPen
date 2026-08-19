/**
 * A markdown file imported for its text.
 *
 * `workflow-format.md` is the reference the dialog renders and the generator is
 * briefed with; both bundles inline it this way, and a test reads the same file
 * off disk instead. Vite resolves `?raw`; TypeScript needs telling.
 */
declare module '*.md?raw' {
  const content: string
  export default content
}
