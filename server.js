// server.js - Railway Backend
// v1.2.2f — BYOK support + Draft Assistant endpoint turn of thinking mode in mancer 

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
    body = {
      model,
      messages,
      temperature:      0.7,
      max_tokens:       2048,
      enable_thinking:  false   // suppress thinking output for Mancer/GLM models
    };

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
//
// Fixes applied:
// 1. Thinking/reasoning suppressed for GLM models (enable_thinking: false)
// 2. Role confusion fixed — history presented as a screenplay, not chat roles
// 3. Anthropic compatible — system prompt separated correctly
// 4. Works with server key (null) or BYOK key (string)
// ─────────────────────────────────────────
app.post('/api/draft', async (req, res) => {
  console.log('=== /api/draft ===');
  try {
    const { provider, model, messages, draftChar, draftPrompt, userApiKey, activeCharName } = req.body;
    console.log('Provider:', provider, '| Model:', model, '| Draft char:', draftChar?.name, '| Active char:', activeCharName);

    const usingServerKey = !userApiKey || userApiKey.trim() === '';
    console.log('Draft key mode:', usingServerKey ? 'server key' : 'BYOK');

    if (!messages || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' });
    if (!draftChar || !draftChar.name)
      return res.status(400).json({ error: 'No draft character provided' });

    const aiCharName = activeCharName || 'the main character';
    const draftName  = draftChar.name;

    // ── SYSTEM PROMPT ──
    // Framed as a screenplay task — much clearer than chat-role instructions
    const draftSystemPrompt =
`You are a screenwriter's assistant helping draft dialogue and action for a roleplay scene.

YOUR TASK:
Write the next line(s) for the character "${draftName}" only.

CHARACTER PROFILE — ${draftName}:
${draftChar.desc}

THE SCENE SO FAR:
Below is the conversation transcript. ${aiCharName} and ${draftName} are the two characters.
Read it carefully to understand tone, tension, and pacing.
Your job is to write what ${draftName} says or does NEXT — responding to ${aiCharName}'s most recent line.

STRICT RULES:
- Write ONLY as ${draftName}
- Do NOT write as ${aiCharName}
- Do NOT repeat, echo, or extend ${aiCharName}'s last line
- Do NOT include any preamble, explanation, reasoning, or meta-commentary
- Do NOT think out loud — output ONLY ${draftName}'s reply, nothing else
- Start your output directly with ${draftName}'s words or action${draftPrompt ? `

DIRECTION FOR THIS DRAFT:
${draftPrompt}` : ''}`;

    // ── HISTORY — presented as a labelled screenplay transcript ──
    // All turns become a single readable block rather than chat roles.
    // This avoids role confusion entirely — the AI sees a script, not a chat.
    const transcript = messages.map(m => {
      const speaker = m.role === 'assistant' ? aiCharName : draftName;
      return `${speaker}:\n${m.content}`;
    }).join('\n\n');

    // ── BUILD MESSAGES FOR PROVIDER ──
    // For Anthropic: system is separate, transcript goes in user turn
    // For others: system in messages array as role:system
    let draftMessages;

    if (provider === 'anthropic') {
      // Anthropic handles system separately via buildProviderConfig
      draftMessages = [
        { role: 'system', content: draftSystemPrompt },
        { role: 'user',   content: `SCENE TRANSCRIPT:\n\n${transcript}\n\n---\nNow write ${draftName}'s next reply. Output only ${draftName}'s response, nothing else.` }
      ];
    } else {
      draftMessages = [
        { role: 'system', content: draftSystemPrompt },
        { role: 'user',   content: `SCENE TRANSCRIPT:\n\n${transcript}\n\n---\nNow write ${draftName}'s next reply. Output only ${draftName}'s response, nothing else.` }
      ];
    }

    // ── BUILD PROVIDER CONFIG ──
    const { apiUrl, headers, body } = buildProviderConfig(
      provider, model, draftMessages, usingServerKey ? null : userApiKey.trim()
    );

    // ── SUPPRESS THINKING for Mancer/GLM models ──
    // Mancer uses enable_thinking:false to prevent reasoning_content leaking into output
    // Applied to any Mancer provider call OR any model name containing 'glm'
    if (provider === 'mancer' || model.toLowerCase().includes('glm')) {
      body.enable_thinking = false;
      console.log('Draft: thinking suppressed (Mancer/GLM)');
    }

    console.log('Calling Draft API:', apiUrl);
    const { finalText, reasoningContent } = await callApi(provider, apiUrl, headers, body);
    console.log('✅ Draft success:', finalText.substring(0, 120));

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
  console.log(`🚀 RP Companion server v1.2.2f running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /api/chat  — AI #1 Victoria (server key)');
  console.log('  POST /api/draft — AI #2 Draft Assistant (BYOK key)');
});
