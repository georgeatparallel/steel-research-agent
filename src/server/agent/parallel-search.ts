import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"

export async function searchParallel(
	query: string,
	session_id: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
	// Bound the whole operation, including connection setup and response reading.
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 15000)
	const signal = options.signal
		? AbortSignal.any([options.signal, deadline])
		: deadline
	signal.throwIfAborted()

	const client = new Client({ name: "steel-research-agent", version: "1.0.0" })
	const transport = new StreamableHTTPClientTransport(
		new URL("https://search.parallel.ai/mcp"),
		{
			requestInit: { headers: { "User-Agent": "steel-research-agent/1.0.0" } },
			fetch: (url, init) => fetch(url, {
				...init,
				signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
			}),
		},
	)

	try {
		await client.connect(transport, { signal })
		const result = CallToolResultSchema.parse(await client.callTool({
			name: "web_search",
			arguments: {
				objective: query,
				search_queries: [query],
				session_id,
				model_name: "claude-sonnet-4-6",
			},
		}, undefined, { signal }))
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n")
		if (result.isError) {
			throw new Error(`Parallel search failed: ${text || "Unknown tool error"}`)
		}
		if (!text.trim()) {
			throw new Error("Parallel search returned no text results.")
		}
		return text
	} finally {
		await client.close()
	}
}
