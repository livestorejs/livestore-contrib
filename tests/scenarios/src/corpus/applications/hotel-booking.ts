import { Events, makeSchema, State } from '@livestore/common/schema'
import { Effect, Schema } from '@livestore/utils/effect'

import { defineAction, defineApplication } from '../../application/definition.ts'

export const hotelBookingEvents = {
  inventoryInitialized: Events.synced({
    name: 'v1.HotelRoomInventoryInitialized',
    schema: Schema.Struct({ roomType: Schema.String, available: Schema.Int }),
  }),
  roomBooked: Events.synced({
    name: 'v1.HotelRoomBooked',
    schema: Schema.Struct({ roomType: Schema.String }),
  }),
}

export const hotelRoomInventoryTable = State.SQLite.table({
  name: 'hotel_room_inventory',
  columns: {
    roomType: State.SQLite.text({ primaryKey: true }),
    available: State.SQLite.integer({ nullable: false }),
  },
})

/** State.SQLite does not yet expose CHECK constraints in its table DSL. */
const installNonNegativeInventoryGuard = `
  CREATE TRIGGER IF NOT EXISTS hotel_room_inventory_nonnegative
  BEFORE UPDATE OF available ON hotel_room_inventory
  FOR EACH ROW WHEN NEW.available < 0
  BEGIN
    SELECT RAISE(ABORT, 'CHECK constraint failed: hotel_room_inventory.available_nonnegative');
  END
`

const materializers = State.SQLite.materializers(hotelBookingEvents, {
  'v1.HotelRoomInventoryInitialized': ({ roomType, available }) => [
    hotelRoomInventoryTable.insert({ roomType, available }),
    installNonNegativeInventoryGuard,
  ],
  'v1.HotelRoomBooked': ({ roomType }) => ({
    sql: 'UPDATE hotel_room_inventory SET available = available - 1 WHERE roomType = $roomType',
    bindValues: { roomType },
    writeTables: new Set([hotelRoomInventoryTable.sqliteDef.name]),
  }),
})

export const hotelBookingSchema = makeSchema({
  events: hotelBookingEvents,
  state: State.SQLite.makeState({ tables: { hotelRoomInventory: hotelRoomInventoryTable }, materializers }),
})

const InitializeInventoryInput = Schema.Struct({ roomType: Schema.String, available: Schema.Int })
const BookRoomInput = Schema.Struct({ roomType: Schema.String })

export const hotelBookingApplication = defineApplication({
  id: 'scenario-hotel-booking-app',
  schema: hotelBookingSchema,
  actions: {
    initializeHotelRoomInventory: defineAction<typeof hotelBookingSchema, typeof InitializeInventoryInput>({
      input: InitializeInventoryInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(hotelBookingEvents.inventoryInitialized(input))),
    }),
    bookHotelRoom: defineAction<typeof hotelBookingSchema, typeof BookRoomInput>({
      input: BookRoomInput,
      run: ({ store, input }) => Effect.sync(() => store.commit(hotelBookingEvents.roomBooked(input))),
    }),
  },
  inspectors: {},
})
