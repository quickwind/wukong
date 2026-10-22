// Irix: expo-clipboard ships untranspiled JSX that vitest cannot parse; the plugin Markdown
// export pulls it in through the markdown renderer.
export async function setStringAsync(): Promise<boolean> {
  return true;
}
