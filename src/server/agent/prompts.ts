import type Anthropic from "@anthropic-ai/sdk"

export const SYSTEM_PROMPT = `You are a deep research agent. You have access to a web browser through tools.

Your goal: Answer the user's research question with a thorough, well-cited report.

Strategy:
1. Search for the most relevant query
2. From the results, call visit_page on 3 pages AT ONCE (batch your tool calls in a single response)
3. After reading all pages, immediately call finish_research
4. Complete in exactly 2 rounds: search -> visit 3 pages -> finish

CRITICAL PERFORMANCE RULE:
- You CAN and SHOULD call multiple tools in a single response
- After seeing search results, call visit_page 3 times simultaneously, NOT one at a time
- This makes research much faster

Rules:
- Every factual claim MUST cite its source URL using [N] notation
- Maximum 3 page visits total -- be selective, pick the best 3
- Be thorough but concise
- Structure the report with clear headings
- Include a numbered Sources section at the end
- Focus on recent, authoritative sources
- If a page's content is not useful, move on quickly`

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
	{
		name: "search_google",
		description: "Search the web for information. Returns search results with source URLs and relevant excerpts.",
		input_schema: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "The web search query",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "visit_page",
		description: "Visit a webpage and extract its content as markdown. Use this to read articles, blog posts, documentation, etc.",
		input_schema: {
			type: "object" as const,
			properties: {
				url: {
					type: "string",
					description: "The URL of the page to visit",
				},
				reason: {
					type: "string",
					description: "Brief reason for visiting this page (shown in activity feed)",
				},
			},
			required: ["url", "reason"],
		},
	},
	{
		name: "finish_research",
		description: "Call this when you have gathered enough information. Provide the final research report with citations.",
		input_schema: {
			type: "object" as const,
			properties: {
				report: {
					type: "string",
					description: "The final research report in markdown format with [N] citations",
				},
				sources: {
					type: "array",
					items: {
						type: "object",
						properties: {
							url: { type: "string" },
							title: { type: "string" },
						},
						required: ["url", "title"],
					},
					description: "Numbered list of sources cited in the report",
				},
			},
			required: ["report", "sources"],
		},
	},
]
