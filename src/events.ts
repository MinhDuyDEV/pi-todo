import { createHash } from "node:crypto";
import { serializeMarkdown, type TodoDoc } from "./markdown";
import type { TodoItem, TodoPhase } from "./types";

export const CHANNEL_ITEM_COMPLETED = "pi-todo:item-completed:v1";
export const CHANNEL_PHASE_CLOSED = "pi-todo:phase-closed:v1";

export interface TodoItemRef {
  /** Deprecated and intentionally never serialized; use idDigest for correlation. */
  id?: undefined;
  idDigest?: string;
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

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function contentDigest(content: string): string {
  return createHash("sha256")
    .update(content.normalize("NFKC").toLowerCase().trim())
    .digest("hex");
}

export function titleDigest(title: string): string {
  return createHash("sha256").update(normalizedText(title)).digest("hex");
}

export function idDigest(id: string): string {
  return createHash("sha256").update(id).digest("hex");
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

function itemIdentity(item: TodoItem): string {
  return item.id ? `id:${idDigest(item.id)}` : `content:${contentDigest(item.content)}`;
}

function itemSubjectDigest(
  item: TodoItem,
  phase: TodoPhase,
  phaseOccurrence: number,
  itemOccurrence: number,
): string {
  return createHash("sha256")
    .update(
      `item\x00${titleDigest(phase.title)}\x00${phaseOccurrence}\x00${itemIdentity(item)}\x00${itemOccurrence}`,
    )
    .digest("hex");
}

function phaseSubjectDigest(phase: TodoPhase, phaseOccurrence: number): string {
  return createHash("sha256")
    .update(`phase\x00${titleDigest(phase.title)}\x00${phase.date ?? ""}\x00${phaseOccurrence}`)
    .digest("hex");
}

function phaseShapeDigest(phase: TodoPhase): string {
  const itemShapes = itemsOf(phase)
    .map(({ item }) => itemIdentity(item))
    .sort()
    .join("\x00");
  return createHash("sha256")
    .update(`phase-shape\x00${normalizedText(phase.title)}\x00${phase.date ?? ""}\x00${itemShapes}`)
    .digest("hex");
}

function itemsOf(phase: TodoPhase): Array<{ item: TodoItem }> {
  const result: Array<{ item: TodoItem }> = [];
  for (const entry of phase.body) {
    if (entry.type === "item") result.push({ item: entry.item });
  }
  return result;
}

interface PhaseAlignment {
  nextPhase: TodoPhase;
  prevPhase?: TodoPhase;
  nextIndex: number;
  occurrence: number;
}

function alignPhases(prev: TodoDoc, next: TodoDoc): PhaseAlignment[] {
  const previousByTitle = new Map<string, Array<{ phase: TodoPhase; shape: string }>>();
  for (const phase of prev.phases) {
    const titleKey = normalizedText(phase.title);
    const queue = previousByTitle.get(titleKey) ?? [];
    queue.push({ phase, shape: phaseShapeDigest(phase) });
    previousByTitle.set(titleKey, queue);
  }

  const usedPrevious = new Set<TodoPhase>();
  const occurrences = new Map<string, number>();
  return next.phases.map((nextPhase, nextIndex) => {
    const titleKey = normalizedText(nextPhase.title);
    const occurrence = occurrences.get(titleKey) ?? 0;
    occurrences.set(titleKey, occurrence + 1);
    const queue = previousByTitle.get(titleKey) ?? [];
    const shape = phaseShapeDigest(nextPhase);
    const shapedMatch = queue.find((candidate) => !usedPrevious.has(candidate.phase) && candidate.shape === shape);
    const candidate = shapedMatch ?? queue.find((entry) => !usedPrevious.has(entry.phase));
    if (candidate) usedPrevious.add(candidate.phase);
    return { nextPhase, prevPhase: candidate?.phase, nextIndex, occurrence };
  });
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
    const alignments = alignPhases(prev, next);
    const closedPhaseIndices = new Set<number>();

    for (const alignment of alignments) {
      const { nextPhase, prevPhase } = alignment;
      if (!prevPhase || prevPhase.status === "done" || nextPhase.status !== "done") continue;

      closedPhaseIndices.add(alignment.nextIndex);
      const subject = phaseSubjectDigest(nextPhase, alignment.occurrence);
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
      // Listener failures are fail-open: the durable TODO write already completed.
      try { emit(event.type, event); } catch {}
    }

    for (const alignment of alignments) {
      if (closedPhaseIndices.has(alignment.nextIndex) || !alignment.prevPhase) continue;
      const prevByKey = new Map<string, TodoItem[]>();
      for (const { item } of itemsOf(alignment.prevPhase)) {
        const queue = prevByKey.get(itemIdentity(item)) ?? [];
        queue.push(item);
        prevByKey.set(itemIdentity(item), queue);
      }
      const occurrences = new Map<string, number>();
      for (const { item } of itemsOf(alignment.nextPhase)) {
        const key = itemIdentity(item);
        const itemOccurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, itemOccurrence + 1);
        const previousOccurrences = prevByKey.get(key);
        const prevItem = previousOccurrences?.shift();
        if (!prevItem || prevItem.status === "completed" || item.status !== "completed") continue;

        const subject = itemSubjectDigest(item, alignment.nextPhase, alignment.occurrence, itemOccurrence);
        const ik = computeIdempotencyKey(CHANNEL_ITEM_COMPLETED, pid, subject, dDigest);
        const event: TodoItemCompletedEvent = {
          type: CHANNEL_ITEM_COMPLETED,
          eventId: ik,
          idempotencyKey: ik,
          projectId: pid,
          occurredAt: new Date().toISOString(),
          item: {
            ...(item.id ? { idDigest: idDigest(item.id) } : {}),
            contentDigest: contentDigest(item.content),
            phaseTitleDigest: titleDigest(alignment.nextPhase.title),
          },
          docDigest: dDigest,
        };
        // Listener failures are fail-open: the durable TODO write already completed.
        try { emit(event.type, event); } catch {}
      }
    }
  } catch {
    // Lifecycle emission is fail-open and must not block the durable TODO write.
  }
}

// The strict lifecycle producer/replay protocol is public from ./events.
export {
  LIFECYCLE_PROTOCOL_VERSION,
  LifecycleIdempotencyConflictError,
  LifecycleJournal,
  assertNewCompletionEpoch,
  createLifecycleJournal,
  createLifecycleRecord,
  createLifecycleReplayPort,
  createStableIdentity,
  createStableItemId,
  isCorrelatedLifecycleRecord,
  parseLifecycleRecord,
} from "./lifecycle-journal.js";
export type {
  LifecycleCursor,
  LifecycleJournalOptions,
  LifecycleRecord,
  LifecycleReplayPort,
  ReplayPage,
  UsageBinding,
  UsageConsumer,
} from "./lifecycle-journal.js";
