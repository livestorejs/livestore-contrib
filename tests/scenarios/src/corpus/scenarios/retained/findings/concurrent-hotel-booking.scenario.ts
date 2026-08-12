import { Scenario, alias, client, disconnect, note, reconnect, settle } from '../../../../scenario.ts'
import { hotelBooking } from '../../../applications/hotel-booking.ts'

const clientA = client('client-a').withSessions('session-a')
const clientB = client('client-b').withSessions('session-b')
const sessionA = clientA.session('session-a')
const sessionB = clientB.session('session-b')
const both = alias([sessionA, sessionB])

export default Scenario.start({
  application: hotelBooking,
  about: 'Rebase two locally valid hotel bookings into a SQLite-enforced inventory violation.',
  clients: [clientA, clientB],
}).pipe(
  note('Both Clients confirm that one standard hotel room remains available.'),
  hotelBooking.initializeHotelRoomInventory({ roomType: 'standard', available: 1 }).as(sessionB),
  settle(both),
  note('Each Client independently books the locally available final room.'),
  disconnect(clientA),
  hotelBooking.bookHotelRoom({ roomType: 'standard' }).as(sessionA),
  hotelBooking.bookHotelRoom({ roomType: 'standard' }).as(sessionB),
  settle(sessionB),
  note('Client A rebases its booking over Client B and attempts to materialize negative inventory.'),
  reconnect(clientA),
)
