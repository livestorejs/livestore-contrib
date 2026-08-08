import { defineScenario } from '../../../../model.ts'
import { hotelBookingApplication } from '../../../applications/hotel-booking.ts'

const offlineWriter = { clientId: 'client-a', sessionId: 'session-a' } as const
const onlineWriter = { clientId: 'client-b', sessionId: 'session-b' } as const
const participants = [offlineWriter, onlineWriter]

/**
 * Minimal reproduction of the command-replay RFC's invalid-rebase class:
 * both Clients validly book the last hotel room in their own context, but
 * replaying Client A's pending booking after Client B's confirmed booking
 * attempts to materialize negative inventory.
 */
export const concurrentHotelBooking = defineScenario({
  version: 3,
  id: 'concurrent-hotel-booking',
  description: 'Rebase two locally valid hotel bookings into a SQLite-enforced inventory violation.',
  tags: ['red-team', 'known-failure', 'rebase', 'materialization', 'sqlite-constraint'],
  seed: 2_002,
  applicationId: hotelBookingApplication.id,
  requires: [],
  topology: {
    storeId: 'concurrent-hotel-booking',
    clients: [
      { id: offlineWriter.clientId, sessions: [offlineWriter.sessionId], initiallyConnected: true },
      { id: onlineWriter.clientId, sessions: [onlineWriter.sessionId], initiallyConnected: true },
    ],
  },
  instructions: [
    {
      _tag: 'annotation',
      id: 'establish-shared-base',
      text: 'Both Clients confirm that one standard hotel room remains available.',
    },
    {
      _tag: 'action',
      id: 'initialize-one-hotel-room',
      target: onlineWriter,
      action: 'initializeHotelRoomInventory',
      input: { roomType: 'standard', available: 1 },
    },
    {
      _tag: 'settle',
      id: 'confirm-shared-base',
      participants,
      healDisconnectedClients: [],
      timeoutMs: 10_000,
    },
    {
      _tag: 'annotation',
      id: 'create-concurrent-decrements',
      text: 'Each Client independently books the locally available final room.',
    },
    { _tag: 'disconnect', id: 'isolate-client-a', clientId: offlineWriter.clientId },
    {
      _tag: 'action',
      id: 'client-a-books-offline',
      target: offlineWriter,
      action: 'bookHotelRoom',
      input: { roomType: 'standard' },
    },
    {
      _tag: 'action',
      id: 'client-b-books-online',
      target: onlineWriter,
      action: 'bookHotelRoom',
      input: { roomType: 'standard' },
    },
    {
      _tag: 'settle',
      id: 'confirm-client-b-booking',
      participants: [onlineWriter],
      healDisconnectedClients: [],
      timeoutMs: 10_000,
    },
    {
      _tag: 'annotation',
      id: 'rebase-invalid-pending-event',
      text: 'Client A rebases its booking over Client B and attempts to materialize negative inventory.',
    },
    { _tag: 'reconnect', id: 'reconnect-client-a', clientId: offlineWriter.clientId },
    {
      _tag: 'settle',
      id: 'observe-materialization-failure',
      participants,
      healDisconnectedClients: [],
      timeoutMs: 10_000,
    },
  ],
  oracles: [],
})
