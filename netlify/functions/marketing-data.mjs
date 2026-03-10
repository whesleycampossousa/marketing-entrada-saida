// Netlify Function - Salvar/Carregar dados do Marketing na nuvem
// Usa Netlify Blobs com configuração manual para funcionar com deploys via CLI

import { getStore } from "@netlify/blobs";

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
    const store = getStore({
      name: "marketing-data",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });

    if (event.httpMethod === "GET") {
      // Carregar dados
      const data = await store.get("tracker", { type: "json" });
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ data: data || {} }),
      };
    }

    if (event.httpMethod === "POST") {
      // Salvar dados
      const body = JSON.parse(event.body);
      if (!body || typeof body.data !== "object") {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Campo 'data' obrigatorio" }),
        };
      }
      await store.setJSON("tracker", body.data);
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
