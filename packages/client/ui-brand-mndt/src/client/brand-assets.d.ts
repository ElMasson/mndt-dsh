/**
 * Type declaration for the mndt brand artwork the client bundle inlines.
 *
 * The UI-plugin client preset turns a PNG import into a base64 data URL inside
 * the plugin's own bundle (`dsh-image-inline`), so the module's default export
 * is the URL string the components assign to `img.src`.
 *
 * The pattern is the package-wide `*.png` form rather than one declaration per
 * file: ambient module declarations are matched against the specifier as
 * written, and a relative declaration such as `../assets/x.png` is not
 * consulted for a relative import.
 */
declare module '*.png' {
  const dataUrl: string
  export default dataUrl
}
