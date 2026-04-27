require('dotenv').config();
const { App }    = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

// ── Config ─────────────────────────────────────────────────────────────────────
const ORG             = process.env.GITHUB_ORG;
const REPO            = process.env.GITHUB_REPO;
const MODEL           = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-6';
const SUMMARY_CHANNEL = process.env.SUMMARY_CHANNEL_ID;

const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const githubHeaders  = {
  Authorization:  `Bearer ${process.env.GITHUB_TOKEN}`,
  'Content-Type': 'application/json',
  Accept:         'application/json, text/event-stream',
};

// ── Clients ────────────────────────────────────────────────────────────────────
const slack = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode:    true,
  appToken:      process.env.SLACK_APP_TOKEN,
});
const slackWeb = new WebClient(process.env.SLACK_BOT_TOKEN);
const bedrock  = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  token:  { token: process.env.AWS_BEARER_TOKEN_BEDROCK },
});

// ── MCP request ─────────────────────────────────────────────────────────────────
// Handles both SSE (GitHub MCP) and plain JSON responses.
// Checks HTTP status and surfaces MCP-level errors cleanly.
async function mcpRequest(method, params, endpoint, headers) {
  const res = await fetch(endpoint, {
    method:  'POST',
    headers: headers,
    body:    JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MCP ${res.status} ${res.statusText}: ${body}`);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    let result = null;
    for (const line of (await res.text()).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const p = JSON.parse(line.slice(6));
        if (p.result !== undefined) result = p.result;
        if (p.error)                throw new Error(JSON.stringify(p.error));
      } catch {}
    }
    return result;
  }

  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

// ── Tool registry ────────────────────────────────────────────────────────────────
// Maps tool name → { url, headers } so calls are routed to the correct MCP server.
// To add a new MCP server: call loadServer() with its URL + auth headers.
// The agent loop below never changes.
const registry = {};
let   allTools = [];

async function loadServer(url, headers) {
  const list = await mcpRequest('tools/list', {}, url, headers);
  list.tools.forEach(t => {
    registry[t.name] = { url, headers };
    allTools.push({
      toolSpec: {
        name:        t.name,
        description: t.description,
        inputSchema: { json: t.inputSchema },
      },
    });
  });
  console.log(`✅ Loaded ${list.tools.length} tools from ${url}`);
}

// ── System prompt ────────────────────────────────────────────────────────────────
// This is the highest-leverage variable in the system.
// See README for guidance on tuning this for your team.
function systemPrompt() {
  return `You are a Slack assistant for the "${REPO}" repository in "${ORG}".
Use GitHub MCP tools to look up real data. Never guess or fabricate.
Today: ${new Date().toISOString()}.

SLACK FORMATTING (mrkdwn — not standard Markdown):
- Bold: *bold*    Italic: _italic_    Code: \`code\`
- Links: <https://url|display text>  — NEVER [text](url)
- No # headings. No markdown tables. Use bullet lists instead.
- Issue links: <https://github.com/${ORG}/${REPO}/issues/N|#N>
- PR links:    <https://github.com/${ORG}/${REPO}/pull/N|PR #N>

EMOJI VOCABULARY:
:bar_chart:                  = activity / stats sections
:bug:                        = bugs section
:package:                    = releases section
:twisted_rightwards_arrows:  = PRs merged
:rotating_light:             = blocker unassigned — immediate action
:warning:                    = critical unassigned or error
:eyes:                       = major unassigned — needs attention
:white_check_mark:           = all clear

HIGH VOLUME: When results exceed 15 items, summarise by category,
show the top 10, and invite the user to ask for a specific subset.

PAGINATION: State confidently whether a result set is complete or partial.
Never expose API internals or per_page parameters.`;
}

// ── Agent loop ────────────────────────────────────────────────────────────────────
// Sends the question to Claude, executes tool calls via the registry,
// and repeats until Claude signals end_turn.
async function ask(question, prompt, maxIterations = 10) {
  const messages = [{ role: 'user', content: [{ text: question }] }];

  for (let i = 0; i < maxIterations; i++) {
    const res = await bedrock.send(new ConverseCommand({
      modelId:         MODEL,
      system:          [{ text: prompt }],
      messages,
      toolConfig:      { tools: allTools },
      inferenceConfig: { maxTokens: 2000 },
    }));

    messages.push(res.output.message);

    if (res.stopReason === 'end_turn')
      return res.output.message.content.find(b => b.text)?.text ?? '';

    if (res.stopReason === 'tool_use') {
      const results = await Promise.all(
        res.output.message.content
          .filter(b => b.toolUse)
          .map(async b => {
            const rt     = registry[b.toolUse.name];
            const result = await mcpRequest(
              'tools/call',
              { name: b.toolUse.name, arguments: b.toolUse.input },
              rt.url,
              rt.headers,
            );

            // Log every tool call for observability — ship to your platform of choice
            console.log(JSON.stringify({
              event:  'tool_call',
              tool:   b.toolUse.name,
              input:  b.toolUse.input,
              result: result,
              ts:     new Date().toISOString(),
            }));

            return {
              toolUseId: b.toolUse.toolUseId,
              content:   [{ json: result ?? {} }],
            };
          })
      );
      messages.push({ role: 'user', content: results.map(r => ({ toolResult: r })) });
    }
  }

  return 'Could not complete the request after maximum iterations.';
}

// ── Slack handler — post thinking indicator, update with answer ───────────────────
async function handleQuestion(channel, threadTs, question) {
  let thinkingTs;
  try {
    const r = await slackWeb.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text:      ':hourglass_flowing_sand: Looking into that...',
    });
    thinkingTs = r.ts;
  } catch { /* will fall back to new message */ }

  try {
    const answer = await ask(question, systemPrompt());

    try {
      await slackWeb.chat.update({ channel, ts: thinkingTs, text: answer });
    } catch {
      await slackWeb.chat.postMessage({ channel, thread_ts: threadTs, text: answer });
    }
  } catch (err) {
    console.error('Agent error:', err.message);
    const errText = "I'm having trouble right now. Please try again in a moment.";
    try      { await slackWeb.chat.update({ channel, ts: thinkingTs, text: errText }); }
    catch    { await slackWeb.chat.postMessage({ channel, thread_ts: threadTs, text: errText }); }
  }
}

