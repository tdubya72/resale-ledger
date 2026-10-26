// Resale Ledger — "identify" Edge Function
// Sends an item's photos to Claude and returns suggested listing details and a
// price estimate. Your Anthropic API key stays here on the server as a secret;
// the app never sees it.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   required, from console.anthropic.com
//   ANTHROPIC_MODEL     optional, defaults to claude-sonnet-5-5

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const CONDS = ["New with tags", "New without tags", "Like new", "Good", "Fair", "For parts"];
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Only a signed-in user of this project may run a lookup.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "not_signed_in" }, 401);
  const who = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: authHeader, apikey } });
  if (!who.ok) return json({ error: "not_signed_in" }, 401);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "no_api_key" }, 500);
  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";

  let body: { images?: { media_type?: string; data?: string }[]; typed?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const images = (body.images ?? [])
    .filter((i) => i && typeof i.data === "string" && i.data.length > 100 && TYPES.includes(i.media_type ?? ""))
    .slice(0, 4);
  if (!images.length) return json({ error: "no_images" }, 400);
  if (images.reduce((n, i) => n + (i.data as string).length, 0) > 12_000_000) return json({ error: "too_large" }, 413);

  const typed = body.typed && typeof body.typed === "object" ? body.typed : {};
  const typedLine = (typed.name || typed.notes)
    ? "What she has typed so far (may be partial): " + JSON.stringify(typed).slice(0, 2000)
    : "";

  const prompt = `You help a reseller who buys at thrift stores, garage sales and estate sales and resells on eBay, Poshmark, Mercari and Facebook Marketplace.
The ${images.length} attached photo(s) all show ONE item she bought. Identify it as precisely as the photos allow: brand, maker, model or pattern name, size, era, material, and any visible labels, model numbers or marks. Read any text visible in the photos.
${typedLine}
Then estimate the typical price this item SELLS for used in the US, based on your general knowledge of past sold listings. You have no live market data, so set confidence honestly: "high" only for well-known items with stable prices, "low" if the item is unclear or prices vary widely. If you cannot tell what it is, say so in the name and give estimate null.

Reply with ONLY this JSON, no other text:
{"name": "listing-style title, under 80 characters, most important words first",
 "brand": "brand or maker, or null",
 "category": "one or two words, e.g. Kitchen, Apparel, Electronics, Toys, Decor, Tools",
 "condition": one of ${JSON.stringify(CONDS)} or null if the photos can't show it,
 "description": "2-4 plain sentences a buyer would want: what it is, notable features, size or measurements if visible, and any visible wear or flaws",
 "search": "3-7 word search query that would find sold comps for this exact item",
 "estimate": {"low": number, "high": number} or null,
 "confidence": "high" | "medium" | "low",
 "pricing_note": "one sentence on what most affects this item's value"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: [
          ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
          { type: "text", text: prompt },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 600);
    const code = res.status === 401 || res.status === 403 ? "anthropic_auth"
      : res.status === 429 ? "rate_limited"
      : res.status === 400 && /credit/i.test(detail) ? "anthropic_credit"
      : "anthropic_error";
    console.error("Anthropic error", res.status, detail);
    return json({ error: code, status: res.status }, 502);
  }

  const msg = await res.json();
  const text: string = (msg.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return json({ error: "bad_reply" }, 502);
  try {
    return json({ result: JSON.parse(text.slice(start, end + 1)), model });
  } catch {
    return json({ error: "bad_reply" }, 502);
  }
});
