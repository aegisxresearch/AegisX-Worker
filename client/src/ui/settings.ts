import { t } from '../../../shared/i18n.ts';
import type { PublicSettings, WorkspaceListing } from '../../../shared/types.ts';
import { api } from '../core/net.ts';
import { clear, el, icon } from './dom.ts';

export class SettingsPanel {
  readonly #modal = document.getElementById('settings-modal') as HTMLElement;
  readonly #form = document.getElementById('settings-form') as HTMLFormElement;
  readonly #endpoint = document.getElementById('settings-endpoint') as HTMLInputElement;
  readonly #key = document.getElementById('settings-key') as HTMLInputElement;
  readonly #model = document.getElementById('settings-model') as HTMLInputElement;
  readonly #modelOptions = document.getElementById('model-options') as HTMLDataListElement;
  readonly #tools = document.getElementById('settings-tools') as HTMLInputElement;
  readonly #web = document.getElementById('settings-web') as HTMLInputElement;
  readonly #demo = document.getElementById('settings-demo') as HTMLInputElement;
  readonly #status = document.getElementById('settings-status') as HTMLElement;
  readonly #modelHint = document.getElementById('model-hint') as HTMLElement;
  readonly #disconnect = document.getElementById('settings-disconnect') as HTMLButtonElement;

  readonly #workspacePill = document.getElementById('workspace-pill') as HTMLButtonElement;
  readonly #workspacePath = document.getElementById('workspace-path') as HTMLElement;
  readonly #workspaceCurrent = document.getElementById('workspace-current') as HTMLElement;
  readonly #workspaceBrowse = document.getElementById('workspace-browse') as HTMLButtonElement;
  readonly #workspaceBrowser = document.getElementById('workspace-browser') as HTMLElement;
  readonly #workspaceUp = document.getElementById('workspace-up') as HTMLButtonElement;
  readonly #workspaceCrumb = document.getElementById('workspace-crumb') as HTMLElement;
  readonly #workspaceList = document.getElementById('workspace-list') as HTMLElement;
  readonly #workspaceChoose = document.getElementById('workspace-choose') as HTMLButtonElement;
  readonly #workspaceCancel = document.getElementById('workspace-cancel') as HTMLButtonElement;

  #listing: WorkspaceListing | null = null;
  #root = '';
  /** Last settings snapshot, so the picker can talk to the right server root. */
  #settings: PublicSettings | null = null;

  constructor() {
    const close = document.getElementById('settings-close') as HTMLButtonElement;
    close.append(icon('close', 15));
    close.addEventListener('click', () => this.close());

    const open = document.getElementById('open-settings') as HTMLButtonElement;
    open.append(icon('sliders', 15));
    open.addEventListener('click', () => this.open());

    this.#modal.addEventListener('click', (event) => {
      if (event.target === this.#modal) this.close();
    });

