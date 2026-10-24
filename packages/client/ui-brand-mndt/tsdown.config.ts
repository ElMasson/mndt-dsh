import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  import.meta.dirname,
  ['lib/types/index.js'],
  {
    lib: {
      copy: [{
        from: 'src/styles/{tokens.css,brand-font.css,inter-*.woff2,space-grotesk-*.woff2,Inter-OFL.txt,SpaceGrotesk-OFL.txt}',
        to: 'lib/styles',
      }],
    },
  },
)
