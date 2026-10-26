import './config.js';
import { chromium, type BrowserContext, type ElementHandle, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { dataDir, redact, targetUrl } from './config.js';
import { browserEnvironment } from './environment.js';
import type { AgentId, CaptureMode } from '../shared/types.js';

const controlsSelector = 'a, button, input, textarea, select, [role="button"], [role="tab"], [contenteditable="true"]';
const dangerous = /삭제|탈퇴|결제|구매|환불|delete|remove account|purchase|pay now/i;
type Control = { tag: string; type: string; label: string; href: string; form: string; identity: string };
type Reference = { element: ElementHandle<HTMLElement | SVGElement>; control: Control };

function describeControl(element: Element): Control {
  const input = element as HTMLInputElement;
  const form = (element as HTMLInputElement | HTMLButtonElement).form;
  return {
    tag: element.tagName.toLowerCase(),
    type: (input.type || element.getAttribute('type') || '').toLowerCase(),
    label: element.getAttribute('aria-label') || element.getAttribute('placeholder') || input.labels?.[0]?.innerText || (element as HTMLElement).innerText?.slice(0, 180) || element.getAttribute('name') || '',
    href: element.getAttribute('href') || '',
    form: form ? form.id + '|' + form.action + '|' + form.method : '',
    // Detect recycled rows, even if a framework retains the same physical button.
    identity: (element.closest('tr, li, [role="row"], article')?.textContent || '').trim().slice(0, 1200),
  };
}
export class AgentBrowser {
  context?: BrowserContext;
  page?: Page;
  private refs = new Map<string, Reference>();
  private generation = 0;
  private lastHash = '';
  private traceRunning = false;
  latestEvidence: string | null = null;
  constructor(readonly id: AgentId, readonly testId: string, readonly baseUrl: string,
    private notify: (file: string) => void, private closed: () => void,
    private captureMode: CaptureMode = 'off') {}
  setCaptureMode(mode: CaptureMode) { this.captureMode = mode; }
  describe(ref: string | null) { return ref ? redact(this.refs.get(ref)?.control.label || ref) : ''; }
  async invalidateRefs() {
    const previous = [...this.refs.values()];
    this.refs.clear();
    await Promise.all(previous.map(item => item.element.dispose().catch(() => {})));
  }
  async open() {
    if (this.context && this.page && !this.page.isClosed()) {
      await this.page.bringToFront();
      return;
    }
    if (this.context) await this.close();
    await mkdir(path.join(dataDir, 'profiles', this.id), { recursive: true });
    const context = await chromium.launchPersistentContext(path.join(dataDir, 'profiles', this.id), {
      headless: process.env.HEADLESS === 'true', viewport: { width: 1280, height: 800 },
      acceptDownloads: false, env: browserEnvironment(),
    });
    this.context = context;
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(20000);
    context.on('close', () => {
      if (this.context !== context) return;
      this.context = undefined; this.page = undefined; this.traceRunning = false;
      void this.invalidateRefs(); this.closed();
    });
    try {
      this.page = context.pages()[0] || await context.newPage();
      this.page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
      await this.capture('action');
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
  private scopedPage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error('브라우저가 닫혔습니다. 전용 브라우저를 다시 여세요.');
    if (new URL(this.page.url()).origin !== new URL(this.baseUrl).origin) throw new Error('로그인을 브라우저에서 직접 완료하고 테스트 대상 페이지로 돌아오세요. 외부 사이트는 탐색할 수 없습니다.');
    return this.page;
  }
  async snapshot() {
    const page = this.scopedPage();
    await this.invalidateRefs();
    const prefix = String(++this.generation) + '-';
    // Handles intentionally bind a ref to the observed node, not a changing nth() selector.
    const elements = await page.locator(controlsSelector).elementHandles() as ElementHandle<HTMLElement | SVGElement>[];
    const controls: { ref: string; tag: string; type: string; label: string }[] = [];
    for (const element of elements) {
      let retain = false;
      try {
        if (controls.length >= 150 || !(await element.isVisible())) continue;
        const info = await element.evaluate(describeControl);
        if (['password', 'hidden', 'file'].includes(info.type)) continue;
        const ref = prefix + controls.length;
        this.refs.set(ref, { element, control: info });
        retain = true;
        controls.push({ ref, tag: info.tag, type: info.type, label: redact(info.label) });
      } finally { if (!retain) await element.dispose().catch(() => {}); }
    }
    return { url: redact(page.url()), title: redact(await page.title()), text: redact((await page.locator('body').innerText()).slice(0, 14000)), controls };
  }
  async capture(reason: 'action' | 'finding' | 'error' = 'action') {
    if (this.captureMode === 'off' || (this.captureMode === 'findings' && reason === 'action')) return null;
    try {
      const page = this.scopedPage();
      const buffer = await page.screenshot({ type: 'png', animations: 'disabled', mask: [page.locator('input, textarea, [contenteditable="true"]')] });
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (hash === this.lastHash && this.latestEvidence) return this.latestEvidence;
      this.lastHash = hash;
      const file = this.testId + '-' + this.id + '-' + randomUUID() + '.png';
      await mkdir(path.join(dataDir, 'artifacts'), { recursive: true });
      await writeFile(path.join(dataDir, 'artifacts', file), buffer);
      this.latestEvidence = file;
      this.notify(file);
      return file;
    } catch { return null; }
  }
  async action(kind: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'scroll', value: string, ref?: string) {
    const page = this.scopedPage();
    try {
      if (kind === 'navigate') {
        const url = targetUrl(new URL(value, this.baseUrl).href);
        if (new URL(url).origin !== new URL(this.baseUrl).origin) throw new Error('테스트 대상과 같은 origin의 주소만 탐색할 수 있습니다.');
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      } else if (kind === 'scroll') {
        await page.mouse.wheel(0, value === 'up' ? -650 : 650);
      } else {
        const saved = this.refs.get(ref || '');
        if (!saved) throw new Error('유효한 ref가 아닙니다. observe 도구로 최신 화면을 먼저 확인하세요.');
        const element = saved.element;
        if (!(await element.evaluate(node => node.isConnected))) throw new Error('관찰한 요소가 교체됐습니다. 다시 관찰하세요.');
        const current = await element.evaluate(describeControl);
        if (['password', 'hidden', 'file'].includes(current.type)) throw new Error('비밀 정보 입력과 파일 업로드는 지원하지 않습니다.');
        if (JSON.stringify(current) !== JSON.stringify(saved.control)) throw new Error('요소의 의미가 바뀌었습니다. 다시 관찰하세요.');
        const submitting = kind === 'click' || (kind === 'press' && ['Enter', 'Space'].includes(value));
        if (submitting) {
          const policy = await element.evaluate(node => {
            const control = node as HTMLInputElement | HTMLButtonElement;
            const form = control.form;
            return {
              label: (node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || ''),
              // Includes implicit Enter submission and external form-associated buttons.
              formLabels: form ? [form.innerText, ...Array.from(form.elements).map(item =>
                (item.getAttribute('aria-label') || '') + ' ' + (item.matches('button, input[type=submit i], input[type=image i]') ? item.getAttribute('value') || '' : '') + ' ' + (item.getAttribute('title') || ''))].join(' ') : '',
              action: node.getAttribute('formaction') || form?.action || '',
              href: node.closest('a')?.href || '',
            };
          });
          if (dangerous.test(policy.label) || dangerous.test(policy.formLabels) || dangerous.test(policy.action)) throw new Error('MVP에서 제한된 위험 동작 또는 폼 제출입니다.');
          for (const destination of [policy.action, policy.href].filter(Boolean)) {
            const url = new URL(destination, this.baseUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(this.baseUrl).origin) throw new Error('외부 사이트로의 이동/제출은 전용 브라우저에서 직접 처리하세요.');
          }
        }
        if (kind === 'click') await element.click();
        if (kind === 'fill') await element.fill(value);
        if (kind === 'select') await element.selectOption(value);
        if (kind === 'press') {
          if (!['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(value)) throw new Error('허용되지 않은 키입니다.');
          await element.press(value);
        }
      }
    } finally { await this.invalidateRefs(); }
    await this.capture('action');
    return this.snapshot();
  }
  async startTrace() {
    if (this.captureMode !== 'actions' || !this.context) return;
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    this.traceRunning = true;
  }
  async stopTrace() {
    if (!this.context || !this.traceRunning) return null;
    this.traceRunning = false;
    const file = this.testId + '-' + this.id + '-' + randomUUID() + '.zip';
    await mkdir(path.join(dataDir, 'artifacts'), { recursive: true });
    await this.context.tracing.stop({ path: path.join(dataDir, 'artifacts', file) });
    return file;
  }
  async close() { await this.invalidateRefs(); await this.context?.close(); }
}
