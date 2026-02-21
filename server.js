// server.js - Railway Backend
// Replaces Netlify Functions with Express server

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Chat endpoint (replaces Netlify function)
app.post('/api/chat', async (req, res) => {
  console.log('=== CHAT REQUEST RECEIVED ===');
  
  try {
    const { provider, model, messages } = req.body;
    
    console.log('Provider:', provider);
    console.log('Model:', model);
    console.log('Messages count:', messages?.length);

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: "No messages provided" });
    }

    let apiUrl = "";
    let headers = { "Content-Type": "application/json" };
    let body = {};

    if (provider === 'mancer') {
        apiUrl = "https://neuro.mancer.tech/oai/v1/chat/completions";
        const API_KEY = process.env.MANCER_API_KEY; 
        
        if (!API_KEY) {
          return res.status(500).json({ 
            error: "Mancer API Key not configured. Add MANCER_API_KEY to Railway environment variables." 
          });
        }
        
        console.log('Using Mancer API Key (first 10 chars):', API_KEY.substring(0, 10) + '...');
        headers["X-API-KEY"] = API_KEY;

        // Keep thinking ENABLED for best quality
        body = {
            model: model,
            messages: messages,
            temperature: 0.7,
            max_tokens: 2048,  // increased from 1024
            //thinking: {		remove the thinking block
                //type: "enabled",
                //clear_thinking: true
            //}
        };

    } else if (provider === 'openrouter') {
        apiUrl = "https://openrouter.ai/api/v1/chat/completions";
        const API_KEY = process.env.OPENROUTER_API_KEY;
        
        if (!API_KEY) {
          return res.status(500).json({ 
            error: "OpenRouter API Key not configured. Add OPENROUTER_API_KEY to Railway." 
          });
        }
        
        console.log('Using OpenRouter API Key (first 10 chars):', API_KEY.substring(0, 10) + '...');
        headers["Authorization"] = `Bearer ${API_KEY}`;
        headers["HTTP-Referer"] = "https://rp-companion.up.railway.app";
        headers["X-Title"] = "RP Companion";
        
        body = {
            model: model,
            messages: messages,
            max_tokens: 1024
        };

    } else if (provider === 'openai') {
        apiUrl = "https://api.openai.com/v1/chat/completions";
        const API_KEY = process.env.OPENAI_API_KEY;
        
        if (!API_KEY) {
          return res.status(500).json({ 
            error: "OpenAI API Key not configured. Add OPENAI_API_KEY to Railway." 
          });
        }
        
        console.log('Using OpenAI API Key (first 10 chars):', API_KEY.substring(0, 10) + '...');
        headers["Authorization"] = `Bearer ${API_KEY}`;
        body = {
            model: model,
            messages: messages,
            max_tokens: 1024
        };

    } else if (provider === 'anthropic') {
        apiUrl = "https://api.anthropic.com/v1/messages";
        const API_KEY = process.env.ANTHROPIC_API_KEY;
        
        if (!API_KEY) {
          return res.status(500).json({ 
            error: "Anthropic API Key not configured. Add ANTHROPIC_API_KEY to Railway." 
          });
        }
        
        console.log('Using Anthropic API Key (first 10 chars):', API_KEY.substring(0, 10) + '...');
        headers["x-api-key"] = API_KEY;
        headers["anthropic-version"] = "2023-06-01";
        
        let systemMsg = "";
        const apiMessages = messages.filter(m => {
            if (m.role === 'system') {
                systemMsg = m.content;
                return false;
            }
            return true;
        });

        body = {
            model: model,
            max_tokens: 1024,
            system: systemMsg,
            messages: apiMessages
        };

    } else {
      return res.status(400).json({ error: "Unknown provider: " + provider });
    }

    console.log('Calling API:', apiUrl);

    // No timeout limit on Railway! This is the advantage
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });

    const responseData = await response.json();
    console.log('API response status:', response.status);

    if (!response.ok) {
        let errorMessage = "API request failed";
        if (responseData.error?.message) errorMessage = responseData.error.message;
        else if (responseData.error) errorMessage = String(responseData.error);
        else if (responseData.message) errorMessage = responseData.message;
        
        return res.status(response.status).json({ error: errorMessage });
    }

    // Extract text from response
    let finalText = "";
    let reasoningContent = null;

    if (provider === 'anthropic') {
        finalText = responseData?.content?.[0]?.text;
        if (!finalText) {
          return res.status(500).json({ error: 'Could not extract text from Anthropic response' });
        }

    } else {
        const message = responseData?.choices?.[0]?.message;
        
        if (!message) {
          return res.status(500).json({ error: 'No message found in API response' });
        }

        finalText = message.content || message.text || null;
        reasoningContent = message.reasoning_content || null;

        if (reasoningContent) {
          console.log('Reasoning content preserved, length:', reasoningContent.length);
        }

        if (!finalText && reasoningContent) {
          console.log('Warning: only reasoning_content found, using as reply');
          finalText = reasoningContent;
        }

        if (!finalText) {
          return res.status(500).json({ error: 'Could not extract text from API response' });
        }
    }

    console.log('✅ Success! Response preview:', finalText.substring(0, 100));

    // Return response
    res.json({
      choices: [{
        message: {
          role: "assistant",
          content: finalText,
          reasoning_content: reasoningContent
        }
      }]
    });

  } catch (error) {
    console.error("=== SERVER ERROR ===");
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 RP Companion server running on port ${PORT}`);
  console.log(`📍 Visit: http://localhost:${PORT}`);
});
