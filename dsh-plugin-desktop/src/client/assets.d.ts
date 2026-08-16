declare module 'katex/dist/katex.min.css'

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
