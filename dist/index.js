import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setupLangfuseTracer } from "./src/tracer.js";
export default definePluginEntry({
    id: "langfuse-tracer",
    name: "Langfuse Tracer",
    description: "Export agent traces to self-hosted Langfuse for observability",
    register(api) {
        setupLangfuseTracer(api);
    },
});
//# sourceMappingURL=index.js.map