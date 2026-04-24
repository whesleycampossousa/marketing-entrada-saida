const ASAAS_BASE = "https://api.asaas.com/v3";
const OPEN_PAYMENT_STATUSES = new Set(["PENDING", "OVERDUE"]);

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

async function asaasRequest(path, options = {}) {
  const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
  if (!ASAAS_API_KEY) throw new Error("ASAAS_API_KEY nao configurada");

  const resp = await fetch(`${ASAAS_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      access_token: ASAAS_API_KEY,
      ...(options.headers || {}),
    },
  });

  let data = null;
  const text = await resp.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!resp.ok) {
    const message = data?.errors?.[0]?.description || data?.error || data?.message || `Erro Asaas ${resp.status}`;
    const error = new Error(message);
    error.status = resp.status;
    error.data = data;
    throw error;
  }

  return data || {};
}

async function listSubscriptionPayments(subscriptionId) {
  const payments = [];
  let offset = 0;

  while (true) {
    const result = await asaasRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=100&offset=${offset}`);
    const batch = result.data || [];
    payments.push(...batch);
    if (!result.hasMore) break;
    offset += 100;
  }

  return payments;
}

async function getPayment(paymentId) {
  if (!paymentId) return null;
  try {
    return await asaasRequest(`/payments/${encodeURIComponent(paymentId)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function deletePayment(paymentId) {
  return asaasRequest(`/payments/${encodeURIComponent(paymentId)}`, { method: "DELETE" });
}

async function deleteSubscription(subscriptionId) {
  return asaasRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "DELETE" });
}

function uniqById(items) {
  const map = new Map();
  for (const item of items) {
    if (item?.id) map.set(item.id, item);
  }
  return [...map.values()];
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const {
      provider,
      rowKey,
      customerId,
      paymentId,
      subscriptionId,
      studentName,
      reason,
    } = body;

    if (provider !== "asaas") {
      return json(400, { error: "Cancelamento automatico disponivel apenas para Asaas nesta versao" });
    }

    if (!rowKey || typeof rowKey !== "string") {
      return json(400, { error: "Campo 'rowKey' obrigatorio" });
    }

    if (!paymentId && !subscriptionId && !customerId) {
      return json(400, { error: "Informe paymentId, subscriptionId ou customerId" });
    }

    const deletedPayments = [];
    const skippedPayments = [];
    const errors = [];

    let subscriptionDeleted = false;
    let subscriptionDeleteResponse = null;
    let openPayments = [];

    if (subscriptionId) {
      try {
        const subscriptionPayments = await listSubscriptionPayments(subscriptionId);
        openPayments.push(...subscriptionPayments.filter((payment) => OPEN_PAYMENT_STATUSES.has(payment.status)));
      } catch (error) {
        errors.push({
          step: "list-subscription-payments",
          id: subscriptionId,
          message: error.message,
        });
      }
    }

    if (paymentId && !openPayments.some((payment) => payment.id === paymentId)) {
      try {
        const payment = await getPayment(paymentId);
        if (payment && OPEN_PAYMENT_STATUSES.has(payment.status)) {
          openPayments.push(payment);
        } else if (payment) {
          skippedPayments.push({ id: payment.id, status: payment.status, reason: "status_nao_aberto" });
        }
      } catch (error) {
        errors.push({ step: "get-payment", id: paymentId, message: error.message });
      }
    }

    openPayments = uniqById(openPayments);

    for (const payment of openPayments) {
      try {
        await deletePayment(payment.id);
        deletedPayments.push({
          id: payment.id,
          status: payment.status,
          dueDate: payment.dueDate || null,
          value: payment.value ?? payment.netValue ?? payment.originalValue ?? null,
        });
      } catch (error) {
        errors.push({ step: "delete-payment", id: payment.id, message: error.message });
      }
    }

    if (subscriptionId) {
      try {
        subscriptionDeleteResponse = await deleteSubscription(subscriptionId);
        subscriptionDeleted = true;
      } catch (error) {
        errors.push({ step: "delete-subscription", id: subscriptionId, message: error.message });
      }
    }

    const paymentDeletionComplete = openPayments.length === deletedPayments.length;
    const subscriptionCancellationComplete = subscriptionId ? subscriptionDeleted : true;
    const ok = subscriptionCancellationComplete && paymentDeletionComplete && (subscriptionId || deletedPayments.length > 0);
    const partial = errors.length > 0 || !paymentDeletionComplete || !subscriptionCancellationComplete;

    return json(ok ? 200 : 500, {
      ok,
      partial,
      provider,
      rowKey,
      customerId: customerId || null,
      studentName: studentName || null,
      reason: reason || null,
      paymentId: paymentId || null,
      subscriptionId: subscriptionId || null,
      subscriptionDeleted,
      subscriptionDeleteResponse,
      deletedPayments,
      skippedPayments,
      errors,
      cancelledAt: new Date().toISOString(),
    });
  } catch (error) {
    return json(500, { error: error.message });
  }
}
