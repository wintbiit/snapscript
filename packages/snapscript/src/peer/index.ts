import { defineComponent, u8, varu32 } from "../schema/index";

export const PeerStatus = Object.freeze({
  Connected: 1,
  Disconnected: 2,
} as const);

export type PeerStatusValue = (typeof PeerStatus)[keyof typeof PeerStatus];

/** Built-in replicated component attached to framework-created PeerEntity instances. */
export const PeerState = defineComponent(
  "PeerState",
  {
    peerId: varu32(0),
    status: u8(PeerStatus.Connected),
  },
  {
    id: 0,
    fieldIds: { peerId: 0, status: 1 },
    metadata: { builtin: "peer" },
  },
);
