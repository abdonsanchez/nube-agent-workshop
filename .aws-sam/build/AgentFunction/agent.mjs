import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const model = new BedrockModel({
  modelId: "global.anthropic.claude-sonnet-4-6",
});

// ---------- Memory: same load/save as Module 2 ----------

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

// ---------- Tools: things your agent can DECIDE to do ----------

const lookUpProduct = tool({
  name: "look_up_product",
  description:
    "Look up a product in the store catalog by name. The catalog is stored " +
    "in English, so always translate the product name to English before " +
    "searching (e.g. 'micrófono' -> 'microphone'). " +
    "The search is partial/fuzzy — a generic word like 'battery' or 'guitar' is enough. " +
    "Always search first; never ask the customer for more details before trying.",
  inputSchema: z.object({
    product_name: z.string().describe("The product to search for, in English. A single generic word is fine, e.g. 'battery'"),
  }),
  callback: async ({ product_name }) => {
    const resp = await ddb.send(new ScanCommand({ TableName: process.env.PRODUCTS_TABLE }));
    const matches = resp.Items.filter((item) =>
      item.name.toLowerCase().includes(product_name.toLowerCase())
    );
    if (matches.length === 0) return `No products found matching '${product_name}'.`;
    return JSON.stringify(matches);
  },
});

const checkStock = tool({
  name: "check_stock",
  description:
    "Check whether a specific product is in stock. The catalog is stored " +
    "in English, so always translate the product name to English before " +
    "searching (e.g. 'micrófono' -> 'microphone').",
  inputSchema: z.object({
    product_name: z.string().describe("The product to check stock for, in English, e.g. 'guitar'"),
  }),
  callback: async ({ product_name }) => {
    const resp = await ddb.send(new ScanCommand({ TableName: process.env.PRODUCTS_TABLE }));
    const match = resp.Items.find((item) =>
      item.name.toLowerCase().includes(product_name.toLowerCase())
    );
    if (!match) return `No product found matching '${product_name}'.`;
    const inStock = match.stock !== undefined ? Number(match.stock) > 0 : match.in_stock === true;
    return inStock
      ? `'${match.name}' is in stock.`
      : `'${match.name}' is currently out of stock.`;
  },
});

const checkShipping = tool({
  name: "check_shipping",
  description: "Check shipping time to a country.",
  inputSchema: z.object({
    country: z.string().describe("Destination country, e.g. 'Brazil'"),
  }),
  callback: ({ country }) => {
    const days = { brazil: 3, mexico: 2, colombia: 4, argentina: 5, chile: 4, peru: 4, "united states": 2 };
    const d = days[country.trim().toLowerCase()];
    if (d === undefined) return `Sorry, we don't ship to ${country} yet.`;
    return `Shipping to ${country} takes about ${d} business days.`;
  },
});

const applyDiscount = tool({
  name: "apply_discount",
  description: "Apply a coupon code to a price. Use this whenever the customer mentions a coupon or discount code.",
  inputSchema: z.object({
    price: z.number().describe("The original price as a number, e.g. 299.99"),
    coupon_code: z.string().describe("The coupon code provided by the customer, e.g. 'SAVE10'"),
  }),
  callback: ({ price, coupon_code }) => {
    if (coupon_code.trim().toUpperCase() === "SAVE10") {
      const discounted = (price * 0.9).toFixed(2);
      return `Coupon SAVE10 applied! Original price: $${price.toFixed(2)} → Discounted price: $${discounted} (10% off).`;
    }
    return `Sorry, the coupon code '${coupon_code}' is not valid. No discount applied. Price remains $${price.toFixed(2)}.`;
  },
});

const storeHours = tool({
  name: "store_hours",
  description: "Return the store's opening hours for a given day of the week.",
  inputSchema: z.object({
    day: z.string().describe("Day of the week in English, e.g. 'Monday'"),
  }),
  callback: ({ day }) => {
    const hours = {
      monday: "9:00–18:00",
      tuesday: "9:00–18:00",
      wednesday: "9:00–18:00",
      thursday: "9:00–20:00",
      friday: "9:00–20:00",
      saturday: "10:00–16:00",
      sunday: "Closed",
    };
    const h = hours[day.trim().toLowerCase()];
    if (!h) return `I don't recognise '${day}' as a day of the week.`;
    return h === "Closed"
      ? `We're closed on ${day}. See you another day, matey!`
      : `On ${day} the store is open from ${h}.`;
  },
});

const SYSTEM_PROMPT =
  "Arr, ye be speakin' to Captain Nube, the swashbucklin' shop assistant of the high seas! " +
  "Use yer tools to answer questions about products, stock, shipping, store hours, and discounts. " +
  "Speak like a friendly pirate — short, fun, and helpful. Sprinkle in a 'arr', 'matey', or 'ahoy' now and then, but keep answers brief. " +
  "CRITICAL RULE: Whenever a customer mentions ANY product — even a vague word like 'battery' or 'guitarra' — you MUST call look_up_product RIGHT AWAY with a single English keyword. " +
  "Do NOT ask for clarification. Do NOT explain what you need. Just call the tool immediately, show the results, then apply any coupon. " +
  "Asking the customer for more information before searching is forbidden.";

export async function* answerWith(message, sessionId) {
  const history = await loadHistory(sessionId);
  const agent = new Agent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    messages: history,
    tools: [lookUpProduct, checkStock, checkShipping, applyDiscount, storeHours],
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