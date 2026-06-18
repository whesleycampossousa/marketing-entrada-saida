// Netlify Function - saidas reais do extrato financeiro do Asaas.
// Usa financialTransactions para refletir despesas/ajustes de caixa no lucro distribuivel.

const BASE = "https://api.asaas.com/v3";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function todaySaoPaulo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function currentMonthStart(dateStr) {
  return `${String(dateStr).slice(0, 7)}-01`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function classifyTransaction(transaction) {
  const type = transaction.type || "";
  const description = normalizeText(transaction.description);

  if (type === "PAYMENT_FEE" || type === "PAYMENT_FEE_REVERSAL") {
    if (description.includes("cartao")) {
      return {
        key: "taxa_cartao",
        label: type === "PAYMENT_FEE_REVERSAL"
          ? "Reversao de taxa de cartao de credito"
          : "Desconto da taxa de cartao de credito",
      };
    }
    if (description.includes("pix")) {
      return {
        key: "taxa_pix",
        label: type === "PAYMENT_FEE_REVERSAL"
          ? "Reversao de taxa Pix"
          : "Desconto da taxa Pix",
      };
    }
    return {
      key: "taxa_pagamento",
      label: type === "PAYMENT_FEE_REVERSAL"
        ? "Reversao de taxa de pagamento"
        : "Desconto da taxa de pagamento",
    };
  }

  if (type === "RECEIVABLE_ANTICIPATION_FEE") {
    return { key: "antecipacao", label: "Taxa de antecipacao" };
  }

  if (type === "RECEIVABLE_ANTICIPATION_DEBIT") {
    return { key: "baixa_antecipacao", label: "Baixa de antecipacao (ajuste de caixa)" };
  }

  if (type === "PAYMENT_REVERSAL") {
    return { key: "estorno", label: "Estorno de pagamento" };
  }

  if (type === "PAYMENT_MESSAGING_NOTIFICATION_FEE" || type === "INSTANT_TEXT_MESSAGE_FEE") {
    return { key: "mensagens", label: "Descontos das mensagens enviadas pela plataforma" };
  }

  if (type === "TRANSFER") {
    return { key: "transferencia", label: "Transferencia/saida Pix" };
  }

  return { key: "outras_saidas", label: "Outras saidas do extrato Asaas" };
}

function isEverydayTransfer(transaction) {
  return transaction.type === "TRANSFER" &&
    normalizeText(transaction.description).includes("everyday conversation");
}

function shouldIncludeTransaction(transaction) {
  const rawValue = Number(transaction.value) || 0;
  if (rawValue < 0) return !isEverydayTransfer(transaction);

  // Reversoes positivas reduzem a despesa registrada no extrato.
  return rawValue > 0 && transaction.type === "PAYMENT_FEE_REVERSAL";
}

function extractInvoiceNumber(description) {
  const match = String(description || "").match(/fatura nr\.\s*(\d+)/i);
  return match ? match[1] : null;
}

function getPairedAnticipationInvoices(transactions) {
  const receivedInvoices = new Set();
  const debitInvoices = new Set();

  for (const transaction of transactions) {
    const invoice = extractInvoiceNumber(transaction.description);
    if (!invoice) continue;

    if (transaction.type === "PAYMENT_RECEIVED" && (Number(transaction.value) || 0) > 0) {
      receivedInvoices.add(invoice);
    }
    if (transaction.type === "RECEIVABLE_ANTICIPATION_DEBIT" && (Number(transaction.value) || 0) < 0) {
      debitInvoices.add(invoice);
    }
  }

  return new Set([...receivedInvoices].filter((invoice) => debitInvoices.has(invoice)));
}

async function fetchTransactions({ startDate, finishDate, headers }) {
  const transactions = [];
  let offset = 0;

  while (true) {
    const url = new URL(`${BASE}/financialTransactions`);
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("finishDate", finishDate);
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("order", "asc");

    const resp = await fetch(url.toString(), { headers });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.errors?.[0]?.description || data?.error || `Erro Asaas ${resp.status}`);
    }

    transactions.push(...(data.data || []));
    if (!data.hasMore) break;
    offset += 100;
  }

  return transactions.filter((transaction) => {
    const date = String(transaction.date || "").slice(0, 10);
    return date >= startDate && date <= finishDate;
  });
}

