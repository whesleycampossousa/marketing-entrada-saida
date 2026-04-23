import { getStore } from "@netlify/blobs";

const META_KEY = "meta.json";
const ROWS_PREFIX = "rows/";

function getStoreInstance() {
  const options = { name: "followup-data" };
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_TOKEN || process.env.NETLIFY_AUTH_TOKEN;

  if (siteID && token) {
    options.siteID = siteID;
    options.token = token;
  }

  return getStore(options);
}

function getRowBlobKey(rowKey) {
  return `${ROWS_PREFIX}${encodeURIComponent(rowKey)}.json`;
}

function decodeRowKey(blobKey) {
  const encoded = blobKey.slice(ROWS_PREFIX.length, blobKey.length - ".json".length);
  return decodeURIComponent(encoded);
}

function mergeRow(current, patch, appendContactLog) {
  const next = { ...(current || {}), ...(patch || {}) };
  const currentLog = Array.isArray(current?.contactLog) ? current.contactLog : [];

  if (appendContactLog) {
    next.contactLog = [...currentLog, appendContactLog];
  } else if (Array.isArray(next.contactLog)) {
    next.contactLog = next.contactLog;
  } else if (currentLog.length > 0) {
    next.contactLog = currentLog;
  }

  return next;
}

export async function handler(event) {
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  try {
    const store = getStoreInstance();

    if (event.httpMethod === "GET") {
      const [meta, listResult] = await Promise.all([
        store.get(META_KEY, { type: "json" }),
        store.list({ prefix: ROWS_PREFIX }),
      ]);

      const rows = {};
      await Promise.all(
        (listResult.blobs || []).map(async ({ key }) => {
          const rowKey = decodeRowKey(key);
          const row = await store.get(key, { type: "json" });
          if (row) rows[rowKey] = row;
        })
      );

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          rows,
          meta: meta || {},
        }),
      };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");

      if (body.metaPatch && typeof body.metaPatch === "object" && !Array.isArray(body.metaPatch)) {
        const currentMeta = (await store.get(META_KEY, { type: "json" })) || {};
        const nextMeta = { ...currentMeta, ...body.metaPatch };
        await store.setJSON(META_KEY, nextMeta);

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({ ok: true, meta: nextMeta }),
        };
      }

      const { rowKey, patch, appendContactLog } = body;
      if (!rowKey || typeof rowKey !== "string") {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Campo 'rowKey' obrigatorio" }),
        };
      }

      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Campo 'patch' obrigatorio" }),
        };
      }

      const blobKey = getRowBlobKey(rowKey);
      const currentRow = (await store.get(blobKey, { type: "json" })) || {};
      const nextRow = mergeRow(currentRow, patch, appendContactLog);

      await store.setJSON(blobKey, nextRow);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true, rowKey, row: nextRow }),
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
