import { Plugin } from "@opencode/plugin"
import { NAMESPACE, NAMESPACE_DESCRIPTION, TOOLS, executeTool } from "./tools.ts"

export default Plugin.define({
  id: "hunk",
  async setup(ctx) {
    const bin = typeof ctx.options.bin === "string" && ctx.options.bin ? ctx.options.bin : undefined
    const timeoutMs = typeof ctx.options.timeoutMs === "number" ? ctx.options.timeoutMs : undefined
    const directory = String(ctx.location.directory)

    const registration = await ctx.tool.transform((editor) => {
      editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION })
      for (const spec of TOOLS) {
        editor.add({
          name: spec.name,
          description: spec.description,
          input: spec.schema,
          options: spec.permission ? { namespace: NAMESPACE, permission: spec.permission } : { namespace: NAMESPACE },
          execute: async (input, context) => ({
            content: await executeTool(spec, input, { bin, directory, timeoutMs }, context.signal),
          }),
        })
      }
    })

    return () => registration.dispose()
  },
})