export async function handler(event) {
  const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
  if (!ASAAS_API_KEY) {
    return jsonResponse(500, { error: "ASAAS_API_KEY nao configurada" });
  }

  const params = event.queryStringParameters || {};
  const today = todaySaoPaulo();
  const startDate = params.inicio || currentMonthStart(today);
  const finishDate = params.fim || today;
  const headers = {
    "Content-Type": "application/json",
    access_token: ASAAS_API_KEY,
  };

  try {
    const transactions = await fetchTransactions({ startDate, finishDate, headers });
    const pairedAnticipationInvoices = getPairedAnticipationInvoices(transactions);
    const descontos = [];
    let ignoredEverydayTransferTotal = 0;
    let ignoredEverydayTransferCount = 0;
    let ignoredAnticipationDebitTotal = 0;
    let ignoredAnticipationDebitCount = 0;

    for (const transaction of transactions) {
      const rawValue = Number(transaction.value) || 0;
      if (rawValue === 0) continue;

      if (rawValue < 0 && isEverydayTransfer(transaction)) {
        ignoredEverydayTransferTotal = roundMoney(ignoredEverydayTransferTotal + Math.abs(rawValue));
        ignoredEverydayTransferCount += 1;
        continue;
      }

      const invoice = extractInvoiceNumber(transaction.description);
      if (
        rawValue < 0 &&
        transaction.type === "RECEIVABLE_ANTICIPATION_DEBIT" &&
        invoice &&
        pairedAnticipationInvoices.has(invoice)
      ) {
        ignoredAnticipationDebitTotal = roundMoney(ignoredAnticipationDebitTotal + Math.abs(rawValue));
        ignoredAnticipationDebitCount += 1;
        continue;
      }

      if (!shouldIncludeTransaction(transaction)) continue;

      const category = classifyTransaction(transaction);
      const valor = roundMoney(rawValue < 0 ? Math.abs(rawValue) : -rawValue);
      descontos.push({
        id: transaction.id || `${transaction.date}-${transaction.type}-${descontos.length}`,
        data: transaction.date || "",
        categoria: category.key,
        categoriaLabel: category.label,
        tipo: transaction.type || "",
        descricao: transaction.description || "",
        valor,
        valorOriginal: roundMoney(rawValue),
      });
    }

    descontos.sort((a, b) => {
      const dateCompare = String(a.data).localeCompare(String(b.data));
      if (dateCompare !== 0) return dateCompare;
      return String(a.categoria).localeCompare(String(b.categoria)) ||
        String(a.descricao).localeCompare(String(b.descricao));
    });

    const resumo = descontos.reduce((acc, item) => {
      acc.total = roundMoney(acc.total + item.valor);
      if (item.categoria === "taxa_cartao") acc.taxaCartao = roundMoney(acc.taxaCartao + item.valor);
      if (item.categoria === "taxa_pix") acc.taxaPix = roundMoney(acc.taxaPix + item.valor);
      if (item.categoria === "taxa_pagamento") acc.taxaPagamento = roundMoney(acc.taxaPagamento + item.valor);
      if (item.categoria === "antecipacao") acc.antecipacao = roundMoney(acc.antecipacao + item.valor);
      if (item.categoria === "baixa_antecipacao") acc.baixaAntecipacao = roundMoney(acc.baixaAntecipacao + item.valor);
      if (item.categoria === "estorno") acc.estornos = roundMoney(acc.estornos + item.valor);
      if (item.categoria === "mensagens") acc.mensagens = roundMoney(acc.mensagens + item.valor);
      if (item.categoria === "transferencia") acc.transferencias = roundMoney(acc.transferencias + item.valor);
      if (item.categoria === "outras_saidas") acc.outrasSaidas = roundMoney(acc.outrasSaidas + item.valor);
      acc.quantidade += 1;
      return acc;
    }, {
      total: 0,
      taxaCartao: 0,
      taxaPix: 0,
      taxaPagamento: 0,
      antecipacao: 0,
      baixaAntecipacao: 0,
      estornos: 0,
      mensagens: 0,
      transferencias: 0,
      outrasSaidas: 0,
      quantidade: 0,
      ignoredEverydayTransferTotal,
      ignoredEverydayTransferCount,
      ignoredAnticipationDebitTotal,
      ignoredAnticipationDebitCount,
      periodo: { inicio: startDate, fim: finishDate },
      atualizadoEm: new Date().toISOString(),
    });

    return jsonResponse(200, { resumo, descontos });
  } catch (error) {
    return jsonResponse(500, { error: error.message });
  }
}
