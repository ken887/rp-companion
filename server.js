// server.js - Railway Backend
// ─────────────────────────────────────────
// REVISION HISTORY
// v1.2.2v — Three fixes:
//
//   FIX 1 — DRAFT PROSE STYLE: Server's draftSystemPrompt now explicitly
//            instructs the AI to write in clean natural prose. Previously
//            no style instruction existed, causing models to default to
//            staccato/literary output regardless of user's style setting.
//
//   FIX 2 — max_tokens RESPECTED: buildProviderConfig() now accepts and
//            passes through a max_tokens parameter from the request body.
//            Previously the client's 400-word cap (600 tokens) was sent
//            but silently ignored — server used hardcoded values instead.
//            Applies to both /api/chat and /api/draft.
//
//   FIX 3 — ANTHROPIC max_tokens CAPPED: Anthropic draft calls were
//            hardcoded to 4096 tokens regardless. Now respects the
//            passed max_tokens with a sensible minimum floor of 256.
//
// v1.2.2o — fix buy draft assistant and director mode instructions were ignored
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

app.use((req, res, next) => {
  const size = req.headers['content-length'];
  if (size && size > 1024 * 1024) {
    console.log(`📦 Large request: ${(size / 1024 / 1024).toFixed(2)} MB — ${req.method} ${req.path}`);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────
// HELPER — Build provider config
// v1.2.2v: accepts maxTokens param, passes through to API body.
// Each provider has a sensible default if maxTokens is not supplied.
// ─────────────────────────────────────────
function buildProviderConfig(provider, model, messages, userApiKey = null, maxTokens = null) {
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
      max_tokens:      maxTokens || 2048,
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
    body = { model, messages, max_tokens: maxTokens || 1024 };

  // ── OPENAI ──
  } else if (provider === 'openai') {
    apiUrl = 'https://api.openai.com/v1/chat/completions';
    const API_KEY = userApiKey || process.env.OPENAI_API_KEY;
    if (!API_KEY) throw new Error('OpenAI API Key not configured. Add OPENAI_API_KEY to Railway env vars.');
    headers['Authorization'] = `Bearer ${API_KEY}`;
    body = { model, messages, max_tokens: maxTokens || 1024 };

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

    // v1.2.2v: respect maxTokens — floor at 256 to avoid Anthropic rejection
    body = {
      model,
      max_tokens: maxTokens ? Math.max(256, maxTokens) : 1024,
      system:     systemMsg,
      messages:   sanitised
    };

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
// v1.2.2v: reads max_tokens from request body and passes through.
// ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  console.log('=== /api/chat ===');
  try {
    const { provider, model, messages, max_tokens } = req.body;
    console.log('Provider:', provider, '| Model:', model, '| Messages:', messages?.length, '| max_tokens:', max_tokens || 'default');

    if (!messages || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' });

    const payloadSize = JSON.stringify(req.body).length;
    console.log(`📊 /api/chat payload: ${(payloadSize / 1024).toFixed(1)} KB`);
    if (payloadSize > 4 * 1024 * 1024) {
      return res.status(413).json({
        error: 'Chat history too large. Reduce Context Window in Settings or clear old messages.'
      });
    }

    // v1.2.2v: pass max_tokens through to buildProviderConfig
    const { apiUrl, headers, body } = buildProviderConfig(provider, model, messages, null, max_tokens || null);

    console.log('Calling:', apiUrl, '| max_tokens in body:', body.max_tokens);
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
// v1.2.2v: prose style instruction added to draftSystemPrompt.
//          max_tokens read from request and passed through.
// ─────────────────────────────────────────
app.post('/api/draft', async (req, res) => {
  console.log('=== /api/draft ===');
  try {
    const { provider, model, messages, draftChar, draftPrompt, userApiKey, activeCharName, max_tokens } = req.body;
    console.log('Provider:', provider, '| Model:', model, '| Draft char:', draftChar?.name, '| Active char:', activeCharName, '| max_tokens:', max_tokens || 'default');

    const usingServerKey = !userApiKey || userApiKey.trim() === '';
    console.log('Draft key mode:', usingServerKey ? 'server key' : 'BYOK');

    if (!messages || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' });
    if (!draftChar || !draftChar.name)
      return res.status(400).json({ error: 'No draft character provided' });

    const payloadSize = JSON.stringify(req.body).length;
    console.log(`📊 /api/draft payload: ${(payloadSize / 1024).toFixed(1)} KB`);
    if (payloadSize > 4 * 1024 * 1024) {
      return res.status(413).json({
        error: 'Chat history too large for draft. Reduce Context Window in Settings or clear old messages.'
      });
    }

    const aiCharName = activeCharName || 'the main character';
    const draftName  = draftChar.name;

    // ── v1.2.2v: Added WRITING STYLE section ──
    // Previously no style instruction existed — models defaulted to staccato/
    // literary output because that dominates roleplay training data.
    // Draft Assistant is a writing utility and should always produce clean,
    // readable prose that the user can review and edit easily.
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

WRITING STYLE:
Write in natural, flowing prose. Use "Quotation marks" for spoken dialogue.
Weave action beats and internal reactions naturally into the narrative.
Do NOT use parentheses for action beats or internal monologue.
Do NOT write in staccato fragments or short disconnected lines.
Write complete, readable sentences — this is a draft for the user to review and edit.

STRICT RULES:
- Write ONLY as ${draftName}
- Do NOT write as ${aiCharName}
- Do NOT repeat, echo, or extend ${aiCharName}'s last line
- Do NOT include any preamble, explanation, reasoning, or meta-commentary
- Do NOT think out loud — output ONLY ${draftName}'s reply, nothing else
- Start your output directly with ${draftName}'s words or action`;

    const transcript = messages.map(m => {
      const speaker = m.role === 'assistant' ? aiCharName : draftName;
      return `${speaker}:\n${m.content}`;
    }).join('\n\n');

    const guidanceBlock = draftPrompt
      ? `\n\nDIRECTOR'S GUIDANCE FOR THIS DRAFT — follow this precisely:\n${draftPrompt}`
      : '';

    const transcriptUserMsg =
      `SCENE TRANSCRIPT:\n\n${transcript}\n\n---${guidanceBlock}\n\n` +
      `Now write ${draftName}'s next reply. Output only ${draftName}'s response, nothing else.`;

    const draftMessages = [
      { role: 'system', content: draftSystemPrompt },
      { role: 'user',   content: transcriptUserMsg }
    ];

    // v1.2.2v: pass max_tokens through — respects client's 400-word cap
    const { apiUrl, headers, body } = buildProviderConfig(
      provider, model, draftMessages,
      usingServerKey ? null : userApiKey.trim(),
      max_tokens || null
    );

    // Thinking suppression for GLM / Mancer models
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

    console.log('Calling Draft API:', apiUrl, '| max_tokens in body:', body.max_tokens);
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
  console.log(`🚀 RP Companion server v1.2.2v running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /api/chat  — AI #1 (server key)');
  console.log('  POST /api/draft — AI #2 Draft Assistant (BYOK key)');
});