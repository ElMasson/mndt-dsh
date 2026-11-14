/**
 * The PNG artwork the client bundle inlines (`dsh-image-inline`): the default export is the data
 * URL a component assigns to `img.src`. The package-wide `*.png` form, as in ui-brand-mndt.
 */
declare module '*.png' {
  const dataUrl: string
  export default dataUrl
}
