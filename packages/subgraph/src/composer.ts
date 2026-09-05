import { Composer, ComposerExecuted } from "../generated/Composer/Composer";
import { ComposerExecutedEvent, FrontLifecycleEvent } from "../generated/schema";
import { eventId, network } from "./common";

export function handleComposerExecuted(event: ComposerExecuted): void {
  const history = new ComposerExecutedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.adapter = event.params.adapter;
  history.action = event.params.action;
  history.amount = event.params.amount;
  history.pnl = event.params.pnl;
  history.nonce = event.params.nonce;
  history.save();

  const frontAction = frontActionLabel(event);
  if (frontAction.length > 0) {
    const front = new FrontLifecycleEvent(eventId(event) + "-front");
    front.txHash = event.transaction.hash;
    front.logIndex = event.logIndex;
    front.blockNumber = event.block.number;
    front.timestamp = event.block.timestamp;
    front.network = network();
    front.vault = event.params.vault;
    front.action = frontAction;
    front.amount = event.params.amount;
    front.save();
  }
}

function frontActionLabel(event: ComposerExecuted): string {
  const contract = Composer.bind(event.address);
  const action = event.params.action;

  const commit = contract.try_ACTION_FRONT_COMMIT();
  if (!commit.reverted && action == commit.value) return "FRONT_COMMIT";

  const open = contract.try_ACTION_FRONT_OPEN();
  if (!open.reverted && action == open.value) return "FRONT_OPEN";

  const release = contract.try_ACTION_FRONT_RELEASE();
  if (!release.reverted && action == release.value) return "FRONT_RELEASE";

  const settle = contract.try_ACTION_FRONT_SETTLE();
  if (!settle.reverted && action == settle.value) return "FRONT_SETTLE";

  return "";
}
