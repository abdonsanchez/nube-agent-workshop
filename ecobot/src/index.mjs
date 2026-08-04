import { CHAT_HTML } from "./chat-page.mjs";
import { answerWith } from "./agent.mjs";

export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    if (event.httpMethod === "GET") {
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
      responseStream.write(CHAT_HTML);
      responseStream.end();
      return;
    }

    responseStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
    });
    const send = (obj) => responseStream.write(JSON.stringify(obj) + "\n");

    try {
      const { message, sessionId } = JSON.parse(event.body ?? "{}");
      for await (const chunk of answerWith(message ?? "Hola!", sessionId ?? "no-session")) {
        send(chunk);
      }
      send({ type: "done" });
    } catch (err) {
      send({ type: "error", text: `${err.name}: ${err.message}` });
    }
    responseStream.end();
  }
);
