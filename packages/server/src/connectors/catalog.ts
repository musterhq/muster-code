/**
 * Connector types the registry knows. New types plug in here. Types marked coming-soon can be registered (so a gateway.json import
 * keeps them) but never start and never report success: their health is `unsupported` with the reason.
 */
import { MattermostAdapter } from './mattermost.ts';
import { SlackAdapter } from './slack.ts';
import { TelegramAdapter } from './telegram.ts';
import type { ConnectorType } from './types.ts';

const COMMON_CONFIG = ['defaultProjectId', 'defaultAgentId', 'defaultMode', 'guestPolicy', 'requireLink', 'provider', 'model', 'pingIntervalMs', 'pongTimeoutMs'] as const;
const comingSoon = (type: string, label: string, note: string): ConnectorType => ({ type, label, status: 'coming-soon', modes: ['webhook'], secrets: () => [], configKeys: COMMON_CONFIG, note });

export const CONNECTOR_TYPES: Record<string, ConnectorType> = {
  slack: {
    type: 'slack', label: 'Slack', status: 'available', modes: ['socket', 'events'],
    secrets: mode => mode === 'events' ? ['botToken', 'signingSecret'] : ['botToken', 'appToken'],
    configKeys: [...COMMON_CONFIG, 'apiBase'], create: ctx => new SlackAdapter(ctx),
  },
  telegram: {
    type: 'telegram', label: 'Telegram', status: 'available', modes: ['poll', 'webhook'],
    secrets: mode => mode === 'webhook' ? ['botToken', 'webhookSecret'] : ['botToken'],
    configKeys: [...COMMON_CONFIG, 'apiBase', 'pollTimeoutSec'], create: ctx => new TelegramAdapter(ctx),
  },
  mattermost: {
    type: 'mattermost', label: 'Mattermost', status: 'available', modes: ['websocket'],
    secrets: () => ['botToken'], configKeys: [...COMMON_CONFIG, 'url'], create: ctx => new MattermostAdapter(ctx),
  },
  whatsapp: comingSoon('whatsapp', 'WhatsApp', 'Coming soon. The Muster CLI gateway has WhatsApp (Baileys and Cloud API) adapters; they are being ported to the registry.'),
  discord: comingSoon('discord', 'Discord', 'Coming soon. Use `muster gateway` from the Muster CLI for Discord today.'),
  teams: comingSoon('teams', 'Microsoft Teams', 'Coming soon. Use `muster gateway` from the Muster CLI for Teams today.'),
  gchat: comingSoon('gchat', 'Google Chat', 'Coming soon. Use `muster gateway` from the Muster CLI for Google Chat today.'),
  email: comingSoon('email', 'Email (IMAP/SMTP)', 'Coming soon.'),
};
export const connectorType = (type: string): ConnectorType | undefined => CONNECTOR_TYPES[type];
