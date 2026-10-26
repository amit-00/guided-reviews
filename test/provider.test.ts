import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { demoTour } from "../src/demo.js";
import { generate, ask, DEFAULT_MODEL } from "../src/core/provider.js";

test("OpenAI backend requests structured Sol output, repairs invalid evidence once, and grounds follow-up answers", async (t) => {
  const tour = demoTour();
  const originalKey = process.env.OPENAI_API_KEY,
    originalBase = process.env.OPENAI_BASE_URL;
  let calls = 0;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    calls++;
    let output: unknown;
    if (calls <= 2) {
      output = structuredClone(tour.plan);
      if (calls === 1)
        (output as typeof tour.plan).steps[0].evidence[0].endLine = 999;
    } else {
      output = {
        answer: "The same order ID produces the same key.",
        evidence: [tour.plan.steps[0].evidence[0]],
        limitations: ["Provider behavior is not shown."],
      };
      if (calls === 4) (output as any).evidence[0].endLine = 999;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(output),
                annotations: [],
              },
            ],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  process.env.OPENAI_API_KEY = "test-only-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  t.after(() => {
    server.close();
    server.closeAllConnections();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
  });
  const options = { provider: "openai" as const, model: DEFAULT_MODEL };
  const result = await generate(tour.inventory, options);
  assert.equal(calls, 2);
  assert.equal(result.unanalyzed.length, 0);
  assert.equal(result.model, "gpt-6.1-sol");
  assert.equal(requests[0].text.format.type, "json_schema");
  assert.equal(requests[0].text.format.strict, true);
  assert.match(requests[1].input, /failed deterministic validation/);
  const answer = await ask(
    result,
    result.plan.steps[0].id,
    "What ensures retries use the same key?",
    options,
  );
  assert.match(answer.answer, /same order ID/);
  await assert.rejects(
    ask(result, result.plan.steps[0].id, "What is the guarantee?", options),
    /Invalid evidence/,
  );
  await assert.rejects(
    ask(result, "missing-step", "Question?", options),
    /Unknown tour step/,
  );
});
