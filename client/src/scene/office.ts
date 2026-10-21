import * as THREE from 'three';
import { DESKS, MEETING_SEATS, MEETING_TABLE, ROOM, type DeskSpot } from './layout.ts';
import {
  MonitorSurface,
  fabricTexture,
  plasterTexture,
  whiteboardTexture,
  woodFloorTexture,
} from './textures.ts';

const WOOD_TOP = '#8c5f38';
const WOOD_DARK = '#5d3d25';
const STEEL = '#3a4048';
const WALL = '#dcd6c8';
const WAINSCOT = '#5c6a63';

function box(
  width: number,
  height: number,
  depth: number,
  color: string,
  options: { roughness?: number; metalness?: number; castShadow?: boolean; receiveShadow?: boolean } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshStandardMaterial({
      color,
      roughness: options.roughness ?? 0.78,
      metalness: options.metalness ?? 0.05,
    }),
  );
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  color: string,
  segments = 20,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function pottedPlant(scale: number): THREE.Group {
  const group = new THREE.Group();
  const pot = cylinder(0.22 * scale, 0.16 * scale, 0.3 * scale, '#b3653f', 14);
  pot.position.y = 0.15 * scale;
  group.add(pot);

  const soil = cylinder(0.2 * scale, 0.2 * scale, 0.04 * scale, '#3c2f24', 14);
  soil.position.y = 0.3 * scale;
  group.add(soil);

  const leafMaterial = new THREE.MeshStandardMaterial({
    color: '#4f7f45',
    roughness: 0.85,
  });
  for (let index = 0; index < 7; index += 1) {
    const angle = (index / 7) * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.16 * scale, 8, 6), leafMaterial);
    leaf.position.set(
      Math.cos(angle) * 0.16 * scale,
      (0.44 + (index % 3) * 0.12) * scale,
      Math.sin(angle) * 0.16 * scale,
    );
    leaf.scale.set(0.6, 1.5, 0.6);
    leaf.castShadow = true;
    group.add(leaf);
  }
  return group;
}

function chair(color: string): THREE.Group {
  const group = new THREE.Group();
  const seat = box(0.55, 0.09, 0.52, color, { roughness: 0.85 });
  seat.position.y = 0.46;
  group.add(seat);

  const back = box(0.55, 0.6, 0.08, color, { roughness: 0.85 });
  back.position.set(0, 0.78, -0.22);
  group.add(back);

  const post = cylinder(0.05, 0.05, 0.42, STEEL, 10);
  post.position.y = 0.22;
  group.add(post);

  const base = cylinder(0.3, 0.3, 0.05, STEEL, 12);
  base.position.y = 0.03;
  group.add(base);
  return group;
}

export interface OfficeBuild {
  group: THREE.Group;
  /** Monitor surfaces keyed by desk index. */
  monitors: Map<number, MonitorSurface>;
  /** Screen meshes so the scene can refresh their textures. */
  screenMaterials: THREE.MeshBasicMaterial[];
}

