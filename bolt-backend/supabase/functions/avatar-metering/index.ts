import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleAvatarMetering } from "./handler.ts";

const SUPABASE_URL = "https://aoaylzncorwakxcactox.supabase.co";

Deno.serve((req: Request) => handleAvatarMetering(req, {
  secret: Deno.env.get("BOT_PURCHASE_API_SECRET"),
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  ownerId: Deno.env.get("OWNER_TELEGRAM_ID"),
  rpc: async (name, params, key) => {
    const client = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return client.rpc(name, params);
  },
}));