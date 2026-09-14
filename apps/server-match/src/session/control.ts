import type { Session } from "@twobullets/netcode";
import { createBitWriter, encodeDisconnect, type DisconnectReason } from "@twobullets/protocol";

// Control-stream helpers shared by the SessionManager and matches. Runs on the I/O path (never inside a tick's hot loop
// except for rare kicks), one writer reused; sessions copy what they send.

const writer = createBitWriter(64);

/** Sends `Disconnect{reason}` on the control stream, then closes the session with `reason` as the close code. */
export function disconnectSession(session: Session, reason: DisconnectReason, detail = 0): void {
  writer.reset();
  encodeDisconnect(writer, { reason, detail });
  try {
    session.sendStream(writer.bytes());
  } finally {
    session.close(reason);
  }
}

export const DisconnectReasonName: Record<number, string> = {
  0: "clientLeave",
  1: "versionMismatch",
  2: "badToken",
  3: "notAssigned",
  4: "matchFull",
  5: "replaced",
  6: "kicked",
  7: "rateLimited",
  8: "timeout",
  9: "matchEnded",
  10: "serverShutdown",
  11: "internalError",
};
