import Anthropic from "@anthropic-ai/sdk"
import { SYSTEM_PROMPT, TOOL_DEFINITIONS } from "./prompts.js"
import {
	createBrowserSession,
	releaseBrowserSession,
	searchWeb,
	visitPage,
	type BrowserSession,
	type SearchProvider,
} from "./tools.js"
import type { ProgressEvent, Source } from "../../shared/types.js"

interface ResearchResult {
	report: string
	sources: Source[]
}

export async function runResearch(
	question: string,
	steel_api_key: string,
	anthropic_api_key: string,
	emit: (event: ProgressEvent) => void,
	search_provider: SearchProvider = "duckduckgo",
): Promise<ResearchResult> {
	const anthropic = new Anthropic({ apiKey: anthropic_api_key })

	let bs: BrowserSession | null = null

	try {
		bs = await createBrowserSession(steel_api_key)

		emit({
			type: "session_created",
			steel_session_id: bs.session.id,
			session_viewer_url: bs.session.sessionViewerUrl,
			debug_url: bs.session.debugUrl,
		})

		const messages: Anthropic.MessageParam[] = [
			{ role: "user", content: question },
		]

		let page_count = 0
		const max_pages = 3
		const max_iterations = 10

		for (let i = 0; i < max_iterations; i++) {
			const response = await anthropic.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 4096,
				system: SYSTEM_PROMPT,
				tools: TOOL_DEFINITIONS,
				messages,
			})

			const content_blocks = response.content

			messages.push({ role: "assistant", content: content_blocks })

			for (const block of content_blocks) {
				if (block.type === "text" && block.text.trim()) {
					emit({ type: "thinking", thought: block.text.trim().slice(0, 200) })
				}
			}

			const tool_uses = content_blocks.filter(
				(b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
			)

			if (tool_uses.length === 0) {
				const text = content_blocks
					.filter((b): b is Anthropic.TextBlock => b.type === "text")
					.map((b) => b.text)
					.join("\n")

				return { report: text || "Research complete but no report generated.", sources: [] }
			}

			// Check for finish_research first (early exit)
			const finish_call = tool_uses.find(t => t.name === "finish_research")
			if (finish_call) {
				const input = finish_call.input as Record<string, unknown>
				const report = (input.report as string) || ""
				const sources = (input.sources as Source[]) || []
				emit({ type: "report_ready", report, sources })
				return { report, sources }
			}

			// Separate search and visit calls
			const search_calls = tool_uses.filter(t => t.name === "search_google")
			const visit_calls = tool_uses.filter(t => t.name === "visit_page")

			// Execute searches sequentially (they use the browser)
			const tool_results: Anthropic.ToolResultBlockParam[] = []

			for (const tool_use of search_calls) {
				const input = tool_use.input as Record<string, unknown>
				const query = input.query as string
				emit({ type: "searching", query })
				const result = await searchWeb(bs!, query, search_provider)
				tool_results.push({
					type: "tool_result",
					tool_use_id: tool_use.id,
					content: result,
				})
			}

			// Execute ALL page visits in parallel (scrape API doesn't need browser)
			if (visit_calls.length > 0) {
				for (const tool_use of visit_calls) {
					const input = tool_use.input as Record<string, unknown>
					page_count++
					emit({ type: "visiting", url: input.url as string, reason: input.reason as string })
				}
				emit({ type: "reading", url: "", page_number: page_count, total: max_pages })

				const visit_results = await Promise.all(
					visit_calls.map(async (tool_use) => {
						const input = tool_use.input as Record<string, unknown>
						const url = input.url as string
						const content = await visitPage(bs!, url)
						return {
							type: "tool_result" as const,
							tool_use_id: tool_use.id,
							content: `Content from ${url}:\n\n${content}`,
						}
					}),
				)

				tool_results.push(...visit_results)
			}

			messages.push({ role: "user", content: tool_results })

			if (page_count >= max_pages) {
				messages.push({
					role: "user",
					content: `You have visited ${max_pages} pages. Please synthesize your findings now and call finish_research.`,
				})
			}
		}

		return {
			report: "Research timed out. Partial results may be available.",
			sources: [],
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"
		emit({ type: "error", message })
		throw error
	} finally {
		if (bs) {
			await releaseBrowserSession(bs)
		}
	}
}
