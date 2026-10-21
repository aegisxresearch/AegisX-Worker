import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AgentProfile, AgentStatus } from '../../../shared/types.ts';

export type PoseState = 'idle' | 'walk' | 'typing' | 'blocked' | 'error' | 'meeting';

const UNIT = 1.25;
const HIP_Y = 0.52 * UNIT;
const SHOULDER_Y = 0.95 * UNIT;
const HEAD_Y = 1.17 * UNIT;
const ARM_REACH = 0.26 * UNIT;
const LEG_REACH = 0.09 * UNIT;
/** How far the hips drop when the worker takes a seat. */
const SIT_DROP = 0.1;
/** Thigh angle when seated: horizontal, pointing forward. */
const SIT_HIP_ANGLE = -Math.PI / 2;
/** Shin angle when seated: vertical plus a little extra bend so feet reach the floor. */
const SIT_KNEE_ANGLE = Math.PI / 2 + 0.24;

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: '#8b9899',
  working: '#2fb8a6',
  blocked: '#e9a23b',
  error: '#e2564b',
  meeting: '#4c9aff',
};

const SKIN_TONES = ['#e8c39a', '#c98d63', '#8d5a3b', '#f0d2b4', '#a9714a'];

function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 9973;
  }
  return hash;
}

export interface AgentCharacter {
  readonly group: THREE.Group;
  readonly agentId: string;
  readonly position: THREE.Vector3;
  setStatus(status: AgentStatus): void;
  setWalking(walking: boolean): void;
  setSitting(sitting: boolean): void;
  setSelected(selected: boolean): void;
  say(text: string): void;
  update(time: number, delta: number): void;
  pose(): { sitBlend: number; hipAngle: number; kneeAngle: number; bodyY: number };
  dispose(): void;
}

/**
 * Builds one low-poly worker: head, torso, two-segment arms, two-segment legs,
 * a status ring on the floor and a CSS2D name tag.
 */
