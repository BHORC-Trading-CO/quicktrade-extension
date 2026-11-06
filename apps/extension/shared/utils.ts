import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getQueryParams(params: Record<string, string | number | boolean>): string {
  const entries = Object.entries(params);
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${k}=${v}`).join('&');
}

export async function fetchJson<TOk = unknown, TErr = Error>(url: string, init: RequestInit = {}): Promise<TOk | Error | TErr> {
  const merged: RequestInit = {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  };
  try {
    const res = await fetch(url, merged);
    return (await res.json()) as TOk;
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
}

export async function tabsCreate(createProperties: chrome.tabs.CreateProperties, tabProps: Partial<chrome.tabs.Tab> = {}, timeout = 5000): Promise<chrome.tabs.Tab> {
  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    let globalTab: chrome.tabs.Tab;
    const timer = setTimeout(() => resolve(globalTab), timeout);
    browser.tabs.create(createProperties).then((tab) => {
      globalTab = tab;
      if (!Object.keys(tabProps).length) {
        resolve(globalTab);
        clearTimeout(timer);
        return;
      }
      const listener = (tabId: number, _changeInfo: chrome.tabs.TabChangeInfo, updated: chrome.tabs.Tab) => {
        if (tabId !== globalTab.id) return;
        if (Object.entries(tabProps).every(([k, v]) => (updated as never)[k] === v)) {
          browser.tabs.onUpdated.removeListener(listener);
          resolve(updated);
          clearTimeout(timer);
        }
      };
      browser.tabs.onUpdated.addListener(listener);
    }, reject);
  });
}

export async function tabsRemove(tabId: number): Promise<void> {
  await browser.tabs.remove(tabId);
}
