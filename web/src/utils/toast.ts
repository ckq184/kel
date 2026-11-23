/** Lightweight toast notification — no external dependencies. */

const MAX_TOASTS = 5;
let container: HTMLDivElement | null = null;

function getContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
  document.body.appendChild(container);
  return container;
}

/** Create a toast element with shared styling and animation. Returns { el, dismiss }. */
function createToastElement(extraCss = ''): {
  el: HTMLDivElement;
  dismiss: () => void;
} {
  const c = getContainer();
  while (c.childElementCount >= MAX_TOASTS && c.firstChild) {
    c.removeChild(c.firstChild);
  }

  const el = document.createElement('div');
  el.style.cssText =
    'pointer-events:auto;max-width:360px;padding:12px 16px;border-radius:8px;' +
    'background:#1a1a2e;color:#e0e0e0;box-shadow:0 4px 12px rgba(0,0,0,0.3);' +
    'font-size:14px;line-height:1.4;opacity:0;transform:translateX(40px);' +
    'transition:opacity 0.3s,transform 0.3s;' +
    extraCss;

  c.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(0)';
  });

  const dismiss = () => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(40px)';
    setTimeout(() => el.remove(), 300);
  };

  return { el, dismiss };
}

export function showToast(
  title: string,
  body?: string,
  durationMs = 5000,
  link?: { text: string; url: string },
): void {
  const { el, dismiss } = createToastElement();

  const titleEl = document.createElement('div');
  titleEl.style.fontWeight = '600';
  titleEl.textContent = title;
  el.appendChild(titleEl);

  if (body) {
    const bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'margin-top:4px;font-size:13px;opacity:0.85;';
    bodyEl.textContent = body.length > 120 ? body.slice(0, 120) + '…' : body;
    el.appendChild(bodyEl);
  }

  if (link) {
    const linkEl = document.createElement('a');
    linkEl.href = link.url;
    linkEl.target = '_blank';
    linkEl.rel = 'noopener noreferrer';
    linkEl.textContent = link.text;
    linkEl.style.cssText =
      'display:inline-block;margin-top:6px;font-size:13px;color:#5eead4;' +
      'text-decoration:underline;cursor:pointer;';
    el.appendChild(linkEl);
  }

  setTimeout(dismiss, durationMs);
}

/**
 * Send a browser Notification when the page is in the background.
 * Only fires if permission was already granted — never prompts the user
 * from a passive event handler. Permission should be requested via a
 * user-initiated action (e.g. a settings toggle).
 */
export function notifyIfHidden(title: string, body?: string): void {
  if (!document.hidden) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

/** One-time prompt to request desktop notification permission. */
let notificationPromptShown = false;

export function showNotificationPromptToast(): void {
  if (notificationPromptShown) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  notificationPromptShown = true;

  const { el, dismiss } = createToastElement(
    'display:flex;align-items:center;gap:12px;',
  );

  const textEl = document.createElement('span');
  textEl.style.flex = '1';
  textEl.textContent = '开启桌面通知，对话完成时提醒你';
  el.appendChild(textEl);

  const btn = document.createElement('button');
  btn.textContent = '开启';
  btn.style.cssText =
    'flex-shrink:0;padding:4px 10px;border-radius:5px;border:none;' +
    'background:#5eead4;color:#0f172a;font-size:13px;font-weight:600;cursor:pointer;';
  btn.addEventListener('click', () => {
    Notification.requestPermission();
    dismiss();
  });
  el.appendChild(btn);

  setTimeout(dismiss, 12000);
}
