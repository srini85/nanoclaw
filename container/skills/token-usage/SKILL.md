---
name: token-usage
description: Report token usage statistics. Use when the user asks about token consumption, API usage, costs, or how much they've used over a time period.
---

# /usage — Token Usage Report

When the user asks about token usage, consumption, or costs, use the `get_token_usage` MCP tool.

## How to handle requests

1. **Parse the time window** from the user's message:
   - "last 15 minutes" → `minutes: 15`
   - "today" → `minutes: 1440` (or calculate from midnight)
   - "last hour" → `minutes: 60`
   - "this week" → `minutes: 10080`
   - No time specified → omit `minutes` to get all available data

2. **Call the tool:**
   ```
   mcp__nanoclaw__get_token_usage with { minutes: N }
   ```

3. **Present the results** clearly:

```
📊 *Token Usage — last {period}*

• Runs: {total_runs}
• Input tokens: {total_input_tokens}
• Output tokens: {total_output_tokens}
• Total tokens: {input + output}
• Cache hits: {total_cache_hit_tokens}
• Avg turns/run: {total_turns / total_runs}
• Total time: {duration formatted}

*Breakdown:*
• Interactive: X runs, Y tokens
• Scheduled: X runs, Y tokens
```

4. Format large numbers with commas (e.g., 1,234,567).
5. Convert duration_ms to human-readable format (e.g., "2m 30s").
6. If the user asks about cost, note that cost tracking is not yet implemented — only token counts are available.
