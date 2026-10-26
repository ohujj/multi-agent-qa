import './config.js';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { dataDir, redact, targetUrl } from './config.js';
import type { AgentId } from '../shared/types.js';

export class AgentBrowser {
  context?: BrowserContext;
  page?: Page;
  private refs = new Map<string, Locator>();
  private generation = 0;
  private lastHash = '';
  latestEvidence: string | null = null;
  constructor(readonly id: AgentId, readonly testId: string, readonly baseUrl: string, private notify: (file: string) => void, private closed: () => void) {}
  async open() {
    if (this.context) { await this.page?.bringToFront(); return; }
    await mkdir(path.join(dataDir, 'profiles', this.id), { recursive: true });
    this.context = await chromium.launchPersistentContext(path.join(dataDir, 'profiles', this.id), {
      headless: process.env.HEADLESS === 'true', viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
    });
    this.context.setDefaultTimeout(10000);
    this.context.setDefaultNavigationTimeout(20000);
    this.context.on('close', () => { this.context = undefined; this.page = undefined; this.closed(); });
    // External login windows are operated manually, never exposed to agent tools.
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
    await this.capture();
  }
  private scopedPage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error('브라우저가 닫혔습니다. 전용 브라우저를 다시 여세요.');
    if (new URL(this.page.url()).origin !== new URL(this.baseUrl).origin) throw new Error('로그인을 브라우저에서 직접 완료하고 테스트 대상 페이지로 돌아오세요. 외부 사이트는 탐색할 수 없습니다.');
    return this.page;
  }
  async snapshot() {
    const page = this.scopedPage();
    this.refs.clear();
    const prefix = String(++this.generation) + '-';
    const elements = await page.locator('a, button, input, textarea, select, [role="button"], [role="tab"], [contenteditable="true"]').all();
    const controls: { ref: string; tag: string; type: string; label: string }[] = [];
    for (const locator of elements.slice(0, 150)) {
      if (!(await locator.isVisible().catch(() => false))) continue;
      const info = await locator.evaluate(element => ({
        tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '',
        label: element.getAttribute('aria-label') || element.getAttribute('placeholder') || (element as HTMLInputElement).labels?.[0]?.innerText || (element as HTMLElement).innerText?.slice(0, 180) || element.getAttribute('name') || '',
      }));
      if (['password', 'hidden', 'file'].includes(info.type)) continue;
      const ref = prefix + controls.length;
      this.refs.set(ref, locator);
      controls.push({ ref, ...info, label: redact(info.label) });
    }
    return { url: redact(page.url()), title: await page.title(), text: redact((await page.locator('body').innerText()).slice(0, 14000)), controls };
  }
  async capture() {
    try {
      const page = this.scopedPage();
      // Hide input values from recorded screenshots. Auth pages outside target are never captured.
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
    if (kind === 'navigate') {
      const url = targetUrl(new URL(value, this.baseUrl).href);
      if (new URL(url).origin !== new URL(this.baseUrl).origin) throw new Error('테스트 대상과 같은 origin의 주소만 탐색할 수 있습니다.');
      this.refs.clear();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } else if (kind === 'scroll') {
      await page.mouse.wheel(0, value === 'up' ? -650 : 650);
    } else {
      const locator = this.refs.get(ref || '');
      if (!locator) throw new Error('유효한 ref가 아닙니다. observe 도구로 최신 화면을 먼저 확인하세요.');
      // Recheck at action time: the DOM may have changed since observation.
      const type = await locator.getAttribute('type');
      if (['password', 'hidden', 'file'].includes(type || '')) throw new Error('비밀 정보 입력과 파일 업로드는 지원하지 않습니다.');
      const label = ((await locator.innerText().catch(() => '')) + ' ' + (await locator.getAttribute('aria-label') || '')).trim();
      if ((kind === 'click' || (kind === 'press' && ['Enter', 'Space'].includes(value))) && /삭제|탈퇴|결제|구매|환불|delete|remove account|purchase|pay now/i.test(label)) throw new Error('MVP에서 제한된 위험 동작입니다. 발견 사항으로 기록하세요.');
      if (kind === 'click') await locator.click();
      if (kind === 'fill') await locator.fill(value);
      if (kind === 'select') await locator.selectOption(value);
      if (kind === 'press') {
        if (!['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'].includes(value)) throw new Error('허용되지 않은 키입니다.');
        await locator.press(value);
      }
      this.refs.clear();
    }
    await this.capture();
    return this.snapshot();
  }
  async startTrace() { await this.context?.tracing.start({ screenshots: true, snapshots: true, sources: false }); }
  async stopTrace() {
    if (!this.context) return null;
    const file = this.testId + '-' + this.id + '-' + randomUUID() + '.zip';
    await mkdir(path.join(dataDir, 'artifacts'), { recursive: true });
    await this.context.tracing.stop({ path: path.join(dataDir, 'artifacts', file) });
    return file;
  }
  async close() { await this.context?.close(); }
}
