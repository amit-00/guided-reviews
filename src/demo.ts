import { randomUUID } from "node:crypto";
import { validateTour, type Tour } from "./core/schema.js";
export function demoTour(): Tour {
  const old =
    "export async function charge(order, payments) {\n  return payments.createCharge(order.total);\n}\n";
  const current =
    'export async function charge(order, payments) {\n  if (!order.id) throw new Error("Order ID required");\n  return payments.createCharge(order.total, {\n    idempotencyKey: `order:${order.id}`,\n  });\n}\n';
  const test =
    'test("retries share a payment key", async () => {\n  await charge(order, payments);\n  await charge(order, payments);\n  expect(payments.keys).toEqual(["order:42", "order:42"]);\n});\n';
  const tour: Tour = {
    version: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    provider: "demo",
    model: "Hand-authored example · no model call",
    inventory: {
      repoName: "checkout-example",
      baseRef: "main",
      headRef: "feature/payment-retries",
      baseCommit: "a".repeat(40),
      mergeBase: "a".repeat(40),
      headCommit: "b".repeat(40),
      snapshots: [
        { path: "src/charge.ts", side: "base", content: old },
        { path: "src/charge.ts", side: "head", content: current },
        { path: "test/charge.test.ts", side: "head", content: test },
      ],
      hunks: [
        {
          id: "h1",
          path: "src/charge.ts",
          oldPath: "src/charge.ts",
          status: "M",
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 6,
          kind: "text",
          limitation: null,
          diff: '@@ -1,3 +1,6 @@\n export async function charge(order, payments) {\n-  return payments.createCharge(order.total);\n+  if (!order.id) throw new Error("Order ID required");\n+  return payments.createCharge(order.total, {\n+    idempotencyKey: `order:${order.id}`,\n+  });\n }\n',
        },
        {
          id: "h2",
          path: "test/charge.test.ts",
          oldPath: "test/charge.test.ts",
          status: "A",
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 5,
          kind: "text",
          limitation: null,
          diff:
            "@@ -0,0 +1,5 @@\n" +
            test
              .trimEnd()
              .split("\n")
              .map((l) => "+" + l)
              .join("\n"),
        },
      ],
      limitations: [
        "This is a hand-authored demonstration, not an analysis of your repository.",
      ],
    },
    plan: {
      title: "Make payment retries safe",
      summary:
        "Follow the payment boundary, inspect the identity used for retries, and check what the tests actually establish.",
      architecture:
        "Order → charge() → payment provider. This change adds a stable order identity at the external payment boundary. The provider remains responsible for deduplicating requests.",
      steps: [
        {
          id: "payment-boundary",
          title: "Follow the payment boundary",
          category: "integration",
          before: "Each call creates a charge with only an amount.",
          after:
            "Each call supplies an order-scoped idempotency key and rejects a missing order ID.",
          why: "A retry after a timeout may repeat an already successful payment. The key gives the provider a way to recognize that repeat.",
          questions: [
            "Is order.id stable and unique across every tenant?",
            "Does the provider guarantee deduplication, and for how long?",
            "What happens if the amount changes between attempts?",
          ],
          uncertainties: [
            "The payment adapter and provider contract are not included here. Passing a key does not prove duplicate charges are prevented.",
          ],
          hunkIds: ["h1"],
          evidence: [
            {
              path: "src/charge.ts",
              side: "head",
              startLine: 1,
              endLine: 6,
              explanation:
                "The stable key is constructed where the application calls the payment provider.",
            },
            {
              path: "src/charge.ts",
              side: "base",
              startLine: 1,
              endLine: 3,
              explanation: "Previously the call supplied only the amount.",
            },
          ],
        },
        {
          id: "retry-evidence",
          title: "Check the retry guarantee",
          category: "tests",
          before: "This change introduces a retry-focused test.",
          after: "The test checks that two attempts pass the same key.",
          why: "It demonstrates key stability, but does not simulate a successful charge followed by a lost response.",
          questions: [
            "Should an integration test exercise timeout-after-success?",
            "Where is the missing-order-ID case tested?",
          ],
          uncertainties: [
            "Tests have not been executed. Provider-side deduplication is not established by this assertion.",
          ],
          hunkIds: ["h2"],
          evidence: [
            {
              path: "test/charge.test.ts",
              side: "head",
              startLine: 1,
              endLine: 5,
              explanation: "Both attempts are checked for a shared key.",
            },
          ],
        },
      ],
      supporting: [],
      limitations: ["Completing these steps does not approve the change."],
    },
    unanalyzed: [],
  };
  return validateTour(tour);
}
