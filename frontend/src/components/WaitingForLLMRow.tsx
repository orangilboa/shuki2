import { useEffect, useState } from "react";
import type {
  DoneWaitingEventPayload,
  WaitingForLLMEventPayload
} from "../types";

/**
 * Live row rendered between a `waiting_for_llm` event and its matching
 * `done_waiting`. While waiting, ticks an elapsed-seconds counter at 250ms
 * cadence and announces updates via `aria-live="polite"`. When the matching
 * `done_waiting` arrives the row freezes to its final duration — no unmount,
 * so users can see how long the wait took even after the run completes.
 *
 * Replay-safe: `startTs` is the persisted `ev.ts` of the waiting event, so a
 * mid-run refresh resumes the counter relative to the original wall-clock
 * start rather than the page-load time.
 */
type Props = {
  startTs: number;
  waiting: WaitingForLLMEventPayload;
  done?: { payload: DoneWaitingEventPayload; ts: number };
};

function useElapsedMs(startTs: number, frozenAt?: number): number {
  const [elapsed, setElapsed] = useState<number>(() =>
    Math.max(0, (frozenAt ?? Date.now()) - startTs)
  );

  useEffect(() => {
    if (frozenAt !== undefined) {
      setElapsed(Math.max(0, frozenAt - startTs));
      return;
    }
    setElapsed(Math.max(0, Date.now() - startTs));
    const iv = window.setInterval(() => {
      setElapsed(Math.max(0, Date.now() - startTs));
    }, 250);
    return () => window.clearInterval(iv);
  }, [startTs, frozenAt]);

  return elapsed;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function WaitingForLLMRow({ startTs, waiting, done }: Props) {
  // Prefer the agent-reported durationMs when available; otherwise derive
  // from the `ts` of the done event.
  const frozenMs =
    done === undefined
      ? undefined
      : done.payload.durationMs ?? Math.max(0, done.ts - startTs);
  const elapsed = useElapsedMs(startTs, frozenMs);
  const isDone = done !== undefined;
  const ok = isDone ? done!.payload.ok !== false : true;

  const label = waiting.label ?? "waiting for LLM";
  const model = waiting.model;

  const icon = !isDone ? "⏳" : ok ? "✓" : "⚠";
  const statusText = !isDone
    ? label
    : ok
    ? "LLM responded"
    : "LLM call failed";

  return (
    <div
      className={`llm-wait-row${isDone ? " done" : ""}${
        isDone && !ok ? " failed" : ""
      }`}
      aria-live={isDone ? "off" : "polite"}
    >
      <span className="llm-wait-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="llm-wait-label">{statusText}</span>
      {model ? <span className="llm-wait-model">· {model}</span> : null}
      <span className="llm-wait-counter">{formatSeconds(elapsed)}</span>
    </div>
  );
}
