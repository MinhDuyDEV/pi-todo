import { createHash } from "node:crypto";
import { serializeMarkdown, type TodoDoc } from "./markdown";
import type { TodoItem, TodoPhase } from "./types";

export const CHANNEL_ITEM_COMPLETED = "pi-todo:item-completed:v1";
export const CHANNEL_PHASE_CLOSED = "pi-todo:phase-closed:v1";

export interface TodoItemRef {
  id?: string;
  contentDigest: string;
  phaseTitleDigest: string;
}

export interface TodoPhaseRef {
  titleDigest: string;
  date?: string;
}

export interface TodoItemCompletedEvent {
  type: typeof CHANNEL_ITEM_COMPLETED;
  eventId: string;
  idempotencyKey: string;
  projectId: string;
  occurredAt: string;
  item: TodoItemRef;
  docDigest: string;
}

export interface TodoPhaseClosedEvent {
  type: typeof CHANNEL_PHASE_CLOSED;
  eventId: string;
  idempotencyKey: string;
  projectId: string;
  occurredAt: string;
  phase: TodoPhaseRef;
  completedCount: number;
  docDigest: string;
}

export type TodoEvent = TodoItemCompletedEvent | TodoPhaseClosedEvent;

export function contentDigest(content: string): string {
  return createHash("sha256")
    .update(content.normalize("NFKC").toLowerCase().trim())
    .digest("hex");
}

export function titleDigest(title: string): string {
  return createHash("sha256")
    .update(title.normalize("NFKC").toLowerCase().trim())
    .digest("hex");
}

export function projectDigest(projectPath: string): string {
  return createHash("sha256")
    .update(projectPath.normalize("NFKC"))
    .digest("hex");
}

export function computeDocDigest(doc: TodoDoc): string {
  return createHash("sha256")
    .update(serializeMarkdown(doc))
    .digest("hex");
}

export function computeIdempotencyKey(
  eventType: string,
  projectId: string,
  subjectDigest: string,
  docDigest: string,
): string {
  return createHash("sha256")
    .update(`${eventType}\x00${projectId}\x00${subjectDigest}\x00${docDigest}`)
    .digest("hex");
}

function itemSubjectDigest(item: TodoItem, phaseIndex: number, occurrenceIndex: number): string {
  if (item.id) {
    return createHash("sha256")
      .update(`item\x00${item.id}\x00${phaseIndex}`)
      .digest("hex");
  }
  return createHash("sha256")
    .update(`item\x00${contentDigest(item.content)}\x00${phaseIndex}\x00${occurrenceIndex}`)
    .digest("hex");
}

function phaseSubjectDigest(phase: TodoPhase, phaseIndex: number): string {
  return createHash("sha256")
    .update(`phase\x00${titleDigest(phase.title)}\x00${phase.date ?? ""}\x00${phaseIndex}`)
    .digest("hex");
}

function itemsOf(phase: TodoPhase): Array<{ item: TodoItem; occurrenceIndex: number }> {
  const result: Array<{ item: TodoItem; occurrenceIndex: number }> = [];
  let occurrenceIndex = 0;
  for (const entry of phase.body) {
    if (entry.type === "item") {
      result.push({ item: entry.item, occurrenceIndex });
      occurrenceIndex++;
    }
  }
  return result;
}

function itemKey(item: TodoItem, phaseIndex: number): string {
  if (item.id) return `${phaseIndex}\x00${item.id}`;
  return `${phaseIndex}\x00${contentDigest(item.content)}`;
}

export function emitLifecycleEvents(
  emit: (channel: string, data: unknown) => void,
  projectPath: string,
  prev: TodoDoc,
  next: TodoDoc,
): void {
  try {
    const pid = projectDigest(projectPath);
    const dDigest = computeDocDigest(next);
    const closedPhaseIndices = new Set<number>();

    for (let pi = 0; pi < next.phases.length; pi++) {
      const nextPhase = next.phases[pi];
      if (!nextPhase) continue;
      const prevPhase = pi < prev.phases.length ? prev.phases[pi] : undefined;
      if (prevPhase && prevPhase.status !== "done" && nextPhase.status === "done") {
        closedPhaseIndices.add(pi);
        const subject = phaseSubjectDigest(nextPhase, pi);
        const ik = computeIdempotencyKey(CHANNEL_PHASE_CLOSED, pid, subject, dDigest);
        const completedCount = itemsOf(nextPhase).filter(({ item }) => item.status === "completed").length;
        const event: TodoPhaseClosedEvent = {
          type: CHANNEL_PHASE_CLOSED,
          eventId: ik,
          idempotencyKey: ik,
          projectId: pid,
          occurredAt: new Date().toISOString(),
          phase: {
            titleDigest: titleDigest(nextPhase.title),
            date: nextPhase.date,
          },
          completedCount,
          docDigest: dDigest,
        };
        try { emit(event.type, event); } catch { /* fail open */ }
      }
    }

    for (let pi = 0; pi < next.phases.length; pi++) {
      if (closedPhaseIndices.has(pi)) continue;
      const nextPhase = next.phases[pi];
      if (!nextPhase) continue;
      const prevPhase = pi < prev.phases.length ? prev.phases[pi] : undefined;
      if (!prevPhase) continue;

      const prevItems = itemsOf(prevPhase);
      const nextItems = itemsOf(nextPhase);
      const prevByKey = new Map<string, TodoItem>();
      for (const { item } of prevItems) {
        prevByKey.set(itemKey(item, pi), item);
      }

      for (const { item, occurrenceIndex } of nextItems) {
        const key = itemKey(item, pi);
        const prevItem = prevByKey.get(key);
        if (prevItem && prevItem.status !== "completed" && item.status === "completed") {
          const subject = itemSubjectDigest(item, pi, occurrenceIndex);
          const ik = computeIdempotencyKey(CHANNEL_ITEM_COMPLETED, pid, subject, dDigest);
          const event: TodoItemCompletedEvent = {
            type: CHANNEL_ITEM_COMPLETED,
            eventId: ik,
            idempotencyKey: ik,
            projectId: pid,
            occurredAt: new Date().toISOString(),
            item: {
              id: item.id,
              contentDigest: contentDigest(item.content),
              phaseTitleDigest: titleDigest(nextPhase.title),
            },
            docDigest: dDigest,
          };
          try { emit(event.type, event); } catch { /* fail open */ }
        }
      }
    }
  } catch {
    /* fail open */
  }
}
