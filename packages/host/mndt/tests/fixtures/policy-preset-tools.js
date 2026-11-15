// A preset row standing in for the tools a real preset mounts on the agent
// plane: a shell, two connectors' tools and the approvals tool. Every execution
// is recorded, so a test can prove which calls actually ran.
// Import-free on purpose: the Loader resolves it through Node's ESM resolver.
export const name = 'policy-preset-tools'
export const inject = ['tools']

export function apply(ctx, config) {
  const ran = (globalThis.__mndtPolicyRan ??= [])
  for (const tool of config.tools) {
    ctx.effect(() => ctx.tools.register({
      name: tool,
      description: `fixture tool ${tool}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => { ran.push(tool); return Promise.resolve(`${tool} ran`) },
    }))
  }
}
