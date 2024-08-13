import { NextResponse } from 'next/server'
import { getRelevantContext } from '../../utils/retrieval'
import { HfInference } from "@huggingface/inference";

const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

const systemPrompt = `You are an intelligent and friendly customer support assistant for Headstarter, a platform that facilitates AI-powered interviews for software engineering (SWE) job candidates. Your goal is to provide clear, helpful, and concise answers to users' queries while maintaining a professional and supportive tone. Use the following context to inform your responses, but don't mention the context explicitly in your answer. If the context doesn't contain relevant information, rely on your general knowledge about Headstarter:

{context}

Remember to assist with questions about how the platform works, setting up interviews, technical issues, best practices for using AI in interviews, and understanding the features designed to help candidates succeed. When dealing with complex issues, guide users through troubleshooting steps and escalate unresolved issues to human support when necessary. Ensure users feel confident and supported as they navigate the Headstarter platform.`

const modelCategories = [
  { model: 'meta-llama/llama-3.1-8b-instruct:free', category: 'general support, platform information, interview preparation' },
  { model: 'openchat/openchat-7b:free', category: 'coding, programming, technical questions, algorithms, data structures' },
  { model: 'gryphe/mythomist-7b:free', category: 'creative writing, storytelling, role-playing scenarios, hypothetical situations' }
];

async function getEmbedding(text) {
  try {
    const response = await hf.featureExtraction({
      model: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
      inputs: text
    });
    return response;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

function cosineSimilarity(vecA, vecB) {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

async function selectModel(query) {
  console.log("Selecting model for query:", query);
  const queryEmbedding = await getEmbedding(query);
  let bestMatch = { model: modelCategories[0].model, similarity: -Infinity };

  for (const category of modelCategories) {
    const categoryEmbedding = await getEmbedding(category.category);
    const similarity = cosineSimilarity(queryEmbedding, categoryEmbedding);
    console.log(`Similarity for ${category.model}: ${similarity}`);
    if (similarity > bestMatch.similarity) {
      bestMatch = { model: category.model, similarity };
    }
  }

  console.log("Selected model:", bestMatch.model);
  return bestMatch.model;
}

export async function POST(req) {
  try {
    const data = await req.json()
    const userMessage = data[data.length - 1].content

    console.log("User message:", userMessage);

    // Retrieve relevant context
    const context = await getRelevantContext(userMessage)

    const messages = [
      { role: 'system', content: systemPrompt.replace('{context}', context) },
      ...data
    ]

    const selectedModel = await selectModel(userMessage)
    console.log("Selected model:", selectedModel);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://your-website-url.com',
        'X-Title': 'Headstarter Support Chat'
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: messages,
        stream: true
      })
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    async function* streamAsyncIterator() {
      let leftover = ''
      let modelSent = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        
        const chunk = decoder.decode(value, { stream: true })
        const lines = (leftover + chunk).split('\n')
        leftover = lines.pop() || ''
    
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') return
            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices[0]?.delta?.content || ''
              if (!modelSent) {
                yield JSON.stringify({ model: selectedModel }) + '\n'
                modelSent = true
              }
              if (content) yield content
            } catch (e) {
              console.error('Error parsing JSON:', e)
              yield '\nError: Unable to parse response\n'
            }
          }
        }
      }
    }

    return new NextResponse(streamAsyncIterator())
  } catch (error) {
    console.error('Error in POST function:', error);
    return new NextResponse(JSON.stringify({ error: 'An error occurred processing your request' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}