import { localBridgeDashboardHtml as renderDashboardTemplate } from "./dashboard-template";

function decodeDisplayUnicode(value: string): string {
  return value.replace(/\\u(?!003c)([0-9a-fA-F]{4})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

export function localBridgeDashboardHtml(token: string): string {
  return decodeDisplayUnicode(renderDashboardTemplate(token));
}
