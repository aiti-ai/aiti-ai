/**
 * "Send this queue entry as a steer, then drop the original entry."
 *
 * Two independent reasons why firing the send and the removal side by side is
 * wrong (both reported as "the queued message vanished without being steered"):
 *
 *  1. On the pi/omp backends a removal is implemented as clear-all + re-inject.
 *     A removal that runs before (or while) the send clears the queue row the
 *     send just created, and the plan it re-injects cannot contain that row —
 *     the message is gone from the queue and never delivered.
 *  2. The removal is index-based. While the accepted send is in flight the queue
 *     can move (the running agent may deliver a follow-up), so removing by the
 *     clicked index can delete a different entry.
 *
 * So: await the send (the promise resolves once the backend accepted the steer),
 * then locate the entry by its text in the current live view and remove that.
 * A rejected send leaves the row untouched — nothing is lost.
 */
import type { QueueImage, QueueLiveView, QueuePanelActions } from "./types";

export async function steerSendThenRemove(opts: {
  actions: QueuePanelActions;
  kind: "steer" | "followUp";
  index: number;
  text: string;
  images?: QueueImage[];
  /** Read the queue as it is AFTER the send resolves (the queue can move while
   *  the send is awaited — a render-time view would be stale). */
  getLive: () => QueueLiveView;
  remove: (kind: "steer" | "followUp", index: number, opts?: { permanent?: boolean }) => Promise<unknown>;
}): Promise<void> {
  const { actions, kind, index, text, images, getLive, remove } = opts;
  const send = actions.steerSend;
  if (!send) return;
  await send(text, images);
  const view = getLive();
  const group = kind === "steer" ? view.steering : view.followUp;
  const found = group[index]?.text === text ? index : group.findIndex((entry) => entry.text === text);
  if (found >= 0) await remove(kind, found, { permanent: true });
}