    this.#form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.#connect();
    });

    this.#disconnect.addEventListener('click', () => {
      void this.#disconnectFromServer();
    });

    this.#web.addEventListener('change', () => {
      void this.#saveWeb(this.#web.checked);
    });

    this.#workspacePill.addEventListener('click', () => this.open());
    this.#workspaceBrowse.addEventListener('click', () => {
      void this.#openBrowser(this.#root);
    });
    this.#workspaceCancel.addEventListener('click', () => {
      this.#workspaceBrowser.hidden = true;
    });
    this.#workspaceUp.addEventListener('click', () => {
      const parent = this.#listing?.parent;
      if (parent) void this.#openBrowser(parent);
    });
    this.#workspaceChoose.addEventListener('click', () => {
      const target = this.#listing?.path;
      if (target) void this.#chooseRoot(target);
    });
  }

  open(): void {
    this.#modal.hidden = false;
    this.#key.focus();
  }

  close(): void {
    this.#modal.hidden = true;
    this.#workspaceBrowser.hidden = true;
  }

  render(settings: PublicSettings | null): void {
    if (!settings) return;
    this.#settings = settings;
    this.#root = settings.workspaceRoot;

    if (document.activeElement !== this.#endpoint) this.#endpoint.value = settings.endpoint;
    if (document.activeElement !== this.#model) this.#model.value = settings.model;
    this.#tools.checked = settings.toolsEnabled;
    this.#web.checked = settings.webEnabled;
    this.#demo.checked = settings.demoMode;

    this.#workspaceCurrent.textContent = settings.workspaceRoot;
    this.#workspaceCurrent.title = settings.workspaceRoot;
    this.#workspacePath.textContent = compactPath(settings.workspaceRoot);
    this.#workspacePill.title = `Workspace: ${settings.workspaceRoot}`;

    this.#modelOptions.replaceChildren();

    // The free model is pinned first: it is the safe default and the fallback.
    const freeOption = el('option');
    freeOption.value = settings.freeModel;
    freeOption.textContent = t('settings.freeTier', { model: settings.freeModel });
    this.#modelOptions.append(freeOption);

    for (const model of settings.availableModels.slice(0, 60)) {
      if (model === settings.freeModel) continue;
      const option = el('option');
      option.value = model;
      this.#modelOptions.append(option);
    }

    this.#modelHint.textContent = t('settings.freeHint', { model: settings.freeModel });
  }

  async #openBrowser(target: string): Promise<void> {
    this.#workspaceBrowser.hidden = false;
    this.#workspaceList.replaceChildren(el('li', 'workspace-empty', t('common.loading')));
    try {
      const response = await api.get<{ ok: boolean; listing: WorkspaceListing; message?: string }>(
        `/api/session/workspace/list?path=${encodeURIComponent(target)}`,
      );
      this.#listing = response.listing;
      this.#workspaceCrumb.textContent = response.listing.path;
      this.#workspaceCrumb.title = response.listing.path;
      this.#workspaceUp.disabled = response.listing.parent === null;

      clear(this.#workspaceList);
      if (response.listing.entries.length === 0) {
        this.#workspaceList.append(el('li', 'workspace-empty', t('settings.noSubfolders')));
      }
      for (const entry of response.listing.entries) {
        const row = el('li', 'workspace-row');
        const button = el('button', 'workspace-entry');
        button.type = 'button';
        button.append(icon('folder', 14), el('span', undefined, entry.name));
        button.addEventListener('click', () => {
          void this.#openBrowser(entry.path);
        });
        row.append(button);
        this.#workspaceList.append(row);
      }
    } catch (error) {
      clear(this.#workspaceList);
      this.#workspaceList.append(
        el(
          'li',
          'workspace-empty',
          error instanceof Error ? error.message : t('settings.cannotRead'),
        ),
      );
    }
  }

  async #chooseRoot(target: string): Promise<void> {
    this.#workspaceChoose.disabled = true;
    try {
      const outcome = await api.post<{ ok: boolean; settings: PublicSettings; message?: string }>(
        '/api/session/workspace',
        { root: target },
      );
      this.#workspaceBrowser.hidden = true;
      this.#setStatus(t('settings.workspaceSet', { path: outcome.settings.workspaceRoot }), 'ok');
    } catch (error) {
      this.#setStatus(
        error instanceof Error ? error.message : t('settings.cannotUse'),
        'error',
      );
    } finally {
      this.#workspaceChoose.disabled = false;
    }
  }

  async #saveWeb(enabled: boolean): Promise<void> {
    try {
      await api.post('/api/session/web', { enabled });
      this.#setStatus(enabled ? t('settings.webOn') : t('settings.webOff'), 'ok');
    } catch (error) {
      this.#web.checked = !enabled;
      this.#setStatus(
        error instanceof Error ? error.message : t('settings.cannotChangeWeb'),
        'error',
      );
    }
  }

  async #connect(): Promise<void> {
    const apiKey = this.#key.value.trim();
    if (apiKey.length === 0) {
      this.#setStatus(t('settings.pasteKey'), 'error');
      return;
    }
    this.#setStatus(t('settings.connecting'), 'pending');
    this.#disconnect.disabled = true;

    try {
      const outcome = await api.post<{ ok: boolean; message: string }>('/api/session/connect', {
        endpoint: this.#endpoint.value.trim(),
        apiKey,
        model: this.#model.value.trim(),
        toolsEnabled: this.#tools.checked,
      });
      this.#setStatus(outcome.message, outcome.ok ? 'ok' : 'error');
      if (outcome.ok) {
        this.#key.value = '';
        this.#demo.checked = false;
      }
    } catch (error) {
      this.#setStatus(
        error instanceof Error ? error.message : t('settings.connectionFailed'),
        'error',
      );
    } finally {
      this.#disconnect.disabled = false;
    }
  }

  async #disconnectFromServer(): Promise<void> {
    await api.post('/api/session/demo', { enabled: true });
    this.#key.value = '';
    this.#demo.checked = true;
    this.#setStatus(t('settings.disconnected'), 'ok');
  }

  #setStatus(message: string, state: 'ok' | 'error' | 'pending'): void {
    this.#status.textContent = message;
    this.#status.dataset.state = state;
  }
}

/** Keeps the header pill short: `…/projects/aegis` instead of the whole path. */
function compactPath(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  if (segments.length <= 2) return fullPath;
  return `…/${segments.slice(-2).join('/')}`;
}
