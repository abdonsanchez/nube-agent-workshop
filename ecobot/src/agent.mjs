import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const model = new BedrockModel({
  modelId: "global.anthropic.claude-sonnet-4-6",
});

async function loadHistory(sessionId) {
  const resp = await ddb.send(new GetCommand({
    TableName: process.env.SESSIONS_TABLE,
    Key: { sessionId },
  }));
  return resp.Item ? JSON.parse(resp.Item.messages) : [];
}

async function saveHistory(sessionId, messages) {
  await ddb.send(new PutCommand({
    TableName: process.env.SESSIONS_TABLE,
    Item: {
      sessionId,
      messages: JSON.stringify(messages),
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    },
  }));
}

// ---------- Tools ----------

const checkItemCondition = tool({
  name: "check_item_condition",
  description:
    "Evaluate the type of defect or issue reported by the customer and return " +
    "the estimated item value in USD, whether it is repairable, and a severity label.",
  inputSchema: z.object({
    reason: z.string().describe(
      "The customer's description of the problem, e.g. 'broken screen', 'wrong color', 'missing part'"
    ),
  }),
  callback: ({ reason }) => {
    const r = reason.toLowerCase();

    // Defect classification table: [keywords] → { value, repairable, severity, category }
    const rules = [
      { keys: ["pantalla", "screen", "display"],        value: 80,  repairable: false, severity: "high",   category: "pantalla dañada" },
      { keys: ["batería", "battery", "carga"],           value: 25,  repairable: true,  severity: "medium", category: "problema de batería" },
      { keys: ["color", "color incorrecto", "wrong color"], value: 30, repairable: false, severity: "low", category: "color incorrecto" },
      { keys: ["pieza", "part", "missing", "falta"],    value: 15,  repairable: true,  severity: "low",    category: "pieza faltante" },
      { keys: ["no enciende", "no prende", "doesn't turn on", "dead"], value: 60, repairable: false, severity: "high", category: "no funciona" },
      { keys: ["roto", "broken", "crack", "golpe"],     value: 40,  repairable: false, severity: "high",   category: "daño físico" },
      { keys: ["equivocado", "wrong item", "wrong product", "incorrecto"], value: 35, repairable: false, severity: "medium", category: "producto incorrecto" },
    ];

    const match = rules.find(rule => rule.keys.some(k => r.includes(k)));
    if (match) {
      return JSON.stringify({
        category: match.category,
        estimatedValue: match.value,
        repairable: match.repairable,
        severity: match.severity,
      });
    }

    return JSON.stringify({
      category: "defecto general",
      estimatedValue: 20,
      repairable: false,
      severity: "low",
    });
  },
});

const calculateShippingImpact = tool({
  name: "calculate_shipping_impact",
  description:
    "Calculate the shipping cost in USD and CO₂ emissions in kg for returning " +
    "a product from the customer's location to the warehouse.",
  inputSchema: z.object({
    location: z.string().describe("Customer's city or country, e.g. 'Buenos Aires', 'Colombia'"),
  }),
  callback: ({ location }) => {
    const loc = location.toLowerCase().trim();

    // Shipping data: cost (USD) and CO₂ (kg) per region
    const regions = [
      { keys: ["buenos aires", "argentina"],             cost: 18, co2: 4.2 },
      { keys: ["bogotá", "bogota", "colombia"],          cost: 22, co2: 5.1 },
      { keys: ["ciudad de mexico", "mexico", "méxico"],  cost: 15, co2: 3.8 },
      { keys: ["santiago", "chile"],                     cost: 20, co2: 4.6 },
      { keys: ["lima", "peru", "perú"],                  cost: 24, co2: 5.5 },
      { keys: ["miami", "new york", "united states", "usa", "estados unidos"], cost: 12, co2: 2.9 },
      { keys: ["madrid", "spain", "españa"],             cost: 35, co2: 8.1 },
      { keys: ["são paulo", "sao paulo", "brasil", "brazil"], cost: 28, co2: 6.4 },
    ];

    const match = regions.find(r => r.keys.some(k => loc.includes(k)));
    if (match) {
      return JSON.stringify({ location, shippingCost: match.cost, co2Kg: match.co2 });
    }

    return JSON.stringify({ location, shippingCost: 30, co2Kg: 7.0 });
  },
});

const issueStoreCredit = tool({
  name: "issue_store_credit",
  description:
    "Issue a store credit (nota de crédito) to the customer as compensation, " +
    "avoiding a physical return shipment.",
  inputSchema: z.object({
    amount: z.number().describe("Credit amount in USD"),
    reason: z.string().describe("Short reason for the credit, e.g. 'defective battery'"),
  }),
  callback: ({ amount, reason }) => {
    const code = "ECO-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    return JSON.stringify({
      creditCode: code,
      amount,
      reason,
      message: `Nota de crédito emitida por $${amount.toFixed(2)} USD. Código: ${code}. Válida por 90 días.`,
    });
  },
});

const SYSTEM_PROMPT =
  "Eres EcoBot, el asistente de postventa sustentable de la tienda 'Nube'. " +
  "Tu misión es resolver devoluciones priorizando el impacto ambiental y el costo logístico. " +
  "Cuando un cliente reporte un problema con un producto, SIEMPRE debes: " +
  "1) Llamar check_item_condition con la descripción del problema. " +
  "2) Llamar calculate_shipping_impact con la ubicación del cliente. " +
  "3) Comparar el costo de envío con el valor del ítem. " +
  "   - Si el costo de envío es >= 40% del valor del ítem, recomienda emitir una nota de crédito " +
  "     y llama issue_store_credit en lugar de pedir la devolución física. " +
  "   - Si el costo de envío es < 40% del valor, procede con la devolución normal. " +
  "4) Siempre menciona las emisiones de CO₂ evitadas cuando elijas la nota de crédito. " +
  "Sé empático, breve y explica claramente la decisión en términos de ahorro y sustentabilidad. " +
  "Responde siempre en español.";

export async function* answerWith(message, sessionId) {
  const history = await loadHistory(sessionId);
  const agent = new Agent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    messages: history,
    tools: [checkItemCondition, calculateShippingImpact, issueStoreCredit],
    printer: false,
  });

  for await (const ev of agent.stream(message)) {
    if (ev.type === "modelStreamUpdateEvent" &&
        ev.event.type === "modelContentBlockDeltaEvent" &&
        ev.event.delta?.type === "textDelta") {
      yield { type: "token", text: ev.event.delta.text };
    } else if (ev.type === "beforeToolCallEvent") {
      yield { type: "tool", name: ev.toolUse?.name ?? "tool" };
    }
  }

  await saveHistory(sessionId, agent.messages);
}
