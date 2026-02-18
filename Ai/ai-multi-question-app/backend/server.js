const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = process.env.OPENROUTER_API_KEY;

if (!API_KEY) {
    console.error('ERROR: OPENROUTER_API_KEY is not set in environment variables');
    process.exit(1);
}

const SYSTEM_PROMPT = `You are a clear and helpful assistant. Follow these rules:
1. For general/conceptual questions: Give a clear answer in 2-4 sentences. Use simple language.
2. For comparison questions (like "difference between X and Y"): Use short labeled points. Example: "var: function-scoped. let: block-scoped. const: block-scoped, cannot be reassigned."
3. For code/solution questions: Provide complete working code with a brief explanation.
4. Always be concise but complete — never sacrifice clarity for brevity.`;

// ─── Helper: Non-streaming call (for summarize/detailed) ──────────────────────
async function callAI(messages, maxTokens = 500, temperature = 0.1) {
    return fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'AI Multi-Question App'
        },
        body: JSON.stringify({
            model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
            messages,
            max_tokens: maxTokens,
            temperature
        })
    });
}

// ─── Helper: Streaming call — streams tokens into SSE response ────────────────
// Returns the full assembled answer string
async function streamAIToSSE(messages, res, index, maxTokens = 400, temperature = 0.3) {
    const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'AI Multi-Question App'
        },
        body: JSON.stringify({
            model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
            messages,
            max_tokens: maxTokens,
            temperature,
            stream: true   // ← KEY: enables token-by-token streaming
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error ${response.status}: ${errText}`);
    }

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (res.flush) res.flush();
    };

    let fullAnswer = '';
    const reader = response.body;
    const decoder = new TextDecoder();
    let buffer = '';

    // Read the stream from OpenRouter
    await new Promise((resolve, reject) => {
        reader.on('data', (chunk) => {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') { resolve(); return; }

                try {
                    const parsed = JSON.parse(raw);
                    const token = parsed.choices?.[0]?.delta?.content;
                    if (token) {
                        fullAnswer += token;
                        // Send each token immediately to frontend
                        sendEvent({ type: 'token', index, chunk: token });
                    }
                } catch { /* skip malformed lines */ }
            }
        });
        reader.on('end', resolve);
        reader.on('error', reject);
    });

    return fullAnswer;
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running' });
});

// ─── Sequential Q&A with SSE + Streaming Tokens ───────────────────────────────
app.post('/api/ask-questions', async (req, res) => {
    try {
        const { questions } = req.body;

        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: 'Questions array is required.' });
        }

        const validQuestions = questions.filter(q => q && q.trim().length > 0);
        if (validQuestions.length === 0) {
            return res.status(400).json({ error: 'At least one valid question is required.' });
        }

        console.log(`Processing ${validQuestions.length} questions (streaming)...`);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',        // force chunked — no buffering
            'X-Accel-Buffering': 'no',             // disable nginx/proxy buffering
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });

        const sendEvent = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            if (res.flush) res.flush();
        };

        for (let i = 0; i < validQuestions.length; i++) {
            const question = validQuestions[i].trim();

            // 1. Tell frontend this question is being processed
            sendEvent({
                type: 'progress',
                current: i + 1,
                total: validQuestions.length,
                question,
                index: i,
                status: 'processing',
                timestamp: Date.now()
            });

            try {
                // 2. Stream tokens directly — each token fires a 'token' SSE event
                const fullAnswer = await streamAIToSSE(
                    [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user',   content: question }
                    ],
                    res,
                    i
                );

                // 3. Send 'answer_done' so frontend knows streaming for this Q is complete
                sendEvent({
                    type: 'answer_done',
                    index: i,
                    question,
                    answer: fullAnswer,
                    error: false,
                    timestamp: Date.now()
                });

                console.log(`✓ Q${i + 1} streamed`);

            } catch (err) {
                console.error(`Error Q${i + 1}:`, err.message);
                sendEvent({
                    type: 'answer_done',
                    index: i,
                    question,
                    answer: `Error: ${err.message}`,
                    error: true,
                    timestamp: Date.now()
                });
            }
        }

        sendEvent({ type: 'complete', totalQuestions: validQuestions.length });
        res.end();
        console.log('All questions processed ✓');

    } catch (err) {
        console.error('Server error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error', message: err.message });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
        }
    }
});

// ─── Per-Question Chat Endpoint ───────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
    try {
        const { originalQuestion, originalAnswer, history = [], userMessage } = req.body;

        if (!originalQuestion || !originalAnswer || !userMessage?.trim()) {
            return res.status(400).json({
                error: 'originalQuestion, originalAnswer, and userMessage are required.'
            });
        }

        console.log('Chat message for Q:', originalQuestion.substring(0, 50));

        const messages = [
            {
                role: 'system',
                content: `You are a helpful AI assistant. The user is asking follow-up questions about a specific Q&A pair.

Original Question: "${originalQuestion}"
Original Answer: "${originalAnswer}"

Answer follow-up questions on this topic. Be conversational, helpful, and thorough.`
            },
            ...history.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMessage.trim() }
        ];

        const response = await callAI(messages, 800, 0.7);

        if (!response.ok) {
            const errText = await response.text();
            console.error('Chat API Error:', errText);
            return res.status(500).json({ error: `AI API failed: ${response.status}` });
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content?.trim();

        if (!reply) return res.status(500).json({ error: 'Invalid response from AI service' });

        console.log('Chat reply sent ✓');
        res.json({ success: true, reply });

    } catch (err) {
        console.error('Chat endpoint error:', err);
        res.status(500).json({ error: 'Internal server error', message: err.message });
    }
});

// ─── Detailed Answer ──────────────────────────────────────────────────────────
app.post('/api/detailed-answer', async (req, res) => {
    try {
        const { question } = req.body;
        if (!question?.trim()) return res.status(400).json({ error: 'Question is required.' });

        const response = await callAI([
            { role: 'system', content: 'You are a helpful assistant. Provide a detailed, comprehensive answer with examples.' },
            { role: 'user', content: `Detailed answer: ${question}` }
        ], 1000, 0.7);

        if (!response.ok) return res.status(500).json({ error: `API failed: ${response.status}` });

        const data = await response.json();
        const answer = data.choices?.[0]?.message?.content?.trim();
        if (!answer) return res.status(500).json({ error: 'Invalid response format' });

        res.json({ success: true, answer, question });

    } catch (err) {
        console.error('Detailed answer error:', err);
        res.status(500).json({ error: 'Internal server error', message: err.message });
    }
});

// ─── Summarize Answer ─────────────────────────────────────────────────────────
app.post('/api/summarize-answer', async (req, res) => {
    try {
        const { question, answer } = req.body;
        if (!question || !answer) return res.status(400).json({ error: 'Both required.' });

        const response = await callAI([
            { role: 'system', content: 'Summarize the answer in 1-2 sentences max. Be brief.' },
            { role: 'user', content: `Q: ${question}\nA: ${answer}\nSummarize:` }
        ], 150, 0.3);

        if (!response.ok) return res.status(500).json({ error: `API failed: ${response.status}` });

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content?.trim();
        if (!summary) return res.status(500).json({ error: 'Invalid response format' });

        res.json({ success: true, summary, originalAnswer: answer });

    } catch (err) {
        console.error('Summarize error:', err);
        res.status(500).json({ error: 'Internal server error', message: err.message });
    }
});

// ─── Error Handlers ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});
app.use('*', (req, res) => res.status(404).json({ error: 'Route not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   API:    http://localhost:${PORT}/api/ask-questions`);
    console.log(`   Chat:   http://localhost:${PORT}/api/chat\n`);
});