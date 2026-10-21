import type { OfficeStation } from '../../../shared/types.ts';

export interface Vec2 {
  x: number;
  z: number;
}

export interface DeskSpot {
  id: number;
  position: Vec2;
  /** Yaw in radians; the desk faces this direction. */
  facing: number;
}

/** Room interior bounds, in world units (1 unit ≈ 1 metre). */
export const ROOM = {
  minX: -15,
  maxX: 15,
  minZ: -11,
  maxZ: 11,
  wallHeight: 5.4,
};

const DESK_ROW_NORTH: number[] = [-9.4, -5.6, -1.8, 2.0, 5.8];
const DESK_ROW_MIDDLE: number[] = [-8.2, -4.4, -0.6, 3.2];
/** Kept clear of the meeting table (x ≈ 8.4) on the south side of the room. */
const DESK_ROW_SOUTH: number[] = [-10.2, -6.0, -1.8, 2.4];

/**
 * Desks. Row 1 hugs the north wall, row 2 floats in the middle of the floor.
 * `facing` is the yaw of the desk itself; workers stand on the +z side.
 */
export const DESKS: DeskSpot[] = [
  ...DESK_ROW_NORTH.map((x, index) => ({ id: index, position: { x, z: -8.4 }, facing: Math.PI })),
  ...DESK_ROW_MIDDLE.map((x, index) => ({
    id: index + DESK_ROW_NORTH.length,
    position: { x, z: -3.1 },
    facing: Math.PI,
  })),
  ...DESK_ROW_SOUTH.map((x, index) => ({
    id: index + DESK_ROW_NORTH.length + DESK_ROW_MIDDLE.length,
    position: { x, z: 2.2 },
    facing: Math.PI,
  })),
];

/** Where a worker sits while using a desk (on the +z side of the desk). */
export function deskSeat(desk: DeskSpot): Vec2 {
  return { x: desk.position.x, z: desk.position.z + 1.0 };
}

export const MEETING_TABLE = { x: 8.4, z: -1.2, radius: 2.5 };

export const MEETING_SEATS: Vec2[] = Array.from({ length: 6 }, (_unused, index) => {
  const angle = (index / 6) * Math.PI * 2 + Math.PI / 6;
  return {
    x: MEETING_TABLE.x + Math.cos(angle) * (MEETING_TABLE.radius + 0.75),
    z: MEETING_TABLE.z + Math.sin(angle) * (MEETING_TABLE.radius + 0.75),
  };
});

export const COFFEE_SPOT: Vec2 = { x: -11.4, z: 5.2 };
export const BOARD_SPOT: Vec2 = { x: 8.2, z: -8.2 };
export const LOUNGE_SPOT: Vec2 = { x: 11.6, z: 6.4 };

/** Target position for an agent standing at a given station. */
export function stationPosition(station: OfficeStation, deskIndex: number, seatIndex: number): Vec2 {
  switch (station) {
    case 'meeting': {
      const seat = MEETING_SEATS[seatIndex % MEETING_SEATS.length] ?? MEETING_SEATS[0] ?? COFFEE_SPOT;
      return seat ?? COFFEE_SPOT;
    }
    case 'coffee':
      return COFFEE_SPOT;
    case 'board':
      return BOARD_SPOT;
    case 'lounge':
      return LOUNGE_SPOT;
    case 'desk':
    default: {
      const desk = DESKS[deskIndex % DESKS.length] ?? DESKS[0];
      return desk ? deskSeat(desk) : { x: 0, z: 0 };
    }
  }
}

/** Yaw a worker should face while standing at a station. */
export function stationFacing(station: OfficeStation, deskIndex: number, seatIndex: number): number {
  switch (station) {
    case 'meeting': {
      const seat = MEETING_SEATS[seatIndex % MEETING_SEATS.length] ?? MEETING_SEATS[0];
      if (!seat) return 0;
      return Math.atan2(MEETING_TABLE.x - seat.x, MEETING_TABLE.z - seat.z);
    }
    case 'coffee':
      return Math.PI * 0.75;
    case 'board':
      return Math.PI;
    case 'lounge':
      return Math.PI * 1.25;
    case 'desk':
    default: {
      const desk = DESKS[deskIndex % DESKS.length] ?? DESKS[0];
      return desk ? desk.facing : 0;
    }
  }
}
