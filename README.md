# Slack GitHub MCP Bot

A Slack bot that answers natural language questions about your GitHub repository using **AWS Bedrock (Claude)** and **GitHub's official MCP server**.

Ask it anything in Slack:
- `@bot what bugs are open?`
- `@bot which PRs have been waiting for review the longest?`
- `@bot were any critical issues opened after last week's merges?`

The bot also posts a structured **morning summary** to a Slack channel every day at 9 AM.

---

## How It Works

```
Slack (@mention)
      ↓
AWS Bedrock — Claude (Agent Loop)
      ↓
MCP Servers (GitHub + any other)
      ↓
Tool results → reasoning → answer → Slack
```

Claude receives all available GitHub tools at startup. When a question arrives, it decides which tools to call, calls them, reads the results, and loops until it has enough to answer. Your code never routes a question — Claude handles that.

---

## Prerequisites

- Node.js 18+ (required for global `fetch`), **or** Docker / Docker Compose
- AWS account with Bedrock access and Claude Sonnet 4.6 enabled
- GitHub account with a repository to query
- Slack workspace where you can install apps

---

## Setup

### 1. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From Scratch
2. **Settings → Socket Mode → Enable** — create an App-Level Token with `connections:write` scope (this is your `SLACK_APP_TOKEN`)
3. **OAuth & Permissions → Bot Token Scopes** — add:
   ```
   app_mentions:read   chat:write   chat:write.public   im:history   im:write
   ```
4. **Event Subscriptions → Enable → Subscribe to Bot Events** — add `app_mention` and `message.im`
5. **OAuth & Permissions → Install to Workspace** — copy the Bot User OAuth Token
6. Copy the **Signing Secret** from Basic Information

### 2. Create a GitHub Fine-Grained Token

1. github.com → **Settings → Developer Settings → Personal access tokens → Fine-grained tokens**
2. Select your target repository
3. Repository permissions: `Issues (Read)`, `Pull requests (Read)`, `Contents (Read)`, `Metadata (Read)`

### 3. Create a Bedrock API Key

1. AWS Console → **Amazon Bedrock → Model access** → Enable Claude Sonnet 4.6
2. **Bedrock → API keys → Create API key**

> **Important:** Claude 4.x requires the `us.` cross-region inference profile prefix.  
> Use `us.anthropic.claude-sonnet-4-6` — **not** `anthropic.claude-sonnet-4-6`.  
> The bare ID returns: *"on-demand throughput isn't supported"*

### 4. Configure and Run

```bash
cp .env.example .env
# Fill in all values in .env

yarn install
yarn start
# Bot ready — 44 tools loaded
```

### 5. Invite to a Channel

```
/invite @your-bot-name
```

---

## Docker

The bot uses Slack Socket Mode, so it only needs outbound HTTPS access — no ports are exposed.

### Configure

```bash
cp .env.example .env
# Fill in all values in .env
```

### Run (production)

```bash
docker compose up --build -d
docker compose logs -f bot
```

### Run (development with live reload)

```bash
docker compose --profile dev up --build bot-dev
```

### One-off morning summary

```bash
docker compose run --rm bot --summary
```

### Stop

```bash
docker compose down
```

---

## Morning Summary

If `SUMMARY_CHANNEL_ID` is set in `.env`, the bot posts a daily summary at 9 AM covering:
- Active release PRs grouped by environment (DEV/STG/PROD)
- Yesterday's activity (PRs merged/opened, issues closed/opened)
- New bugs filed in the last 24h, classified by severity
- Unassigned critical/major bugs flagged for attention

**Test it immediately:**
```bash
yarn summary
```

---

## Adding More MCP Servers

The tool registry pattern means adding a new data source is 4 lines in `index.js`:

```js
// In the startup block, after loadServer(GITHUB_MCP_URL, githubHeaders):
const myHeaders = {
  Authorization:  `Bearer ${process.env.MY_SERVICE_TOKEN}`,
  'Content-Type': 'application/json',
  Accept:         'application/json, text/event-stream',
};
await loadServer(process.env.MY_SERVICE_MCP_URL, myHeaders);
// Then add routing guidance to systemPrompt() describing when to use the new tools.
```

Available MCP servers:

| Service    | URL                        | Adds                              |
|------------|----------------------------|-----------------------------------|
| Linear     | `mcp.linear.app/mcp`       | Issues, projects, cycles          |
| Cloudflare | `mcp.cloudflare.com/mcp`   | Workers, analytics, DNS, R2       |
| Stripe     | `mcp.stripe.com/mcp`       | Payments, customers, subscriptions|
| Custom     | `@modelcontextprotocol/sdk`| Wrap any REST API as MCP tools    |

---

## Tuning the System Prompt

The system prompt in `systemPrompt()` is the highest-leverage variable. Key rules to keep:

- **Explicit mrkdwn syntax** — `*bold*` not `**bold**`, `<url|text>` not `[text](url)`
- **GitHub link format** — `<https://github.com/ORG/REPO/issues/N|#N>` makes issue numbers clickable
- **High-volume rule** — when >15 results, summarise by category and show top 10
- **Tool routing** — when using multiple MCP servers, tell Claude which questions map to which server
- **Emoji vocabulary** — define a consistent set so all responses look coherent

---

## Observability

Every tool call is logged to stdout as structured JSON:

```json
{
  "event": "tool_call",
  "tool": "search_issues",
  "input": { "q": "repo:org/repo is:open label:bug" },
  "result": { ... },
  "ts": "2026-04-10T09:00:00.000Z"
}
```

Ship these logs to Datadog, CloudWatch, or Grafana. Tool call frequency, latency, and error rate are the key metrics for monitoring agent health.

---

## Models

| Model           | `BEDROCK_MODEL_ID`                         | Notes                          |
|-----------------|--------------------------------------------|--------------------------------|
| Sonnet 4.6      | `us.anthropic.claude-sonnet-4-6`           | Recommended — fast and capable |
| Opus 4.6        | `us.anthropic.claude-opus-4-6-v1`          | Best reasoning, slower         |
| Haiku 4.5       | `us.anthropic.claude-haiku-4-5-20251001`   | Fastest, most cost-efficient   |

---

## Known Constraints

- **Latency** — complex queries take 10–30 seconds. The thinking-indicator pattern mitigates the UX impact.
- **Debugging** — non-deterministic reasoning is harder to trace than deterministic code. Use the tool call logs.
- **Cost** — 8 tool calls per query costs more than a single API response. Monitor at scale.
- **Prompt dependency** — poor prompt design causes wrong tool selection and bad formatting. Test iteratively.

---

## Project Structure

```
index.js            — Slack handlers, agent loop, MCP client, tool registry, scheduler
package.json
.yarnrc.yml
yarn.lock
Dockerfile
docker-compose.yml
.env.example
.gitignore
README.md
```

---

## License

MIT
