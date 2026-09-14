// Subset of vite/client typings needed when client asset code is type-checked from tools/.
interface ImportMeta {
  readonly env?: { readonly BASE_URL: string };
}
