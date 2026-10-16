// qrcode-terminal ships no types. Minimal ambient declaration.
declare module 'qrcode-terminal' {
  export function generate(text: string, options?: { small?: boolean; error?: 'low' | 'medium' | 'quarantine' }): void;
  const _default: { generate: typeof generate };
  export default _default;
}
