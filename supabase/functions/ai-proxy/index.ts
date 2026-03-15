// supabase/functions/ai-proxy/index.ts
// Deploy with: supabase functions deploy ai-proxy

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Free tier limits
const FREE_DAILY_AI_LIMIT = 10;
const FREE_MAX_TASKS = 20;
const FREE_MAX_PROJECTS = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify user JWT from Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Get user from token
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check and update daily AI query count
    const today = new Date().toISOString().slice(0, 10);
    const { data: profile } = await supabase
      .from("profiles")
      .select("plan, ai_queries_today, ai_queries_date")
      .eq("id", user.id)
      .single();

    const queriesDate = profile?.ai_queries_date;
    const queriesToday = queriesDate === today ? (profile?.ai_queries_today ?? 0) : 0;

    if (profile?.plan === "free" && queriesToday >= FREE_DAILY_AI_LIMIT) {
      return new Response(JSON.stringify({
        error: `Daily AI limit reached (${FREE_DAILY_AI_LIMIT} queries/day on free plan). Try again tomorrow.`
      }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request body
    const { messages, context } = await req.json();

    // Build prompt with user context
    const systemPrompt = `You are a helpful work tracking assistant. Answer the user's question using ONLY the provided data. Be concise and specific.\n\n${context}`;

    // Call Anthropic API
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: systemPrompt,
        messages: messages,
      }),
    });

    const anthropicData = await anthropicRes.json();

    if (!anthropicRes.ok) {
      throw new Error(anthropicData.error?.message ?? "Anthropic API error");
    }

    // Update query count
    await supabase.from("profiles").update({
      ai_queries_today: queriesToday + 1,
      ai_queries_date: today,
    }).eq("id", user.id);

    const answer = anthropicData.content?.map((b: any) => b.text ?? "").join("") ?? "";
    const remaining = FREE_DAILY_AI_LIMIT - (queriesToday + 1);

    return new Response(JSON.stringify({ answer, remaining }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});