export function createAgentCharacter(agent: AgentProfile): AgentCharacter {
  const group = new THREE.Group();
  group.name = `agent-${agent.id}`;

  const body = new THREE.Group();
  group.add(body);

  const bodyColor = new THREE.Color(agent.color);
  const limbColor = bodyColor.clone().multiplyScalar(0.82);
  const skin = new THREE.Color(SKIN_TONES[hashSeed(agent.name) % SKIN_TONES.length] ?? '#e8c39a');
  const hairColor = new THREE.Color('#2b2320');

  // ── torso ────────────────────────────────────────────────────────────────
  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.44 * UNIT, 0.52 * UNIT, 0.3 * UNIT),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.72, metalness: 0.02 }),
  );
  torso.position.y = HIP_Y + 0.25 * UNIT;
  torso.castShadow = true;
  body.add(torso);

  const collar = new THREE.Mesh(
    new THREE.BoxGeometry(0.3 * UNIT, 0.08 * UNIT, 0.24 * UNIT),
    new THREE.MeshStandardMaterial({ color: bodyColor.clone().multiplyScalar(1.18), roughness: 0.6 }),
  );
  collar.position.y = HIP_Y + 0.5 * UNIT;
  body.add(collar);

  // ── head ─────────────────────────────────────────────────────────────────
  const headPivot = new THREE.Group();
  headPivot.position.y = HEAD_Y;
  body.add(headPivot);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.2 * UNIT, 22, 16),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.62 }),
  );
  head.castShadow = true;
  headPivot.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.207 * UNIT, 22, 16, 0, Math.PI * 2, 0, Math.PI * 0.56),
    new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.85 }),
  );
  hair.position.y = 0.012 * UNIT;
  hair.castShadow = true;
  headPivot.add(hair);

  const eyeGeometry = new THREE.SphereGeometry(0.024 * UNIT, 10, 8);
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#20191a', roughness: 0.4 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye.position.set(0.07 * UNIT * side, 0.01 * UNIT, 0.185 * UNIT);
    headPivot.add(eye);
  }

  // ── arms ────────────────────────────────────────────────────────────────
  interface Arm {
    shoulder: THREE.Group;
    elbow: THREE.Group;
  }

  const makeArm = (side: number): Arm => {
    const shoulder = new THREE.Group();
    shoulder.position.set(ARM_REACH * side, SHOULDER_Y, 0);
    body.add(shoulder);

    const upper = new THREE.Mesh(
      new THREE.BoxGeometry(0.11 * UNIT, 0.42 * UNIT, 0.12 * UNIT),
      new THREE.MeshStandardMaterial({ color: limbColor, roughness: 0.7 }),
    );
    upper.position.y = -0.21 * UNIT;
    upper.castShadow = true;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -0.42 * UNIT;
    shoulder.add(elbow);

    const fore = new THREE.Mesh(
      new THREE.BoxGeometry(0.1 * UNIT, 0.36 * UNIT, 0.11 * UNIT),
      new THREE.MeshStandardMaterial({ color: limbColor.clone().multiplyScalar(1.06), roughness: 0.7 }),
    );
    fore.position.y = -0.18 * UNIT;
    fore.castShadow = true;
    elbow.add(fore);

    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(0.07 * UNIT, 12, 10),
      new THREE.MeshStandardMaterial({ color: skin, roughness: 0.6 }),
    );
    hand.position.y = -0.36 * UNIT;
    elbow.add(hand);

    return { shoulder, elbow };
  };

  const armLeft = makeArm(-1);
  const armRight = makeArm(1);

  // ── legs ────────────────────────────────────────────────────────────────
  interface Leg {
    hip: THREE.Group;
    knee: THREE.Group;
  }

  const makeLeg = (side: number): Leg => {
    const hip = new THREE.Group();
    hip.position.set(LEG_REACH * side, HIP_Y, 0);
    body.add(hip);

    const thigh = new THREE.Mesh(
      new THREE.BoxGeometry(0.15 * UNIT, 0.5 * UNIT, 0.16 * UNIT),
      new THREE.MeshStandardMaterial({ color: '#2b3340', roughness: 0.8 }),
    );
    thigh.position.y = -0.25 * UNIT;
    thigh.castShadow = true;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -0.5 * UNIT;
    hip.add(knee);

    const shin = new THREE.Mesh(
      new THREE.BoxGeometry(0.13 * UNIT, 0.45 * UNIT, 0.14 * UNIT),
      new THREE.MeshStandardMaterial({ color: '#333d4d', roughness: 0.8 }),
    );
    shin.position.y = -0.22 * UNIT;
    shin.castShadow = true;
    knee.add(shin);

    const foot = new THREE.Mesh(
      new THREE.BoxGeometry(0.15 * UNIT, 0.08 * UNIT, 0.25 * UNIT),
      new THREE.MeshStandardMaterial({ color: '#1d222a', roughness: 0.9 }),
    );
    foot.position.set(0, -0.44 * UNIT, 0.04 * UNIT);
    foot.castShadow = true;
    knee.add(foot);

    return { hip, knee };
  };

  const legLeft = makeLeg(-1);
  const legRight = makeLeg(1);

  // ── status ring on the floor ────────────────────────────────────────────
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42 * UNIT, 0.5 * UNIT, 32),
    new THREE.MeshBasicMaterial({
      color: STATUS_COLORS.idle,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);

  // ── name tag ────────────────────────────────────────────────────────────
  const tagElement = document.createElement('div');
  tagElement.className = 'agent-tag';
  tagElement.dataset.status = 'idle';
  const tagDot = document.createElement('span');
  tagDot.className = 'tag-dot';
  const tagName = document.createElement('span');
  tagName.textContent = agent.name;
  const tagRole = document.createElement('span');
  tagRole.className = 'tag-role';
  tagRole.textContent = agent.role;
  tagElement.append(tagDot, tagName, tagRole);
  const tag = new CSS2DObject(tagElement);
  tag.position.set(0, 1.72 * UNIT, 0);
  tag.center.set(0.5, 1);
  group.add(tag);

  let bubbleTimeout: number | null = null;
  let bubble: CSS2DObject | null = null;

  let status: AgentStatus = 'idle';
  let walking = false;
  let walkBlend = 0;
  let sitting = false;
  let sitBlend = 0;
  let phase = Math.random() * Math.PI * 2;

  const poseForStatus = (): PoseState => {
    if (walking) return 'walk';
    switch (status) {
      case 'working':
        return 'typing';
      case 'blocked':
        return 'blocked';
      case 'error':
        return 'error';
      case 'meeting':
        return 'meeting';
      default:
        return 'idle';
    }
  };

  const setStatus = (next: AgentStatus): void => {
    status = next;
    tagElement.dataset.status = next;
  };

  const setWalking = (isWalking: boolean): void => {
    walking = isWalking;
  };

  const setSitting = (isSitting: boolean): void => {
    sitting = isSitting;
  };

  const setSelected = (selected: boolean): void => {
    tagElement.classList.toggle('is-selected', selected);
  };

  const say = (text: string): void => {
    if (bubble) {
      group.remove(bubble);
      bubble.element.remove();
      bubble = null;
    }
    const element = document.createElement('div');
    element.className = 'speech-bubble';
    element.textContent = text;
    const object = new CSS2DObject(element);
    object.position.set(0, 2.1 * UNIT, 0);
    object.center.set(0.5, 1);
    group.add(object);
    bubble = object;

    if (bubbleTimeout !== null) window.clearTimeout(bubbleTimeout);
    bubbleTimeout = window.setTimeout(() => {
      if (bubble) {
        group.remove(bubble);
        bubble.element.remove();
        bubble = null;
      }
    }, 5200);
  };

  const update = (time: number, delta: number): void => {
    const smoothing = 1 - Math.pow(0.0001, delta);
    phase += delta;
    const pose = poseForStatus();

    // Walking overrides the idle pose while the worker travels.
    const targetWalk = pose === 'walk' ? 1 : 0;
    walkBlend += (targetWalk - walkBlend) * smoothing;
    const sitTarget = sitting && walkBlend < 0.35 ? 1 : 0;
    sitBlend += (sitTarget - sitBlend) * smoothing;
    const stride = Math.sin(phase * 9);
    const stride2 = Math.sin(phase * 9 + Math.PI);

    const restful = pose === 'idle' || walkBlend < 0.5;
    const typing = pose === 'typing' && walkBlend < 0.5;
    const blocked = pose === 'blocked' && walkBlend < 0.5;
    const error = pose === 'error' && walkBlend < 0.5;
    const meeting = pose === 'meeting' && walkBlend < 0.5;

    // Legs: walk swing when moving, folded forward once seated.
    const legSwing = stride * 0.62 * walkBlend;
    const sitHip = SIT_HIP_ANGLE * sitBlend;
    const sitKnee = SIT_KNEE_ANGLE * sitBlend;
    const legLeftTarget = legSwing + sitHip;
    const legRightTarget = stride2 * 0.62 * walkBlend + sitHip;
    legLeft.hip.rotation.x += (legLeftTarget - legLeft.hip.rotation.x) * smoothing;
    legRight.hip.rotation.x += (legRightTarget - legRight.hip.rotation.x) * smoothing;
    legLeft.knee.rotation.x += (Math.max(0, -legSwing) * 0.7 + sitKnee - legLeft.knee.rotation.x) * smoothing;
    legRight.knee.rotation.x += (Math.max(0, -legRightTarget) * 0.7 + sitKnee - legRight.knee.rotation.x) * smoothing;

    // Arms
    let leftX = 0;
    let rightX = 0;
    let leftZ = 0;
    let rightZ = 0;
    let elbowLeft = 0;
    let elbowRight = 0;

    if (walkBlend > 0.02) {
      leftX = stride2 * 0.5 * walkBlend;
      rightX = stride * 0.5 * walkBlend;
      leftZ = 0.08 * walkBlend;
      rightZ = -0.08 * walkBlend;
    }
    if (sitBlend > 0.02) {
      // Seated: hands rest forward on the desk, arms folded toward the lap.
      leftX = -0.3 * sitBlend;
      rightX = -0.3 * sitBlend;
      elbowLeft = -0.85 * sitBlend;
      elbowRight = -0.85 * sitBlend;
      leftZ = 0.16 * sitBlend;
      rightZ = -0.16 * sitBlend;
    }
    if (typing) {
      const tap = Math.sin(phase * 12) * 0.1;
      const reach = 0.55 + 0.42 * sitBlend;
      leftX = -reach;
      rightX = -reach;
      elbowLeft = -0.95 - 0.25 * sitBlend + tap;
      elbowRight = -0.95 - 0.25 * sitBlend - tap;
      leftZ = 0.22 - 0.06 * sitBlend;
      rightZ = -0.22 + 0.06 * sitBlend;
    }
    if (blocked) {
      leftX = -0.3;
      rightX = -0.3;
      leftZ = 0.7;
      rightZ = -0.7;
      elbowLeft = -0.5;
      elbowRight = -0.5;
    }
    if (error) {
      leftX = -2.2;
      rightX = -2.2;
      leftZ = 0.45;
      rightZ = -0.45;
    }
    if (meeting) {
      leftX = -0.75;
      rightX = -0.75;
      leftZ = 0.5;
      rightZ = -0.5;
      elbowLeft = -1.5;
      elbowRight = -1.5;
    }
    if (restful && walkBlend < 0.02) {
      const sway = Math.sin(phase * 1.4) * 0.05;
      leftZ = sway;
      rightZ = -sway;
    }

    armLeft.shoulder.rotation.x += (leftX - armLeft.shoulder.rotation.x) * smoothing;
    armRight.shoulder.rotation.x += (rightX - armRight.shoulder.rotation.x) * smoothing;
    armLeft.shoulder.rotation.z += (leftZ - armLeft.shoulder.rotation.z) * smoothing;
    armRight.shoulder.rotation.z += (rightZ - armRight.shoulder.rotation.z) * smoothing;
    armLeft.elbow.rotation.x += (elbowLeft - armLeft.elbow.rotation.x) * smoothing;
    armRight.elbow.rotation.x += (elbowRight - armRight.elbow.rotation.x) * smoothing;

    // Head
    const headTargetX = typing ? 0.22 + 0.1 * sitBlend : error ? -0.25 : blocked ? 0.12 : 0;
    const headTargetY = restful ? Math.sin(phase * 0.42) * 0.42 : 0;
    headPivot.rotation.x += (headTargetX - headPivot.rotation.x) * smoothing;
    headPivot.rotation.y += (headTargetY - headPivot.rotation.y) * smoothing;

    // Body bob + breathing + seat drop
    const bob = Math.abs(Math.sin(phase * 9)) * 0.05 * walkBlend;
    const breathe = Math.sin(phase * 1.6) * 0.012;
    body.position.y = bob - SIT_DROP * sitBlend;
    body.scale.y = 1 + breathe;
    if (error) {
      group.position.x += Math.sin(phase * 26) * 0.004;
    }

    // Status ring
    const ringMaterial = ring.material as THREE.MeshBasicMaterial;
    tag.position.y = 1.72 * UNIT - SIT_DROP * sitBlend;
    if (bubble) bubble.position.y = 2.1 * UNIT - SIT_DROP * sitBlend;
    const targetOpacity = status === 'working' ? 0.55 : status === 'error' ? 0.6 : status === 'blocked' ? 0.5 : 0;
    ringMaterial.opacity += (targetOpacity - ringMaterial.opacity) * smoothing * 0.6;
    ringMaterial.color.set(STATUS_COLORS[status]);
    ring.scale.setScalar(1 + Math.sin(phase * 3) * 0.04);
  };

  const pose = (): { sitBlend: number; hipAngle: number; kneeAngle: number; bodyY: number } => ({
    sitBlend: Number(sitBlend.toFixed(3)),
    hipAngle: Number(legLeft.hip.rotation.x.toFixed(3)),
    kneeAngle: Number(legLeft.knee.rotation.x.toFixed(3)),
    bodyY: Number(body.position.y.toFixed(3)),
  });

  const dispose = (): void => {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material.dispose();
      }
    });
    tagElement.remove();
    if (bubble) bubble.element.remove();
  };

  setStatus('idle');

  return {
    group,
    agentId: agent.id,
    position: group.position,
    setStatus,
    setWalking,
    setSitting,
    setSelected,
    say,
    update,
    pose,
    dispose,
  };
}
