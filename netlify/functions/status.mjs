// status.mjs — DevPulse Status (Netlify Function)
// Returns the status, key counts, and active model.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const geminiKeys = (process.env.GEMINI_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
  const isGroqConfigured = !!process.env.GROQ_API_KEY;

  return new Response(
    JSON.stringify({
      status: "online",
      model: "gemini-2.5-flash",
      configuredGeminiKeys: geminiKeys.length,
      isGroqConfigured,
      timestamp: Date.now()
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
};

export const config = { path: "/api/status" };
