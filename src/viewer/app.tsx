import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Tour, Progress, Evidence, Hunk } from "../core/schema.js";
import "./style.css";

type Payload = {
  tour: Tour;
  progress: Progress;
  freshness: string;
  canAsk: boolean;
};
type Answer = { answer: string; evidence: Evidence[]; limitations: string[] };
const token =
  location.hash.slice(1) || sessionStorage.getItem("guided-review-token") || "";
if (token) sessionStorage.setItem("guided-review-token", token);
history.replaceState(null, "", location.pathname);
async function api<T>(route: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api/${route}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}
function Diff({ hunk }: { hunk: Hunk }) {
  let old = hunk.oldStart,
    next = hunk.newStart;
  return (
    <div className="diff" aria-label={`Diff for ${hunk.path}`}>
      {hunk.diff ? (
        hunk.diff
          .trimEnd()
          .split("\n")
          .map((line, index) => {
            const meta =
              /^(?:@@|diff |index |---|\+\+\+|rename |similarity |old mode|new mode|new file|deleted file|Binary)/.test(
                line,
              );
            const added = !meta && line.startsWith("+"),
              removed = !meta && line.startsWith("-");
            const source = !meta && !line.startsWith("\\");
            const a = source && !added ? old++ : "",
              b = source && !removed ? next++ : "";
            return (
              <div
                className={`code-row ${meta ? "meta" : added ? "added" : removed ? "removed" : ""}`}
                key={index}
              >
                <span className="line-no">{a}</span>
                <span className="line-no">{b}</span>
                <code>{line || " "}</code>
              </div>
            );
          })
      ) : (
        <p className="empty">
          Source omitted. {hunk.limitation ?? "Metadata-only change."}
        </p>
      )}
    </div>
  );
}
function Source({ tour, evidence }: { tour: Tour; evidence: Evidence }) {
  const [expanded, setExpanded] = useState(false);
  const snapshot = tour.inventory.snapshots.find(
    (s) => s.path === evidence.path && s.side === evidence.side,
  )!;
  const lines = snapshot.content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = expanded ? 0 : Math.max(0, evidence.startLine - 4);
  const last = expanded
    ? lines.length
    : Math.min(lines.length, evidence.endLine + 3);
  return (
    <section className="source-card">
      <div className="file-bar">
        <span>{evidence.path}</span>
        <span className="badge">
          {evidence.side === "base" ? "Before" : "After"}
        </span>
      </div>
      <p className="source-caption">{evidence.explanation}</p>
      <div className="source-code">
        {lines.slice(first, last).map((line, index) => (
          <div
            key={first + index}
            className={`code-row ${first + index + 1 >= evidence.startLine && first + index + 1 <= evidence.endLine ? "highlight" : ""}`}
          >
            <span className="line-no">{first + index + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
      <button className="text-button" onClick={() => setExpanded(!expanded)}>
        {expanded
          ? "Focus on cited lines"
          : `Expand full file · ${lines.length} lines`}
      </button>
    </section>
  );
}
function App() {
  const [payload, setPayload] = useState<Payload>();
  const [error, setError] = useState("");
  const [index, setIndex] = useState(-1);
  const [inventory, setInventory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  useEffect(() => {
    const refresh = () => {
      api<Payload>("tour")
        .then(setPayload)
        .catch((e) => setError(e.message));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const count = payload?.tour.plan.steps.length ?? 0;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, button, select"))
        return;
      if (e.key === "ArrowRight") {
        setInventory(false);
        setIndex((i) => Math.min(count - 1, i + 1));
      }
      if (e.key === "ArrowLeft") {
        setInventory(false);
        setIndex((i) => Math.max(-1, i - 1));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [count]);
  if (!payload)
    return (
      <div className="loading">
        <div className="brand">◎ guided review</div>
        <p role={error ? "alert" : "status"}>
          {error || "Opening your review…"}
        </p>
      </div>
    );
  const { tour, progress, freshness, canAsk } = payload;
  const { plan, inventory: inv } = tour;
  const step = index < 0 ? undefined : plan.steps[index];
  const reviewed = Object.values(progress.steps).filter(
    (s) => s === "reviewed",
  ).length;
  const followups = Object.values(progress.steps).filter(
    (s) => s === "follow-up",
  ).length;
  const primary = plan.steps.flatMap((s) => s.hunkIds).length;
  const supporting = plan.supporting.flatMap((g) => g.hunkIds).length;
  const answer = step ? answers[step.id] : undefined;
  const navigate = (next: number) => {
    setIndex(next);
    setInventory(false);
    setQuestion("");
    setError("");
  };
  async function mark(status: "reviewed" | "follow-up") {
    if (!step || !payload) return;
    setSaving(true);
    setError("");
    const steps = { ...progress.steps };
    if (steps[step.id] === status) delete steps[step.id];
    else steps[step.id] = status;
    try {
      const saved = await api<Progress>("progress", { tourId: tour.id, steps });
      setPayload((p) => p && { ...p, progress: saved });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function askQuestion(e: React.FormEvent) {
    e.preventDefault();
    if (!step) return;
    const stepId = step.id;
    setAsking(true);
    setError("");
    try {
      const result = await api<Answer>("ask", { stepId, question });
      setAnswers((a) => ({ ...a, [stepId]: result }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }
  return (
    <>
      <header className="topbar">
        <div className="brand">
          ◎ <span>guided review</span>
        </div>
        <div className="repo">
          {inv.repoName}
          <span className="divider">/</span>
          <span>{inv.headRef}</span>
        </div>
        <span className="local">
          <span className="dot" />
          Local session
        </span>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <div className="eyebrow">YOUR REVIEW PATH</div>
          <button
            className={`nav-item overview ${index === -1 && !inventory ? "active" : ""}`}
            onClick={() => navigate(-1)}
          >
            <span className="nav-number">⌘</span>
            <span>
              The big picture<small>Architecture & change overview</small>
            </span>
          </button>
          <div className="nav-stops">
            {plan.steps.map((s, n) => (
              <button
                key={s.id}
                className={`nav-item ${index === n && !inventory ? "active" : ""}`}
                onClick={() => navigate(n)}
              >
                <span className={`nav-number ${progress.steps[s.id] ?? ""}`}>
                  {progress.steps[s.id] === "reviewed"
                    ? "✓"
                    : progress.steps[s.id] === "follow-up"
                      ? "!"
                      : String(n + 1).padStart(2, "0")}
                </span>
                <span>
                  {s.title}
                  <small>{s.category.replace("-", " ")}</small>
                </span>
              </button>
            ))}
          </div>
          <button
            className={`nav-item ${inventory ? "active" : ""}`}
            onClick={() => setInventory(true)}
          >
            <span className="nav-number">≡</span>
            <span>
              All changes
              <small>{inv.hunks.length} change units accounted for</small>
            </span>
          </button>
          <div className="progress">
            <div>
              <strong>
                {reviewed} of {count}
              </strong>{" "}
              stops reviewed
            </div>
            <progress value={reviewed} max={Math.max(1, count)} />
            <small>
              {followups ? `${followups} flagged for follow-up · ` : ""}Progress
              saved on this machine
            </small>
          </div>
          <div className="revision">
            <span>BASE {inv.mergeBase.slice(0, 7)}</span>
            <span>HEAD {inv.headCommit.slice(0, 7)}</span>
          </div>
        </aside>
        <main>
          {freshness === "stale" && (
            <div className="notice">
              Revisions have changed. This tour shows an older snapshot.
              Generate a new tour to review the current change; these marks
              apply only to this snapshot.
            </div>
          )}
          {freshness === "unknown" && tour.provider !== "demo" && (
            <div className="notice subtle">
              Saved snapshot · current branch freshness is unknown. Reopen with
              --repo to check revisions.
            </div>
          )}
          {tour.provider === "demo" && (
            <div className="notice subtle">
              Example tour · hand-authored to demonstrate the experience. No
              source was sent to a model.
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {inventory ? (
            <div className="wide-content">
              <div className="eyebrow">COMPLETE CHANGE INVENTORY</div>
              <h1>Nothing disappears.</h1>
              <p className="lede">
                Every change is in a tour stop, supporting context, or
                explicitly left for your attention.
              </p>
              <div className="metrics">
                <div>
                  <strong>{primary}</strong>In the tour
                </div>
                <div>
                  <strong>{supporting}</strong>Supporting
                </div>
                <div>
                  <strong>{tour.unanalyzed.length}</strong>Not analyzed
                </div>
              </div>
              {inv.hunks.map((h) => {
                const stop = plan.steps.find((s) => s.hunkIds.includes(h.id));
                const group = plan.supporting.find((g) =>
                  g.hunkIds.includes(h.id),
                );
                const missing = tour.unanalyzed.find((u) => u.hunkId === h.id);
                return (
                  <details className="hunk-card" key={h.id}>
                    <summary>
                      <span className="badge">{h.id}</span>{" "}
                      {h.oldPath !== h.path ? `${h.oldPath} → ` : ""}
                      {h.path}
                      <span
                        className={`coverage ${missing ? "attention" : ""}`}
                      >
                        {stop
                          ? "Tour stop"
                          : group
                            ? "Supporting"
                            : "Not analyzed"}
                      </span>
                    </summary>
                    <div className="hunk-context">
                      {stop ? (
                        <button
                          className="text-button"
                          onClick={() => navigate(plan.steps.indexOf(stop))}
                        >
                          Open: {stop.title} →
                        </button>
                      ) : (
                        (group?.reason ?? missing?.reason)
                      )}
                    </div>
                    <Diff hunk={h} />
                  </details>
                );
              })}
            </div>
          ) : !step ? (
            <div className="wide-content overview-page">
              <div className="eyebrow">UNDERSTAND THE CHANGE</div>
              <h1>{plan.title}</h1>
              <p className="lede">{plan.summary}</p>
              <div className="overview-meta">
                <span>{count} focused stops</span>
                <span>
                  {new Set(inv.hunks.map((h) => h.path)).size} changed files
                </span>
                <span>{inv.hunks.length} change units</span>
              </div>
              <section className="architecture">
                <span className="eyebrow">HOW IT FITS TOGETHER</span>
                <p>{plan.architecture}</p>
              </section>
              <div className="section-heading">
                <h2>Your path through the change</h2>
                <span>Ordered by understanding</span>
              </div>
              <div className="path-list">
                {plan.steps.map((s, n) => (
                  <button key={s.id} onClick={() => navigate(n)}>
                    <span className="path-number">
                      {String(n + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <strong>{s.title}</strong>
                      <p>{s.why}</p>
                    </div>
                    <span>↗</span>
                  </button>
                ))}
              </div>
              <div className="coverage-summary">
                <div>
                  <strong>
                    {primary} in tour · {supporting} supporting ·{" "}
                    {tour.unanalyzed.length} not analyzed
                  </strong>
                  <p>
                    Coverage tracks where changes appear. It does not establish
                    correctness.
                  </p>
                </div>
                <button
                  className="secondary"
                  onClick={() => setInventory(true)}
                >
                  Inspect all changes
                </button>
              </div>
              <details className="limitations">
                <summary>
                  Scope & limitations (
                  {inv.limitations.length + plan.limitations.length})
                </summary>
                <ul>
                  {[...inv.limitations, ...plan.limitations].map((l, n) => (
                    <li key={n}>{l}</li>
                  ))}
                </ul>
                <p>
                  Generated with {tour.provider} / {tour.model}.{" "}
                  {new Date(tour.createdAt).toLocaleString()}
                </p>
              </details>
              {count > 0 && (
                <button className="primary" onClick={() => navigate(0)}>
                  Begin the review <span>→</span>
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="step-heading">
                <div className="eyebrow">
                  STOP {String(index + 1).padStart(2, "0")} /{" "}
                  {String(count).padStart(2, "0")}{" "}
                  <span>· {step.category.replace("-", " ")}</span>
                </div>
                <h1>{step.title}</h1>
                <p className="lede">{step.why}</p>
              </div>
              <div className="step-layout">
                <div className="code-panel">
                  <div className="section-heading">
                    <h2>Follow the evidence</h2>
                    <span>{step.evidence.length} references</span>
                  </div>
                  {step.evidence.map((e, n) => (
                    <Source key={`${step.id}-${n}`} tour={tour} evidence={e} />
                  ))}
                  {step.hunkIds.length > 0 && (
                    <details className="hunk-card">
                      <summary>
                        View changes for this stop ({step.hunkIds.length})
                      </summary>
                      {step.hunkIds.map((id) => (
                        <div key={id}>
                          <div className="file-bar">
                            {inv.hunks.find((h) => h.id === id)!.path}
                          </div>
                          <Diff hunk={inv.hunks.find((h) => h.id === id)!} />
                        </div>
                      ))}
                    </details>
                  )}
                </div>
                <aside className="guide-panel">
                  <section>
                    <div className="eyebrow">BEHAVIOR CHANGE</div>
                    <h3>Before</h3>
                    <p>{step.before}</p>
                    <h3>After</h3>
                    <p>{step.after}</p>
                  </section>
                  <section className="questions">
                    <div className="eyebrow">QUESTIONS WORTH ASKING</div>
                    {step.questions.map((q, n) => (
                      <p key={n}>
                        <span>{n + 1}</span>
                        {q}
                      </p>
                    ))}
                  </section>
                  {step.uncertainties.length > 0 && (
                    <section className="uncertainties">
                      <div className="eyebrow">STILL UNCERTAIN</div>
                      <ul>
                        {step.uncertainties.map((q, n) => (
                          <li key={n}>{q}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <section>
                    <div className="eyebrow">YOUR JUDGMENT</div>
                    <div className="review-actions">
                      <button
                        disabled={saving}
                        className={
                          progress.steps[step.id] === "reviewed"
                            ? "primary"
                            : "secondary"
                        }
                        onClick={() => mark("reviewed")}
                      >
                        ✓{" "}
                        {progress.steps[step.id] === "reviewed"
                          ? "Reviewed"
                          : "Mark reviewed"}
                      </button>
                      <button
                        disabled={saving}
                        className={
                          progress.steps[step.id] === "follow-up"
                            ? "flagged"
                            : "secondary"
                        }
                        onClick={() => mark("follow-up")}
                      >
                        ⚑ Follow up
                      </button>
                    </div>
                    <small>A review mark applies to this snapshot only.</small>
                  </section>
                  <section>
                    <div className="eyebrow">EXPLORE THIS STOP</div>
                    {canAsk ? (
                      <form onSubmit={askQuestion}>
                        <label htmlFor="question">
                          Ask a follow-up question
                        </label>
                        <textarea
                          id="question"
                          value={question}
                          maxLength={4000}
                          onChange={(e) => setQuestion(e.target.value)}
                          placeholder="What happens if this operation fails?"
                        />
                        <button
                          className="secondary"
                          disabled={asking || !question.trim()}
                        >
                          {asking
                            ? "Examining the evidence…"
                            : "Ask about this code →"}
                        </button>
                        <small>
                          Uses the configured model. Answers stay in this
                          session.
                        </small>
                      </form>
                    ) : (
                      <p className="muted">
                        Follow-up questions are available on model-generated
                        tours.
                      </p>
                    )}
                    {answer && (
                      <div className="answer" aria-live="polite">
                        <p>{answer.answer}</p>
                        {answer.evidence.map((e, n) => (
                          <Source key={n} tour={tour} evidence={e} />
                        ))}
                        {answer.limitations.map((l, n) => (
                          <p className="muted" key={n}>
                            {l}
                          </p>
                        ))}
                      </div>
                    )}
                  </section>
                </aside>
              </div>
              <footer className="step-footer">
                <button
                  className="secondary"
                  onClick={() => navigate(index - 1)}
                >
                  ← {index === 0 ? "Overview" : "Previous"}
                </button>
                <span>Use ← → to navigate</span>
                {index < count - 1 ? (
                  <button
                    className="primary"
                    onClick={() => navigate(index + 1)}
                  >
                    Next stop →
                  </button>
                ) : (
                  <button
                    className="primary"
                    onClick={() => setInventory(true)}
                  >
                    Review coverage →
                  </button>
                )}
              </footer>
            </>
          )}
        </main>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
