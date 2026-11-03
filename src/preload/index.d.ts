export {}

declare global {
  interface Window {
    api: Readonly<Record<string, never>>
  }
}
