import { getChatsRoot } from '@/lib/chatDirectories';
import type { SettingsSearchItem } from './search';

export const SESSION_DEFAULTS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'sessions.default-model',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.defaultModel',
    keywords: ['model', 'provider', 'new sessions', 'thinking', 'reasoning', 'variant'],
  },
  {
    id: 'sessions.fallback-model',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.fallbackModel',
    descriptionKey: 'settings.openchamber.defaults.field.fallbackModelInfo',
    keywords: ['fallback', 'backup', 'usage limit', 'quota', 'rate limit', 'model', 'thinking'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'sessions.rate-gate-requests',
    page: 'sessions',
    titleKey: 'settings.openchamber.rateGate.requests',
    descriptionKey: 'settings.openchamber.rateGate.requestsInfo',
    keywords: ['rate limit', 'throttle', 'requests', 'window', 'gateway', 'quota', 'model requests'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'sessions.rate-gate-window',
    page: 'sessions',
    titleKey: 'settings.openchamber.rateGate.window',
    descriptionKey: 'settings.openchamber.rateGate.windowInfo',
    keywords: ['rate limit', 'throttle', 'window', 'minutes', 'gateway', 'quota'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'sessions.rate-gate-gateways',
    page: 'sessions',
    titleKey: 'settings.openchamber.rateGate.gateways',
    descriptionKey: 'settings.openchamber.rateGate.gatewaysSyntax',
    keywords: ['rate limit', 'throttle', 'gateway', 'gateways', 'address', 'url', 'quota'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'sessions.default-agent',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.defaultAgent',
    keywords: ['agent', 'new sessions'],
  },
  {
    id: 'sessions.chats-default-model',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.chatsDefaultModel',
    keywords: ['chats', 'chat', 'model', 'provider', 'thinking', 'reasoning', 'variant', 'no project'],
    isAvailable: (ctx) => !ctx.isVSCode && getChatsRoot() !== null,
  },
  {
    id: 'sessions.chats-default-agent',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.chatsDefaultAgent',
    keywords: ['chats', 'chat', 'agent', 'no project'],
    isAvailable: (ctx) => !ctx.isVSCode && getChatsRoot() !== null,
  },
];
