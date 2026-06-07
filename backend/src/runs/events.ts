// Typed event envelope for run streaming.
// Wire format used by both the in-process bus and the SSE endpoints.
//
// The vocabulary (RunEventType) and envelope shape (RunEventEnvelope) are
// defined once in openshuki-shared and re-exported here so the backend and
// frontend can't drift. Add a new event type in openshuki-shared/src/events.ts
// (and the subprocess runner's KNOWN_EVENT_TYPES); both surfaces pick it up.

export type { RunEventType, RunEventEnvelope } from "openshuki-shared";