export function buildOffice(): OfficeBuild {
  const group = new THREE.Group();
  const monitors = new Map<number, MonitorSurface>();
  const screenMaterials: THREE.MeshBasicMaterial[] = [];

  const width = ROOM.maxX - ROOM.minX;
  const depth = ROOM.maxZ - ROOM.minZ;
  const centerX = (ROOM.maxX + ROOM.minX) / 2;
  const centerZ = (ROOM.maxZ + ROOM.minZ) / 2;

  // ── floor ────────────────────────────────────────────────────────────────
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshStandardMaterial({ map: woodFloorTexture('#a9784b'), roughness: 0.62, metalness: 0.02 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(centerX, 0, centerZ);
  floor.receiveShadow = true;
  group.add(floor);

  // Meeting rug
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(4.2, 48),
    new THREE.MeshStandardMaterial({ map: fabricTexture('#2f6f6a'), roughness: 0.95 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(MEETING_TABLE.x, 0.012, MEETING_TABLE.z);
  rug.receiveShadow = true;
  group.add(rug);

  // Lounge rug
  const loungeRug = new THREE.Mesh(
    new THREE.CircleGeometry(3.1, 40),
    new THREE.MeshStandardMaterial({ map: fabricTexture('#8a5b3d'), roughness: 0.95 }),
  );
  loungeRug.rotation.x = -Math.PI / 2;
  loungeRug.position.set(11.4, 0.014, 6.2);
  loungeRug.receiveShadow = true;
  group.add(loungeRug);

  // ── walls ────────────────────────────────────────────────────────────────
  const plaster = plasterTexture(WALL);
  const wallMaterial = new THREE.MeshStandardMaterial({ map: plaster, roughness: 0.94 });
  const wainscotMaterial = new THREE.MeshStandardMaterial({ color: WAINSCOT, roughness: 0.7 });

  const northWall = box(width, ROOM.wallHeight, 0.3, WALL, { roughness: 0.95, castShadow: false });
  northWall.material = wallMaterial;
  northWall.position.set(centerX, ROOM.wallHeight / 2, ROOM.minZ);
  group.add(northWall);

  const westWall = box(0.3, ROOM.wallHeight, depth, WALL, { roughness: 0.95, castShadow: false });
  westWall.material = wallMaterial;
  westWall.position.set(ROOM.minX, ROOM.wallHeight / 2, centerZ);
  group.add(westWall);

  const northWainscot = box(width, 1.1, 0.36, WAINSCOT, { castShadow: false });
  northWainscot.position.set(centerX, 0.55, ROOM.minZ + 0.12);
  group.add(northWainscot);

  const westWainscot = box(0.36, 1.1, depth, WAINSCOT, { castShadow: false });
  westWainscot.position.set(ROOM.minX + 0.12, 0.55, centerZ);
  group.add(westWainscot);

  // Windows on the north wall
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: '#cfe4f2',
    emissive: '#ffe9c4',
    emissiveIntensity: 1.4,
    roughness: 0.25,
    metalness: 0,
  });
  for (const x of [-11, -6.6, -2.2]) {
    const frame = box(3.1, 2.3, 0.16, '#f1ece1', { castShadow: false });
    frame.position.set(x, 3.1, ROOM.minZ + 0.14);
    group.add(frame);

    const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.85, 2.05), glassMaterial);
    glass.position.set(x, 3.1, ROOM.minZ + 0.23);
    group.add(glass);

    const mullion = box(0.09, 2.3, 0.2, '#f1ece1', { castShadow: false });
    mullion.position.set(x, 3.1, ROOM.minZ + 0.24);
    group.add(mullion);
  }

  // Wall art on the west wall
  const artColors = ['#c65f4b', '#3f7f76', '#d8a657', '#4a5b8c'];
  for (let index = 0; index < 4; index += 1) {
    const frame = box(0.1, 1.5, 1.15, '#f1ece1', { castShadow: false });
    frame.position.set(ROOM.minX + 0.18, 2.9, -6 + index * 3.4);
    group.add(frame);
    const art = box(0.04, 1.2, 0.9, artColors[index] ?? '#c65f4b', { castShadow: false });
    art.position.set(ROOM.minX + 0.26, 2.9, -6 + index * 3.4);
    group.add(art);
  }

  // ── desks ────────────────────────────────────────────────────────────────
  const buildDesk = (desk: DeskSpot): void => {
    const deskGroup = new THREE.Group();
    deskGroup.position.set(desk.position.x, 0, desk.position.z);
    deskGroup.rotation.y = desk.facing;

    const top = box(2.4, 0.09, 1.15, WOOD_TOP, { roughness: 0.55 });
    top.position.y = 0.75;
    deskGroup.add(top);

    const edge = box(2.42, 0.04, 1.17, WOOD_DARK, { castShadow: false });
    edge.position.y = 0.71;
    deskGroup.add(edge);

    const legPositions: [number, number][] = [
      [-1.1, -0.48],
      [1.1, -0.48],
      [-1.1, 0.48],
      [1.1, 0.48],
    ];
    for (const [legX, legZ] of legPositions) {
      const leg = box(0.08, 0.72, 0.08, STEEL, { metalness: 0.45, roughness: 0.4 });
      leg.position.set(legX, 0.36, legZ);
      deskGroup.add(leg);
    }

    const drawer = box(0.7, 0.5, 0.9, '#6b6f74', { metalness: 0.2 });
    drawer.position.set(0.85, 0.4, 0);
    deskGroup.add(drawer);

    // Monitor
    const monitorSurface = new MonitorSurface({
      name: 'Agent',
      role: 'Worker',
      color: '#2fb8a6',
      task: null,
      status: 'idle',
      tokensUsed: 0,
    });
    const screenMaterial = new THREE.MeshBasicMaterial({ map: monitorSurface.texture, toneMapped: false });
    screenMaterials.push(screenMaterial);

    const bezel = box(1.3, 0.8, 0.07, '#1c2126', { roughness: 0.6, castShadow: false });
    bezel.position.set(0, 1.2, 0.28);
    deskGroup.add(bezel);

    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.22, 0.72), screenMaterial);
    screen.position.set(0, 1.2, 0.24);
    screen.rotation.y = Math.PI;
    deskGroup.add(screen);

    const stand = box(0.1, 0.42, 0.08, STEEL, { metalness: 0.4 });
    stand.position.set(0, 0.85, 0.28);
    deskGroup.add(stand);

    const foot = box(0.5, 0.04, 0.24, STEEL, { castShadow: false });
    foot.position.set(0, 0.8, 0.28);
    deskGroup.add(foot);

    // Desk clutter — keyboard and mug sit on the worker side of the desk.
    const keyboard = box(0.62, 0.03, 0.22, '#2b3138', { castShadow: false });
    keyboard.position.set(0, 0.81, -0.22);
    deskGroup.add(keyboard);

    const mug = cylinder(0.06, 0.05, 0.11, '#e3e0d8', 12);
    mug.position.set(0.72, 0.85, -0.14);
    deskGroup.add(mug);

    const lampArm = box(0.04, 0.5, 0.04, '#3d434a', { castShadow: false });
    lampArm.position.set(-0.95, 1.05, 0.3);
    deskGroup.add(lampArm);

    const lampShade = cylinder(0.16, 0.1, 0.16, '#e9a23b', 14);
    lampShade.position.set(-0.95, 1.32, 0.3);
    deskGroup.add(lampShade);

    const lampGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 10, 8),
      new THREE.MeshBasicMaterial({ color: '#ffd79a', toneMapped: false }),
    );
    lampGlow.position.set(-0.95, 1.26, 0.3);
    deskGroup.add(lampGlow);

    // Chair — on the worker side of the desk, backrest away from the monitor.
    const seat = chair('#3f4750');
    seat.position.set(0, 0, -1.0);
    deskGroup.add(seat);

    group.add(deskGroup);
    monitors.set(desk.id, monitorSurface);
  };

  for (const desk of DESKS) buildDesk(desk);

  // ── meeting table ────────────────────────────────────────────────────────
  const table = cylinder(MEETING_TABLE.radius, MEETING_TABLE.radius, 0.14, '#7a5334', 32);
  table.position.set(MEETING_TABLE.x, 0.76, MEETING_TABLE.z);
  group.add(table);

  const tableBase = cylinder(0.24, 0.4, 0.74, STEEL, 16);
  tableBase.position.set(MEETING_TABLE.x, 0.37, MEETING_TABLE.z);
  group.add(tableBase);

  for (const seat of MEETING_SEATS) {
    const meetingChair = chair('#4b5560');
    meetingChair.position.set(seat.x, 0, seat.z);
    meetingChair.lookAt(MEETING_TABLE.x, 0, MEETING_TABLE.z);
    group.add(meetingChair);
  }

  const centerpiece = pottedPlant(0.9);
  centerpiece.position.set(MEETING_TABLE.x, 0.83, MEETING_TABLE.z);
  group.add(centerpiece);

  // ── coffee corner ────────────────────────────────────────────────────────
  const counter = box(3.4, 0.95, 0.9, '#4a545c', { roughness: 0.6 });
  counter.position.set(-11.6, 0.48, 4.4);
  group.add(counter);

  const counterTop = box(3.6, 0.08, 1, '#c8c3b6', { roughness: 0.4 });
  counterTop.position.set(-11.6, 0.98, 4.4);
  group.add(counterTop);

  const machine = box(0.7, 0.9, 0.6, '#2f353b', { metalness: 0.5, roughness: 0.35 });
  machine.position.set(-12.4, 1.47, 4.4);
  group.add(machine);

  const machineGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.2),
    new THREE.MeshBasicMaterial({ color: '#ffb066', toneMapped: false }),
  );
  machineGlow.position.set(-12.4, 1.35, 4.71);
  group.add(machineGlow);

  for (const x of [-11.3, -10.9]) {
    const stool = cylinder(0.24, 0.2, 0.7, '#3a4149', 12);
    stool.position.set(x, 0.35, 5.7);
    group.add(stool);
    const stoolSeat = cylinder(0.28, 0.28, 0.08, '#c9705a', 14);
    stoolSeat.position.set(x, 0.74, 5.7);
    group.add(stoolSeat);
  }

  // ── lounge ───────────────────────────────────────────────────────────────
  for (const [x, z, rotation] of [
    [11.4, 4.6, 0],
    [11.4, 7.6, Math.PI],
  ] as const) {
    const sofa = new THREE.Group();
    const base = box(2.6, 0.42, 1, '#4b5a63', { roughness: 0.9 });
    base.position.y = 0.32;
    sofa.add(base);
    const cushion = box(2.4, 0.16, 0.9, '#5c6d78', { roughness: 0.95 });
    cushion.position.y = 0.6;
    sofa.add(cushion);
    const backRest = box(2.6, 0.62, 0.22, '#4b5a63', { roughness: 0.9 });
    backRest.position.set(0, 0.8, -0.42);
    sofa.add(backRest);
    sofa.position.set(x, 0, z);
    sofa.rotation.y = rotation;
    group.add(sofa);
  }

  const coffeeTable = cylinder(0.75, 0.75, 0.1, '#8c5f38', 24);
  coffeeTable.position.set(11.4, 0.45, 6.1);
  group.add(coffeeTable);
  const coffeeTableBase = cylinder(0.08, 0.14, 0.42, STEEL, 12);
  coffeeTableBase.position.set(11.4, 0.21, 6.1);
  group.add(coffeeTableBase);

  const floorLamp = cylinder(0.05, 0.16, 1.7, '#39424a', 12);
  floorLamp.position.set(13.4, 0.85, 8.2);
  group.add(floorLamp);
  const lampShadeTop = cylinder(0.3, 0.42, 0.42, '#f0e2c4', 16);
  lampShadeTop.position.set(13.4, 1.85, 8.2);
  group.add(lampShadeTop);

  // ── whiteboard ───────────────────────────────────────────────────────────
  const boardFrame = box(4.6, 2.4, 0.12, '#b9b3a6', { castShadow: false });
  boardFrame.position.set(8.2, 2.6, ROOM.minZ + 0.22);
  group.add(boardFrame);
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.2),
    new THREE.MeshStandardMaterial({ map: whiteboardTexture(), roughness: 0.75 }),
  );
  board.position.set(8.2, 2.6, ROOM.minZ + 0.29);
  group.add(board);

  // ── shelves on the west wall ─────────────────────────────────────────────
  const shelf = box(0.4, 2.4, 5, '#6b4a30', { roughness: 0.8 });
  shelf.position.set(ROOM.minX + 0.35, 1.2, 1.5);
  group.add(shelf);
  const bookColors = ['#c65f4b', '#3f7f76', '#d8a657', '#4a5b8c', '#a3b18a', '#c084fc'];
  for (let row = 0; row < 3; row += 1) {
    for (let index = 0; index < 7; index += 1) {
      const book = box(0.16, 0.42, 0.14, bookColors[(row * 7 + index) % bookColors.length] ?? '#c65f4b', {
        castShadow: false,
      });
      book.position.set(ROOM.minX + 0.42, 0.45 + row * 0.72, -0.6 + index * 0.22);
      group.add(book);
    }
  }

  // ── pendant lamps ────────────────────────────────────────────────────────
  for (const [x, z] of [
    [-7.6, -8.4],
    [-2, -8.4],
    [-6.3, -3.1],
    [-0.7, -3.1],
    [8.4, -1.2],
  ] as const) {
    const cord = box(0.03, 1.6, 0.03, '#2b3036', { castShadow: false });
    cord.position.set(x, 4.6, z);
    group.add(cord);
    const shade = cylinder(0.12, 0.42, 0.42, '#2f353b', 18);
    shade.position.set(x, 3.55, z);
    group.add(shade);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 10),
      new THREE.MeshBasicMaterial({ color: '#ffdfae', toneMapped: false }),
    );
    bulb.position.set(x, 3.36, z);
    group.add(bulb);
  }

  // ── plants ───────────────────────────────────────────────────────────────
  for (const [x, z, scale] of [
    [-13.6, -9.4, 1.3],
    [13.6, -9.4, 1.1],
    [-2.4, 9.2, 1.2],
    [6.2, 9.4, 1],
    [14.2, 1.2, 0.9],
  ] as const) {
    const plant = pottedPlant(scale);
    plant.position.set(x, 0, z);
    group.add(plant);
  }

  // Wall clock
  const clock = cylinder(0.36, 0.36, 0.08, '#f4f1e8', 24);
  clock.rotation.x = Math.PI / 2;
  clock.position.set(3.4, 3.6, ROOM.minZ + 0.2);
  group.add(clock);
  const clockRim = cylinder(0.4, 0.4, 0.06, '#2f353b', 24);
  clockRim.rotation.x = Math.PI / 2;
  clockRim.position.set(3.4, 3.6, ROOM.minZ + 0.17);
  group.add(clockRim);

  return { group, monitors, screenMaterials };
}
