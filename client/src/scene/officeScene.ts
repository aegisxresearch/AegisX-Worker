import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AgentProfile } from '../../../shared/types.ts';
import { createAgentCharacter, type AgentCharacter } from './character.ts';
import { buildOffice, type OfficeBuild } from './office.ts';
import { stationFacing, stationPosition } from './layout.ts';

const WALK_SPEED = 2.4;
const FOLLOW_SMOOTHING = 0.06;

export interface OfficeSceneOptions {
  canvas: HTMLCanvasElement;
  labelHost: HTMLElement;
  onSelectAgent: (agentId: string) => void;
}

/** Isometric orthographic camera rig with orbit, pan, zoom and follow. */
class CameraRig {
  readonly camera: THREE.OrthographicCamera;
  readonly target = new THREE.Vector3(0.5, 0, -1.2);
  #azimuth = Math.PI * 0.22;
  #elevation = 0.66;
  #distance = 70;
  #frustum = 30;
  #follow: string | null = null;
  #followTarget = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 220);
    this.camera.zoom = 1;
    this.setAspect(aspect);
    this.apply();
  }

  setAspect(aspect: number): void {
    const halfHeight = this.#frustum / 2;
    const halfWidth = halfHeight * aspect;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  get azimuth(): number {
    return this.#azimuth;
  }

  orbit(deltaX: number, deltaY: number): void {
    this.#azimuth -= deltaX * 0.005;
    this.#elevation = THREE.MathUtils.clamp(this.#elevation + deltaY * 0.003, 0.24, 1.15);
    this.apply();
  }

  pan(deltaX: number, deltaY: number): void {
    const forward = new THREE.Vector3(Math.sin(this.#azimuth), 0, Math.cos(this.#azimuth));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const scale = this.#frustum / this.camera.zoom / 520;
    this.target.addScaledVector(right, -deltaX * scale);
    this.target.addScaledVector(forward, -deltaY * scale);
    this.target.x = THREE.MathUtils.clamp(this.target.x, -14, 14);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -10, 10);
    this.apply();
  }

  zoom(delta: number): void {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * (1 - delta * 0.0012), 0.55, 3.2);
    this.camera.updateProjectionMatrix();
  }

  setFollow(agentId: string | null): void {
    this.#follow = agentId;
  }

  reset(): void {
    this.target.set(0.5, 0, -1.2);
    this.#azimuth = Math.PI * 0.22;
    this.#elevation = 0.66;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.apply();
  }

  update(followPosition: THREE.Vector3 | null): void {
    if (this.#follow && followPosition) {
      this.#followTarget.lerp(followPosition, FOLLOW_SMOOTHING);
      this.target.lerp(this.#followTarget, FOLLOW_SMOOTHING);
      this.apply();
    }
  }

  private apply(): void {
    const cos = Math.cos(this.#elevation);
    this.camera.position.set(
      this.target.x + this.#distance * cos * Math.sin(this.#azimuth),
      this.target.y + this.#distance * Math.sin(this.#elevation),
      this.target.z + this.#distance * cos * Math.cos(this.#azimuth),
    );
    this.camera.lookAt(this.target);
  }
}

export class OfficeScene {
  readonly canvas: HTMLCanvasElement;
  readonly rig: CameraRig;

  #renderer: THREE.WebGLRenderer;
  #labelRenderer: CSS2DRenderer;
  #scene = new THREE.Scene();
  #clock = new THREE.Clock();
  #office: OfficeBuild;
  #characters = new Map<string, AgentCharacter>();
  #agents = new Map<string, AgentProfile>();
  #destinations = new Map<string, THREE.Vector3>();
  #selectedId: string | null = null;
  #onSelectAgent: (agentId: string) => void;
  #frame = 0;
  #disposed = false;
  #pointerDown = { x: 0, y: 0, moved: false };
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();

  constructor(options: OfficeSceneOptions) {
    this.canvas = options.canvas;
    this.#onSelectAgent = options.onSelectAgent;

    this.#renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.shadowMap.enabled = true;
    this.#renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.05;
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.#labelRenderer = new CSS2DRenderer({ element: options.labelHost });
    options.labelHost.style.position = 'absolute';
    options.labelHost.style.top = '0';
    options.labelHost.style.pointerEvents = 'none';

    this.#scene.background = new THREE.Color('#0f1517');
    this.#scene.fog = new THREE.Fog('#0f1517', 58, 120);

    this.rig = new CameraRig(this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    this.#scene.add(this.rig.camera);

    this.#addLights();
    this.#office = buildOffice();
    this.#scene.add(this.#office.group);

    this.#bindEvents();
    this.#resize();
  }

  #addLights(): void {
    const hemisphere = new THREE.HemisphereLight('#dfe9f0', '#6b5741', 0.62);
    this.#scene.add(hemisphere);

    const sun = new THREE.DirectionalLight('#fff1d8', 1.65);
    sun.position.set(-10, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -22;
    sun.shadow.camera.right = 22;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -14;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.022;
    this.#scene.add(sun);
    this.#scene.add(sun.target);

    const fill = new THREE.DirectionalLight('#b9d5e6', 0.38);
    fill.position.set(14, 10, -12);
    this.#scene.add(fill);

    const warm = new THREE.PointLight('#ffcf9a', 26, 26, 2);
    warm.position.set(0, 4.2, -5);
    this.#scene.add(warm);
  }

  #bindEvents(): void {
    window.addEventListener('resize', this.#resize);

    this.canvas.addEventListener('pointerdown', (event) => {
      this.#pointerDown = { x: event.clientX, y: event.clientY, moved: false };
      this.canvas.classList.add('dragging');
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (!event.buttons) return;
      const deltaX = event.movementX;
      const deltaY = event.movementY;
      if (Math.abs(event.clientX - this.#pointerDown.x) + Math.abs(event.clientY - this.#pointerDown.y) > 4) {
        this.#pointerDown.moved = true;
      }
      if (event.shiftKey) this.rig.pan(deltaX, deltaY);
      else this.rig.orbit(deltaX, deltaY);
    });

    const endPointer = (event: PointerEvent): void => {
      this.canvas.classList.remove('dragging');
      if (!this.#pointerDown.moved) this.#pick(event);
    };
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', () => this.canvas.classList.remove('dragging'));

    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.rig.zoom(event.deltaY);
      },
      { passive: false },
    );

    this.canvas.addEventListener('dblclick', () => this.rig.reset());
  }

  #resize = (): void => {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.#renderer.setSize(width, height, false);
    this.#labelRenderer.setSize(width, height);
    this.rig.setAspect(width / Math.max(1, height));
  };

  #pick(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.#pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.#raycaster.setFromCamera(this.#pointer, this.rig.camera);
    const hits = this.#raycaster.intersectObjects([...this.#characters.values()].map((c) => c.group), true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (node.name.startsWith('agent-')) {
          this.#onSelectAgent(node.name.slice('agent-'.length));
          return;
        }
        node = node.parent;
      }
    }
  }

  // ── agents ───────────────────────────────────────────────────────────────

  syncAgents(agents: AgentProfile[]): void {
    const seen = new Set<string>();
    for (const agent of agents) {
      seen.add(agent.id);
      this.#agents.set(agent.id, agent);
      const existing = this.#characters.get(agent.id);
      if (existing) {
        this.updateAgent(agent);
        continue;
      }
      const character = createAgentCharacter(agent);
      this.#scene.add(character.group);
      this.#characters.set(agent.id, character);

      // New workers appear at their own station, already seated, instead of
      // walking in from the lounge. A long walk on a slow renderer looks like
      // a worker standing around doing nothing.
      const seat = this.#destinationFor(agent);
      character.group.position.set(seat.x, 0, seat.z);
      character.group.rotation.y = stationFacing(agent.station, agent.deskIndex, agent.deskIndex);
      this.#destinations.set(agent.id, seat.clone());
      character.setStatus(agent.status);
    }

    for (const [id, character] of this.#characters) {
      if (seen.has(id)) continue;
      this.#scene.remove(character.group);
      character.dispose();
      this.#characters.delete(id);
      this.#destinations.delete(id);
    }
  }

  updateAgent(agent: AgentProfile): void {
    this.#agents.set(agent.id, agent);
    const character = this.#characters.get(agent.id);
    if (!character) return;
    character.setStatus(agent.status);
    this.#destinations.set(agent.id, this.#destinationFor(agent));
    this.#refreshMonitor(agent);
  }

  #destinationFor(agent: AgentProfile): THREE.Vector3 {
    const position = stationPosition(agent.station, agent.deskIndex, agent.deskIndex);
    return new THREE.Vector3(position.x, 0, position.z);
  }

  #refreshMonitor(agent: AgentProfile): void {
    const monitor = this.#office.monitors.get(agent.deskIndex);
    if (!monitor) return;
    monitor.setState({
      name: agent.name,
      role: agent.role,
      color: agent.color,
      task: agent.taskSummary,
      status: agent.status,
      tokensUsed: agent.tokensUsed,
    });
  }

  setSelected(agentId: string | null): void {
    this.#selectedId = agentId;
    for (const [id, character] of this.#characters) {
      character.setSelected(id === agentId);
    }
  }

  setFollow(agentId: string | null): void {
    this.#selectedFollowId = agentId;
    this.rig.setFollow(agentId);
  }

  say(agentId: string, text: string): void {
    this.#characters.get(agentId)?.say(text);
  }

  resetCamera(): void {
    this.rig.reset();
  }

  /**
   * Machine-readable scene state, used by the browser verification harness to
   * assert that workers actually sit at their desks.
   */
  getDebugState(): {
    agents: { id: string; name: string; station: string; x: number; z: number }[];
    characters: { id: string; hipAngle: number; kneeAngle: number; bodyY: number }[];
  } {
    const agents = [...this.#agents.values()].map((agent) => ({
      id: agent.id,
      name: agent.name,
      station: agent.station,
      x: Number(this.#characters.get(agent.id)?.group.position.x.toFixed(3) ?? 0),
      z: Number(this.#characters.get(agent.id)?.group.position.z.toFixed(3) ?? 0),
    }));
    const characters = [...this.#characters.entries()].map(([id, character]) => ({
      id,
      ...character.pose(),
    }));
    return { agents, characters };
  }

  start(): void {
    const loop = (): void => {
      if (this.#disposed) return;
      this.#frame = requestAnimationFrame(loop);
      this.#tick();
    };
    loop();
  }

  #tick(): void {
    // Cap the step so a stalled tab does not teleport characters, but keep it
    // generous enough that walking keeps pace on software renderers.
    const delta = Math.min(this.#clock.getDelta(), 0.15);
    const time = this.#clock.elapsedTime;

    for (const [id, character] of this.#characters) {
      const destination = this.#destinations.get(id);
      if (destination) {
        const position = character.group.position;
        const dx = destination.x - position.x;
        const dz = destination.z - position.z;
        const distance = Math.hypot(dx, dz);
        if (distance > 0.06) {
          const step = Math.min(distance, WALK_SPEED * delta);
          position.x += (dx / distance) * step;
          position.z += (dz / distance) * step;
          const desiredYaw = Math.atan2(dx, dz);
          character.group.rotation.y = dampAngle(character.group.rotation.y, desiredYaw, 8, delta);
          character.setWalking(true);
          character.setSitting(false);
        } else {
          character.setWalking(false);
          const agent = this.#agents.get(id);
          const desiredYaw = agent
            ? stationFacing(agent.station, agent.deskIndex, agent.deskIndex)
            : character.group.rotation.y;
          character.group.rotation.y = dampAngle(character.group.rotation.y, desiredYaw, 5, delta);
          // Workers take a seat at the desks and around the meeting table.
          character.setSitting(agent?.station === 'desk' || agent?.station === 'meeting');
        }
      }
      character.update(time, delta);
    }

    for (const monitor of this.#office.monitors.values()) monitor.tick();

    const followed = this.#selectedFollowId ? this.#characters.get(this.#selectedFollowId) : undefined;
    this.rig.update(followed ? followed.group.position : null);

    this.#renderer.render(this.#scene, this.rig.camera);
    this.#labelRenderer.render(this.#scene, this.rig.camera);
  }

  #selectedFollowId: string | null = null;

  dispose(): void {
    this.#disposed = true;
    window.removeEventListener('resize', this.#resize);
    for (const character of this.#characters.values()) {
      this.#scene.remove(character.group);
      character.dispose();
    }
    this.#characters.clear();
    this.#renderer.dispose();
  }
}

function dampAngle(current: number, target: number, lambda: number, delta: number): number {
  let difference = target - current;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return current + difference * (1 - Math.exp(-lambda * delta));
}
