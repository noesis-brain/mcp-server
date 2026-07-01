---
description: Manage Daily News preferences on Noesis — add/remove sources, analyze preferences, discover new feeds. Use when the user says 'manage news', 'news preferences', 'add news source', 'find RSS feeds', or wants to manage their Daily News tool configuration via natural language.
argument-hint: "<natural language instruction about news preferences>"
---

# /noesis-manage-news — Manage Daily News Preferences

You are executing the `/noesis-manage-news` slash command. This is a **natural-language, prompt-driven** skill for managing the user's Daily News preferences in Noesis via MCP tools.

## Arguments

$ARGUMENTS

## Available MCP Tools

You have access to these Noesis MCP tools:
- `mcp__noesis__get_news_preferences` — Read current preferences (topics, sources, seeds, weights, language, daily limit)
- `mcp__noesis__update_news_preferences` — Update preferences (language, daily limit, topic/source weights)
- `mcp__noesis__add_news_source` — Add an RSS feed source (name, URL, topic, language)

## Instructions

Parse the user's natural language intent and dispatch to the appropriate MCP tools. Common intents:

### "Add this news URL" / "I like this article"
1. Extract the domain from the URL
2. Use web search to find the RSS feed for that domain (search for `"{domain}" RSS feed URL`)
3. Call `add_news_source` with the discovered feed URL, domain name, and an appropriate topic category
4. Report what was added

### "Summarize my preferences" / "What am I reading?"
1. Call `get_news_preferences`
2. Present a human-readable summary: top topics by weight, active sources, language, daily limit
3. Highlight any topics or sources with very low weights (< 0.2) that might need attention

### "Remove topic X" / "I don't like X anymore"
1. Call `get_news_preferences` to get current state
2. Identify matching topics and sources
3. Call `update_news_preferences` to set the topic weight to 0 and/or remove related source weights
4. Report what was changed

### "Find RSS feeds about [topic]" / "Add [topic] news"
1. Use web search to find reputable RSS feeds for the topic (search for `"{topic}" RSS feed`, `"{topic}" news RSS`)
2. Validate discovered URLs are actual RSS feeds
3. Call `add_news_source` for each valid feed
4. Report what was added

### "Change language to [X]"
1. Call `update_news_preferences` with the new `preferred_language`
2. Suggest that existing sources may not match the new language

### "Set daily limit to N"
1. Call `update_news_preferences` with the new `daily_article_limit`

## Language Awareness

When adding sources or searching for feeds, respect the user's preferred language (check via `get_news_preferences` if not specified). Search for feeds in that language. Common language codes: `en`, `zh-TW`, `zh-CN`, `ja`, `ko`, `fr`, `de`, `es`.

## Response Style

- Be concise — report what you did, not how you did it
- After making changes, show a brief summary of the updated state
- If the user's intent is ambiguous, ask for clarification before making changes

## Examples

User: "I like this news https://arstechnica.com/tech-policy/2026/04/eu-ai-act/"
Action: Search for Ars Technica RSS feed, add it as a source with topic "Technology"

User: "What are my news preferences?"
Action: Call get_news_preferences, present summary

User: "Find me some Japanese tech news feeds"
Action: Web search for Japanese tech RSS feeds, add discovered feeds with language "ja"

User: "Remove the World Politics topic"
Action: Get preferences, set World Politics weight to 0, report change

User: "I want 30 articles per day"
Action: Update daily_article_limit to 30