// ── Slack events ──────────────────────────────────────────────────────────────────
slack.event('app_mention', async ({ event }) => {
  const question = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!question) {
    await slackWeb.chat.postMessage({
      channel:   event.channel,
      thread_ts: event.ts,
      text:      `Hi! I'm the ${REPO} assistant. Ask me about issues, PRs, releases, or code.`,
    });
    return;
  }
  await handleQuestion(event.channel, event.ts, question);
});

slack.message(async ({ message }) => {
  if (message.channel_type !== 'im' || !message.text?.trim()) return;
  await handleQuestion(message.channel, message.ts, message.text.trim());
});

// ── Morning summary ───────────────────────────────────────────────────────────────
function morningPrompt() {
  const today     = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const iso = d => d.toISOString().split('T')[0];

  return `You are generating the daily morning recap for "${REPO}" in "${ORG}".
Today: ${today.toISOString()}. Yesterday: ${iso(yesterday)}.

Use GitHub MCP tools to gather:
1. Active release PRs — open PRs with [RC], [Release], or hotfix in title.
   Count by type (bugfix/feature/chore). List linked open bugs.
2. Yesterday's activity — PRs merged/opened, issues closed/opened (bugs separately),
   PRs awaiting review + oldest age in days.
3. New bugs since ${iso(yesterday)} — issues labelled "bug". Classify each:
   Critical = crash, data loss, core feature broken cross-platform
   Major    = significant feature broken, workaround exists
   Minor    = visual/UI issue, edge case
4. Unassigned bugs by severity.

OUTPUT — plain Slack mrkdwn only. No JSON. No code fences.

:sunrise: *Morning Recap — ${fmt(today)}*

:package: _Active release: <https://github.com/${ORG}/${REPO}/pull/XXXX|[RC] vX.X.X> — DEV_
  X PRs (X bugfixes, X features, X chores)
  :large_yellow_circle: X linked bugs still open
  • <https://github.com/${ORG}/${REPO}/issues/XXXX|${REPO}#XXXX> — _Bug title_, assignee

:bar_chart: *Yesterday's Activity*
• X PRs merged, X PRs opened
• X issues closed, X issues opened (X bugs)
• X PRs awaiting review (oldest: X days)

:bug: *New Bugs (last 24h)*
*Critical*
• <https://github.com/${ORG}/${REPO}/issues/XXXX|${REPO}#XXXX> — _Bug title_
  Severity reason: one sentence

Total: X bugs (X Critical, X Major, X Minor)

*Needs Attention*
:rotating_light: *Immediate — X Blocker unassigned:*
• <url|#XXXX> — _Bug title_

:warning: *Urgent — X Critical unassigned:*
• <url|#XXXX> — _Bug title_

QUIET MODE — if no activity and no new bugs output only:
:sunrise: No codebase activity yesterday.

RULES:
- Omit sections and priority groups with no data
- If all critical bugs assigned: :white_check_mark: All critical bugs assigned.
- Keep under 10000 characters`;
}

async function postMorningSummary() {
  if (!SUMMARY_CHANNEL) return;
  console.log('\n📋 Building morning summary...');
  try {
    const text = await ask('Generate the morning recap now.', morningPrompt(), 15);
    const main = await slackWeb.chat.postMessage({ channel: SUMMARY_CHANNEL, text });
    console.log('✅ Morning summary posted');
    return main;
  } catch (err) {
    console.error('Morning summary failed:', err.message);
    await slackWeb.chat.postMessage({
      channel: SUMMARY_CHANNEL,
      text:    ':warning: _Activity data unavailable — could not reach GitHub._',
    });
  }
}

function scheduleMorningSummary() {
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);

  const ms = next - new Date();
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  console.log(`⏰ Morning summary scheduled — next run in ${h}h ${m}m`);

  setTimeout(() => {
    postMorningSummary();
    setInterval(postMorningSummary, 24 * 60 * 60 * 1000);
  }, ms);
}

// ── Start ─────────────────────────────────────────────────────────────────────────
(async () => {
  await slack.start();
  console.log(`⚡ Bot starting — ${ORG}/${REPO}`);
  console.log(`🤖 Model: ${MODEL}`);

  // Load GitHub MCP tools
  await loadServer(GITHUB_MCP_URL, githubHeaders);

  // To add more MCP servers, repeat loadServer() here:
  // const myHeaders = { Authorization: `Bearer ${process.env.MY_TOKEN}`, ... };
  // await loadServer(process.env.MY_MCP_URL, myHeaders);
  // Then add routing guidance to systemPrompt().

  console.log(`\n🚀 Bot ready — ${allTools.length} tools loaded`);

  if (SUMMARY_CHANNEL) {
    scheduleMorningSummary();
  }

  if (process.argv.includes('--summary')) {
    console.log('🧪 Running morning summary now...');
    await postMorningSummary();
  }
})();
