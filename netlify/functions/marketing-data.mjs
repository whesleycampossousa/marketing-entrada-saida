// Netlify Function - Salvar/Carregar dados do Marketing na nuvem
// Usa Netlify Blobs com configuração manual para funcionar com deploys via CLI

import { getStore } from "@netlify/blobs";

function getStoreInstance() {
  const options = { name: "marketing-data" };
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_TOKEN || process.env.NETLIFY_AUTH_TOKEN;

  if (siteID && token) {
    options.siteID = siteID;
    options.token = token;
  }

  return getStore(options);
}

export async function handler(event) {
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  try {
    const store = getStoreInstance();

    if (event.httpMethod === "GET") {
      // Carregar dados
      const data = await store.get("tracker", { type: "json" });
      const despesas = await store.get("despesas", { type: "json" });
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ data: data || {}, despesas: Array.isArray(despesas) ? despesas : [] }),
      };
    }

    if (event.httpMethod === "POST") {
      // Salvar dados
      const body = JSON.parse(event.body);
      const hasData = body && typeof body.data === "object" && !Array.isArray(body.data);
      const hasDespesas = body && Array.isArray(body.despesas);

      if (!hasData && !hasDespesas) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Campo 'data' ou 'despesas' obrigatorio" }),
        };
      }

      if (hasData) await store.setJSON("tracker", body.data);
      if (hasDespesas) await store.setJSON("despesas", body.despesas);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true, saved: new Date().toISOString() }),
      };
    }

    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
