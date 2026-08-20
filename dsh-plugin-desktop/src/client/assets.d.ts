declare module 'katex/dist/katex.min.css'

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
