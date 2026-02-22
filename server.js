// server.js - Railway Backend
// v1.2.2 — BYOK support + Draft Assistant endpoint

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────
// HELPER — Build provider config
// Accepts an optional userApiKey (BYOK).
// If provided, it takes priority over the server env var.
// Used by both /api/chat and /api/draft endpoints.
// ─────────────────────────────────────────
function buildProviderConfig(provider, model, messages, userApiKey = null) {
  let apiUrl  = '';
  let headers = { 'Content-Type': 'application/json' };
  let body    = {};

  // ── MANCER ──
  if (provider === 'mancer') {
    apiUrl = 'https://neuro.mancer.tech/oai/v1/chat/completions';
    const API_KEY = userApiKey || process.env.MANCER_API_KEY;
    if (!API_KEY) throw new Error('Mancer API Key not configured. Add MANCER_API_KEY to Railway env vars or provide your own key.');
    headers['X-API-KEY'] = API_KEY;
    body = { model, messages, temperature: 0.7, max_tokens: 2048 };

  // ── OPENROUTER ──
  } else if (provider === 'openrouter') {
    apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    const API_KEY = userApiKey || process.env.OPENROUTER_API_KEY;
    if (!API_KEY) throw new Error('OpenRouter API Key not configured. Add OPENROUTER_API_KEY to Railway env vars or provide your own key.');
    headers['Authorization'] = `Bearer ${API_KEY}`;
    headers['HTTP-Referer']  = 'https://rp-companion.up.railway.app';
    headers['X-Title']       = 'RP Companion';
    body = { model, messages, max_tokens: 1024 };

  // ── OPENAI ──
  } else if (provider === 'openai') {
    apiUrl = 'https://api.openai.com/v1/chat/completions';
    const API_KEY = userApiKey || process.env.OPENAI_API_KEY;
    if (!API_KEY) throw new Error('OpenAI API Key not configured. Add OPENAI_API_KEY to Railway env vars or provide your own key.');
    headers['Authorization'] = `Bearer ${API_KEY}`;
    body = { model, messages, max_tokens: 1024 };

  // ── ANTHROPIC ──
  } else if (provider === 'anthropic') {
    apiUrl = 'https://api.anthropic.com/v1/messages';
    const API_KEY = userApiKey || process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) throw new Error('Anthropic API Key not configured. Add ANTHROPIC_API_KEY to Railway env vars or provide your own key.');
    headers['x-api-key']          = API_KEY;
    headers['anthropic-version']  = '2023-06-01';

    // Anthropic separates system prompt from messages
    let systemMsg  = '';
    const apiMsgs  = messages.filter(m => {
      if (m.role === 'system') { systemMsg = m.content; return false; }
      return true;
    });
    body = { model, max_tokens: 1024, system: systemMsg, messages: apiMsgs };

  } else {
    throw new Error('Unknown provider: ' + provider);
  }

  return { apiUrl, headers, body };
}

// ─────────────────────────────────────────
// HELPER — Call API and extract text
// ─────────────────────────────────────────
async function callApi(provider, apiUrl, headers, body) {
  const response     = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  const responseData = await response.json();

  if (!response.ok) {
    const errMsg = responseData.error?.message
      || (typeof responseData.error === 'string' ? responseData.error : null)
      || responseData.message
      || 'API request failed';
    throw new Error(errMsg);
  }

  let finalText      = '';
  let reasoningContent = null;

  if (provider === 'anthropic') {
    finalText = responseData?.content?.[0]?.text;
    if (!finalText) throw new Error('Could not extract text from Anthropic response');
  } else {
    const message    = responseData?.choices?.[0]?.message;
    if (!message)    throw new Error('No message found in API response');
    finalText        = message.content || message.text || null;
    reasoningContent = message.reasoning_content || null;

    if (!finalText && reasoningContent) finalText = reasoningContent;
    if (!finalText) throw new Error('Could not extract text from API response');
  }

  return { finalText, reasoningContent };
}

