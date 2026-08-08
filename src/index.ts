export class AlgoServiceContainer {
  constructor(state: any, env: any) {}
  async fetch(request: Request) {
    return new Response("Container DO Disabled", { status: 404 });
  }
}

export interface Env {
  AI: any; // Cloudflare Workers AI binding
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  ALGO_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (path === "/health" || path === "/") {
      return jsonResponse({ status: "ok", service: "culinari-algorithm-worker", version: "v1" }, 200, corsHeaders);
    }

    // Auth Middleware: Check Bearer token if ALGO_API_KEY is configured
    const authHeader = request.headers.get("Authorization");
    const requiredApiKey = env.ALGO_API_KEY || process.env.ALGO_API_KEY;
    if (requiredApiKey) {
      if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== requiredApiKey) {
        return jsonResponse({ detail: "Invalid or missing authentication token" }, 401, corsHeaders);
      }
    }

    try {
      // 1. Food Check Moderation Endpoint (Gemini API)
      if (path === "/moderation/food-check" && method === "POST") {
        const body: any = await request.json();
        const title = body.title || "";
        const description = body.description || "";
        let imageBase64 = body.image_base64 || null;
        let mimeType = body.mime_type || "image/jpeg";

        // Fetch image if image_url is provided
        if (body.image_url && !imageBase64) {
          try {
            const imgRes = await fetch(body.image_url);
            if (imgRes.ok) {
              const contentTypeHeader = imgRes.headers.get("content-type");
              if (contentTypeHeader && contentTypeHeader.startsWith("image/")) {
                mimeType = contentTypeHeader;
              }
              const arrayBuffer = await imgRes.arrayBuffer();
              imageBase64 = arrayBufferToBase64(arrayBuffer);
            }
          } catch (err) {
            console.error("Failed to fetch image URL:", err);
          }
        }

        const geminiApiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
        const geminiModel = env.GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-1.5-flash";

        if (!geminiApiKey) {
          return jsonResponse({
            is_food: true,
            confidence: 0.5,
            reason: "GEMINI_API_KEY is not configured yet in Worker secrets/environment."
          }, 200, corsHeaders);
        }

        const prompt = (
          "You are a strict content moderator for Culinari, a food video and recipe sharing platform.\n" +
          "Your absolute rule is: only food, cooking, culinary arts, dining, kitchen, ingredients, and recipes are allowed.\n" +
          "Analyze the provided text and any associated image and determine if this content is strictly related to food, cooking, or culinary activities.\n" +
          `Title: '${title}'\n` +
          `Description: '${description}'\n\n` +
          "Respond ONLY with a JSON object containing the keys: 'is_food' (boolean), 'confidence' (number 0.0-1.0), and 'reason' (string short explanation)."
        );

        const parts: any[] = [{ text: prompt }];
        if (imageBase64) {
          parts.push({
            inlineData: {
              mimeType: mimeType,
              data: imageBase64
            }
          });
        }

        const geminiPayload = {
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                is_food: { type: "BOOLEAN" },
                confidence: { type: "NUMBER" },
                reason: { type: "STRING" }
              },
              required: ["is_food", "confidence", "reason"]
            }
          }
        };

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiPayload)
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          console.error("Gemini API Error:", errText);
          return jsonResponse({ detail: `Gemini API error: HTTP ${geminiRes.status}` }, 502, corsHeaders);
        }

        const geminiData: any = await geminiRes.json();
        const textResponse = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) {
          return jsonResponse({ detail: "No content returned from Gemini model" }, 502, corsHeaders);
        }

        const parsed = JSON.parse(textResponse);
        return jsonResponse({
          is_food: Boolean(parsed.is_food),
          confidence: Number(parsed.confidence || 0),
          reason: String(parsed.reason || "No explanation provided")
        }, 200, corsHeaders);
      }

      // 2. Recommend Endpoint
      if (path === "/recommend" && method === "POST") {
        const body: any = await request.json();
        const userId = body.user_id || "anonymous";
        const abBucket = Math.abs(hashString(userId)) % 100;
        return jsonResponse({
          user_id: userId,
          algo_version: "v1",
          ab_bucket: abBucket,
          items: []
        }, 200, corsHeaders);
      }

      // 3. Rank Endpoint
      if (path === "/rank" && method === "POST") {
        const body: any = await request.json();
        const candidateIds: string[] = body.candidate_ids || [];
        const items = candidateIds.map(id => ({ content_id: id, score: 0.0 }));
        return jsonResponse({
          user_id: body.user_id || "",
          items
        }, 200, corsHeaders);
      }

      // 4. Embed Endpoints (Demonstrating Cloudflare Workers AI Embeddings)
      if (path === "/embed/content" && method === "POST") {
        const body: any = await request.json();
        let embeddingVector = null;

        // Generate vector embedding using Cloudflare Workers AI if text is present
        const textToEmbed = [body.title, body.caption, body.description].filter(Boolean).join(" ");
        if (textToEmbed && env.AI) {
          try {
            const aiRes = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [textToEmbed] });
            embeddingVector = aiRes?.data?.[0] || null;
          } catch (aiErr) {
            console.error("Workers AI embedding error:", aiErr);
          }
        }

        return jsonResponse({
          ok: true,
          content_id: body.content_id,
          content_type: body.content_type,
          has_vector: Boolean(embeddingVector),
          vector_dimensions: embeddingVector ? embeddingVector.length : 0
        }, 200, corsHeaders);
      }

      if (path === "/embed/user" && method === "POST") {
        const body: any = await request.json();
        return jsonResponse({ ok: true, user_id: body.user_id }, 200, corsHeaders);
      }

      // 5. Event Endpoints
      if ((path === "/event" || path === "/event/batch") && method === "POST") {
        const body: any = await request.json();
        const count = Array.isArray(body) ? body.length : 1;
        return jsonResponse({ ok: true, count }, 200, corsHeaders);
      }

      return jsonResponse({ detail: "Not Found" }, 404, corsHeaders);

    } catch (err: any) {
      console.error("Worker Error:", err);
      return jsonResponse({ detail: err.message || "Internal Server Error" }, 500, corsHeaders);
    }
  }
};

function jsonResponse(data: any, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}
