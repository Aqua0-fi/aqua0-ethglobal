import { FillerParticipationSet } from "../generated/FillerRegistry/FillerRegistry";
import { FillerParticipant, FillerParticipationSetEvent } from "../generated/schema";
import { eventId, network } from "./common";

export function handleFillerParticipationSet(event: FillerParticipationSet): void {
  const id = event.params.lp.toHexString();
  let participant = FillerParticipant.load(id);
  if (participant == null) {
    participant = new FillerParticipant(id);
    participant.lp = event.params.lp;
    participant.network = network();
  }
  participant.active = event.params.active;
  participant.nonce = event.params.nonce;
  participant.updatedAtBlock = event.block.number;
  participant.updatedAtTimestamp = event.block.timestamp;
  participant.save();

  const history = new FillerParticipationSetEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.lp = event.params.lp;
  history.active = event.params.active;
  history.nonce = event.params.nonce;
  history.save();
}
