// server.js - Railway Backend
// ─────────────────────────────────────────
// REVISION HISTORY
// v1.2.2k — Payload size guard on /api/chat and /api/draft (4mb hard limit)
//            Logging middleware for large requests (>1mb logged to Railway)
//            express.json limit raised to 50mb (handles long sessions)
//            express.urlencoded limit added (50mb, extended)
//            [from v1.2.2j] Draft AI voice fix, Anthropic compat, GLM thinking
//            suppression, Android PWA fixes, Railway JSON error fix
// ─────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────
app.use(cors());

// ── v1.2.2k: Log incoming request size to Railway logs for diagnostics ──
// Only logs if payload exceeds 1MB — keeps logs clean during normal use
app.use((req, res, next) => {
  const size = req.headers['content-length'];
  if (size && size > 1024 * 1024) {
    console.log(`📦 Large request: ${(size / 1024 / 1024).toFixed(2)} MB — ${req.method} ${req.path}`);
  }
  next();
});

// ── v1.2.2k: Raised to 50mb to accommodate long chat sessions ──
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Catch-all: return index.html for any unknown GET route ──
// Prevents Railway's proxy from returning its own HTML 404 page,
// which breaks JSON parsing on the frontend ("DOCTYPE is not valid JSON")
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────
// HELPER — Build provider config
// ─────────────────────────────────────────
function buildProviderConfig(provider, model, messages, userApiKey = null) {
  let apiUrl  = '';
  let headers = { 'Content-Type': 'application/json' };
  let body    = {};

  // ── MANCER ──
  if (provider === 'mancer') {
    apiUrl = 'https://neuro.mancer.tech/oai/v1/chat/completions';
    const API_KEY = userApiKey || process.env.MANCER_API_KEY;
    if (!API_KEY) throw new Error('Mancer API Key not configured. Add MANCER_API_KEY to Railway env vars.');
    headers['X-API-KEY'] = API_KEY;
    const mancerMessages = [...messages];
    const lastUserIdx = [...mancerMessages].reverse().findIndex(m => m.role === 'user');
    if (lastUserIdx !== -1) {
      const realIdx = mancerMessages.length - 1 - lastUserIdx;
      mancerMessages[realIdx] = {
        ...mancerMessages[realIdx],
        content: mancerMessages[realIdx].content + '\n/nothink'
      };
    }
    body = {
      model,
      messages:        mancerMessages,
      temperature:     0.7,
      max_tokens:      2048,
      enable_thinking: false
    };

  // ── OPENROUTER ──
  } else if (provider === 'openrouter') {
    apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    const API_KEY = userApiKey || process.env.OPENROUTER_API_KEY;
    if (!API_KEY) throw new Error('OpenRouter API Key not configured. Add OPENROUTER_API_KEY to Railway env vars.');
    headers['Authorization'] = `Bearer ${API_KEY}`;
    headers['HTTP-Referer']  = 'https://rp-companion.up.railway.app';
    headers['X-Title']       = 'RP Companion';
    body = { model, messages, max_tokens: 1024 };

  // ── OPENAI ──
  } else if (provider === 'openai') {
    apiUrl = 'https://api.openai.com/v1/chat/completions';
    const API_KEY = userApiKey || process.env.OPENAI_API_KEY;
    if (!API_KEY) throw new Error('OpenAI API Key not configured. Add OPENAI_API_KEY to Railway env vars.');
    headers['Authorization'] = `Bearer ${API_KEY}`;
    body = { model, messages, max_tokens: 1024 };

  // ── ANTHROPIC ──
  } else if (provider === 'anthropic') {
    apiUrl = 'https://api.anthropic.com/v1/messages';
    const API_KEY = userApiKey || process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) throw new Error('Anthropic API Key not configured. Add ANTHROPIC_API_KEY to Railway env vars.');
    headers['x-api-key']         = API_KEY;
    headers['anthropic-version'] = '2023-06-01';

    let systemMsg = '';
    let apiMsgs   = messages.filter(m => {
      if (m.role === 'system') { systemMsg = m.content; return false; }
      return true;
    });

    const sanitised = [];
    for (const msg of apiMsgs) {
      const prev = sanitised[sanitised.length - 1];
      if (prev && prev.role === msg.role) {
        prev.content += '\n\n' + msg.content;
      } else {
        sanitised.push({ role: msg.role, content: msg.content });
      }
    }

    if (sanitised.length > 0 && sanitised[sanitised.length - 1].role === 'assistant') {
      sanitised.push({ role: 'user', content: 'Please continue.' });
    }
    if (sanitised.length === 0) {
      sanitised.push({ role: 'user', content: 'Begin.' });
    }

    body = { model, max_tokens: 4096, system: systemMsg, messages: sanitised };

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
    console.error('API error response:', JSON.stringify(responseData, null, 2));

    const errMsg =
      responseData.error?.message
      || responseData.error?.metadata?.raw
      || (typeof responseData.error === 'string' ? responseData.error : null)
      || responseData.message
      || `HTTP ${response.status} — API request failed`;

    if (response.status === 429) throw new Error('Rate limit reached — wait a moment and try again');
    if (response.status === 402) throw new Error('Insufficient credits on your API account');
    if (response.status === 413 || errMsg.toLowerCase().includes('context') || errMsg.toLowerCase().includes('token')) {
      throw new Error('Chat history too long for this model. Reduce Context Window in Settings, or clear chat history.');
    }

    throw new Error(errMsg);
  }

  let finalText        = '';
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
// POST /api/chat  — AI #1 (main character)
// Uses server-side API key only.
// ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  console.log('=== /api/chat ===');
  try {
    const { provider, model, messages } = req.body;
    console.log('Provider:', provider, '| Model:', model, '| Messages:', messages?.length);

    if (!messages || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' });

    // ── v1.2.2k: Payload size guard ──
    const payloadSize = JSON.stringify(req.body).length;
    console.log(`📊 /api/chat payload: ${(payloadSize / 1024).toFixed(1)} KB`);
    if (payloadSize > 4 * 1024 * 1024) {
      return res.status(413).json({
        error: 'Chat history too large. Reduce Context Window in Settings or clear old messages.'
      });
    }

    const { apiUrl, headers, body } = buildProviderConfig(provider, model, messages, null);

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

    // ── v1.2.2k: Payload size guard ──
    const payloadSize = JSON.stringify(req.body).length;
    console.log(`📊 /api/draft payload: ${(payloadSize / 1024).toFixed(1)} KB`);
    if (payloadSize > 4 * 1024 * 1024) {
      return res.status(413).json({
        error: 'Chat history too large for draft. Reduce Context Window in Settings or clear old messages.'
      });
    }

    const aiCharName = activeCharName || 'the main character';
    const draftName  = draftChar.name;

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

    const transcript = messages.map(m => {
      const speaker = m.role === 'assistant' ? aiCharName : draftName;
      return `${speaker}:\n${m.content}`;
    }).join('\n\n');

    const transcriptUserMsg =
      `SCENE TRANSCRIPT:\n\n${transcript}\n\n---\n` +
      `Now write ${draftName}'s next reply. Output only ${draftName}'s response, nothing else.`;

    const draftMessages = [
      { role: 'system', content: draftSystemPrompt },
      { role: 'user',   content: transcriptUserMsg }
    ];

    const { apiUrl, headers, body } = buildProviderConfig(
      provider, model, draftMessages, usingServerKey ? null : userApiKey.trim()
    );

    if (provider === 'anthropic') {
      body.max_tokens = 4096;
    }

    if (provider === 'mancer' || model.toLowerCase().includes('glm')) {
      body.enable_thinking = false;
      if (Array.isArray(body.messages)) {
        const lastMsg = body.messages[body.messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          lastMsg.content += '\n/nothink';
        }
      }
      console.log('Draft: thinking suppressed via enable_thinking:false + /nothink');
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
// GLOBAL ERROR HANDLER
// Ensures ALL errors from API routes return JSON, never HTML.
// ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
  next(err);
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 RP Companion server v1.2.2k running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /api/chat  — AI #1 (server key)');
  console.log('  POST /api/draft — AI #2 Draft Assistant (BYOK key)');
});
