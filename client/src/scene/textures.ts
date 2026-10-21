import * as THREE from 'three';

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toRgb(hex: string): [number, number, number] {
  const color = new THREE.Color(hex);
  return [color.r * 255, color.g * 255, color.b * 255];
}

function shade(hex: string, amount: number): string {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + amount, 0, 1));
  return `#${color.getHexString()}`;
}

/** Oak plank floor with grain and seams. */
export function woodFloorTexture(baseHex = '#a9784b'): THREE.CanvasTexture {
  const size = 1024;
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');

  context.fillStyle = baseHex;
  context.fillRect(0, 0, size, size);

  const plankHeight = 64;
  for (let y = 0; y < size; y += plankHeight) {
    const variation = (Math.random() - 0.5) * 0.08;
    context.fillStyle = shade(baseHex, variation);
    context.fillRect(0, y, size, plankHeight);

    // Grain lines
    context.strokeStyle = `rgba(60, 38, 20, ${0.05 + Math.random() * 0.07})`;
    context.lineWidth = 1;
    for (let line = 0; line < 7; line += 1) {
      const lineY = y + 4 + Math.random() * (plankHeight - 8);
      context.beginPath();
      context.moveTo(0, lineY);
      for (let x = 0; x <= size; x += 32) {
        context.lineTo(x, lineY + Math.sin(x / 90 + line) * 1.8);
      }
      context.stroke();
    }

    // Plank seams
    context.fillStyle = 'rgba(48, 30, 16, 0.35)';
    context.fillRect(0, y, size, 2);
    const seamX = Math.floor(Math.random() * size);
    context.fillRect(seamX, y, 2, plankHeight);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2.4);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Soft plaster wall with fine speckle. */
export function plasterTexture(baseHex = '#d9d3c6'): THREE.CanvasTexture {
  const size = 512;
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.fillStyle = baseHex;
  context.fillRect(0, 0, size, size);

  const image = context.getImageData(0, 0, size, size);
  for (let index = 0; index < image.data.length; index += 4) {
    const noise = (Math.random() - 0.5) * 12;
    image.data[index] = Math.max(0, Math.min(255, (image.data[index] ?? 0) + noise));
    image.data[index + 1] = Math.max(0, Math.min(255, (image.data[index + 1] ?? 0) + noise));
    image.data[index + 2] = Math.max(0, Math.min(255, (image.data[index + 2] ?? 0) + noise));
  }
  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Woven fabric for the rug and sofa. */
export function fabricTexture(baseHex = '#2f6f6a'): THREE.CanvasTexture {
  const size = 256;
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.fillStyle = baseHex;
  context.fillRect(0, 0, size, size);

  context.globalAlpha = 0.12;
  for (let y = 0; y < size; y += 3) {
    context.fillStyle = y % 6 === 0 ? '#000' : '#fff';
    context.fillRect(0, y, size, 1);
  }
  for (let x = 0; x < size; x += 3) {
    context.fillStyle = x % 6 === 0 ? '#000' : '#fff';
    context.fillRect(x, 0, 1, size);
  }
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface MonitorState {
  name: string;
  role: string;
  color: string;
  task: string | null;
  status: 'idle' | 'working' | 'blocked' | 'error' | 'meeting';
  tokensUsed: number;
}

const CODE_SNIPPETS = [
  'const result = await agent.run(task);',
  'if (!result.ok) throw new Error("retry");',
  '  return result.data.map(r => r.id);',
  '// reviewing diff for edge cases',
  'await workspace.write("notes.md", out);',
  '  return { ok: true, ms: Date.now() - t0 };',
  'for (const file of changed) scan(file);',
  '  log.info("agent finished", { id });',
];

/** A live monitor screen that mirrors what one agent is working on. */
export class MonitorSurface {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  #context: CanvasRenderingContext2D;
  #state: MonitorState;
  #tick = 0;

  constructor(state: MonitorState) {
    this.canvas = createCanvas(512, 320);
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    this.#context = context;
    this.#state = state;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.draw();
  }

  setState(state: MonitorState): void {
    this.#state = state;
    this.draw();
  }

  /** Cheap animation hook so the screen feels alive while an agent works. */
  tick(): void {
    this.#tick += 1;
    if (this.#tick % 6 !== 0) return;
    if (this.#state.status !== 'working') return;
    this.draw();
  }

  private draw(): void {
    const context = this.#context;
    const { width, height } = this.canvas;
    const state = this.#state;

    context.fillStyle = '#0e1417';
    context.fillRect(0, 0, width, height);

    // Window chrome
    context.fillStyle = '#151d21';
    context.fillRect(0, 0, width, 34);
    context.fillStyle = state.color;
    context.fillRect(0, 0, width, 3);

    context.font = '600 17px ui-sans-serif, system-ui, sans-serif';
    context.fillStyle = '#eef2f1';
    context.fillText(state.name, 16, 23);

    context.font = '500 12px ui-monospace, Menlo, monospace';
    context.fillStyle = '#7b8a8c';
    context.fillText(state.role, 16 + context.measureText(state.name).width + 96, 23);

    // Task line
    context.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    context.fillStyle = state.status === 'error' ? '#ff8f76' : state.status === 'blocked' ? '#f2c14e' : '#d7e3e1';
    const taskText = state.task ?? (state.status === 'idle' ? 'Waiting for work' : 'Available');
    context.fillText(this.truncate(context, taskText, width - 32), 16, 64);

    if (state.status === 'working') {
      context.fillStyle = '#0b1114';
      context.fillRect(16, 80, width - 32, height - 108);
      context.font = '500 13px ui-monospace, Menlo, monospace';
      for (let line = 0; line < 9; line += 1) {
        const snippet = CODE_SNIPPETS[(line + this.#tick) % CODE_SNIPPETS.length] ?? '';
        context.fillStyle = line % 3 === 0 ? '#7fd6c4' : line % 3 === 1 ? '#9fb4b2' : '#5f7376';
        context.fillText(snippet ?? '', 28, 104 + line * 20);
      }
      context.fillStyle = '#7fd6c4';
      context.fillRect(28, 104 + 8 * 20, 9, 15);
    } else {
      const idleLines: Record<string, string> = {
        idle: '· idle — coffee break',
        blocked: '! waiting on a dependency',
        error: '× last run failed',
        meeting: '● in the standup meeting',
        working: '…',
      };
      context.font = '500 14px ui-monospace, Menlo, monospace';
      context.fillStyle = state.status === 'error' ? '#ff8f76' : '#6d7f81';
      context.fillText(idleLines[state.status] ?? '·', 16, 104);
    }

    // Status strip
    context.fillStyle = state.color;
    context.fillRect(0, height - 8, width, 8);

    context.font = '500 11px ui-monospace, Menlo, monospace';
    context.fillStyle = '#5f7376';
    context.fillText(`${state.tokensUsed} tok`, width - 62, height - 20);

    this.texture.needsUpdate = true;
  }

  private truncate(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (context.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 4 && context.measureText(`${cut}…`).width > maxWidth) {
      cut = cut.slice(0, -1);
    }
    return `${cut}…`;
  }
}

/** Whiteboard with marker scribbles. */
export function whiteboardTexture(): THREE.CanvasTexture {
  const canvas = createCanvas(512, 256);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.fillStyle = '#f3f2ec';
  context.fillRect(0, 0, 512, 256);

  context.strokeStyle = 'rgba(40, 60, 70, 0.55)';
  context.lineWidth = 2.5;
  context.lineCap = 'round';
  const boxes: [number, number, number, number][] = [
    [30, 30, 150, 60],
    [210, 30, 130, 60],
    [30, 130, 110, 70],
    [180, 120, 180, 80],
  ];
  for (const [x, y, w, h] of boxes) {
    context.strokeRect(x, y, w, h);
  }
  context.strokeStyle = 'rgba(190, 90, 60, 0.6)';
  context.beginPath();
  context.moveTo(180, 60);
  context.lineTo(210, 60);
  context.stroke();

  context.fillStyle = 'rgba(40, 60, 70, 0.65)';
  context.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  context.fillText('SPRINT', 30, 22);
  context.font = '500 13px ui-sans-serif, system-ui, sans-serif';
  context.fillText('design', 46, 62);
  context.fillText('api', 226, 62);
  context.fillText('qa', 46, 168);
  context.fillText('ship it', 198, 168);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export { toRgb };