// ─────────────────────────────────────────
// POST /api/chat  — AI #1 (Victoria / main character)
// Uses server-side API key only.
// BYOK key is NOT used here — server key is protected for AI #1.
// ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  console.log('=== /api/chat ===');
  try {
    const { provider, model, messages } = req.body;
    console.log('Provider:', provider, '| Model:', model, '| Messages:', messages?.length);

    if (!messages || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' });

    const { apiUrl, headers, body } = buildProviderConfig(provider, model, messages, null);
    // null = always use server key for AI #1

    console.log('Calling:', apiUrl);
    const { finalText, reasoningContent } = await callApi(provider, apiUrl, headers, body);
    console.log('✅ AI #1 success:', finalText.substring(0, 100));

    res.json({
      choices: [{ message: { role: 'assistant', content: finalText, reasoning_content: reasoningContent } }]
    });

  } catch (err) {
    console.error('❌ /api/chat error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─────────────────────────────────────────
// POST /api/draft  — AI #2 (Draft Assistant)
// Uses the user's own BYOK API key stored in localStorage
// and sent from the frontend in the request body.
// Server env key is intentionally NOT used here —
// Draft Assistant costs are on the user's own account.
//
// Request body:
// {
//   provider:     string   — provider for AI #2
//   model:        string   — model for AI #2
//   messages:     array    — full chat history for context
//   draftChar:    object   — { name, desc } of character to draft as
//   draftPrompt:  string   — optional extra guidance for this draft
//   userApiKey:   string   — BYOK key from localStorage (required)
// }
// ─────────────────────────────────────────
app.post('/api/draft', async (req, res) => {
  console.log('=== /api/draft ===');
  try {
    const { provider, model, messages, draftChar, draftPrompt, userApiKey } = req.body;
    console.log('Provider:', provider, '| Model:', model, '| Draft char:', draftChar?.name);

    // userApiKey null = use server key (testing mode)
    // userApiKey string = use BYOK key
    const usingServerKey = !userApiKey || userApiKey.trim() === '';
    if (usingServerKey) {
      console.log('Draft: using server key (testing mode)');
    } else {
      console.log('Draft: using BYOK key');
    }

    if (!messages || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' });

    if (!draftChar || !draftChar.name)
      return res.status(400).json({ error: 'No draft character provided' });

    // Build Draft Assistant system prompt
    // Deliberately excludes Director's Mode and Author's Notes — see design spec
    const draftSystemPrompt =
`You are a creative writing assistant helping to draft a reply for the character ${draftChar.name}.

CHARACTER PROFILE:
${draftChar.name}: ${draftChar.desc}

YOUR TASK:
- Read the conversation history below carefully for full context
- Write a natural, in-character reply as ${draftChar.name}
- Match the tone, pace, and emotional register of the scene
- This is a DRAFT — write it thoughtfully but the user will review and edit it
- Do NOT add any preamble, explanation, or meta-commentary
- Reply ONLY with ${draftChar.name}'s dialogue/response${draftPrompt ? `

ADDITIONAL GUIDANCE FOR THIS DRAFT:
${draftPrompt}` : ''}`;

    // Build messages for AI #2
    // System prompt + full chat history for context
    const draftMessages = [
      { role: 'system', content: draftSystemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const { apiUrl, headers, body } = buildProviderConfig(
      provider, model, draftMessages, usingServerKey ? null : userApiKey.trim()
    );

    console.log('Calling Draft API:', apiUrl);
    const { finalText, reasoningContent } = await callApi(provider, apiUrl, headers, body);
    console.log('✅ Draft success:', finalText.substring(0, 100));

    res.json({
      choices: [{ message: { role: 'assistant', content: finalText, reasoning_content: reasoningContent } }]
    });

  } catch (err) {
    console.error('❌ /api/draft error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 RP Companion server v1.2.2 running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /api/chat  — AI #1 Victoria (server key)');
  console.log('  POST /api/draft — AI #2 Draft Assistant (BYOK key)');
});
