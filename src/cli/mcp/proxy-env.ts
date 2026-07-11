/**
 * Local HTTP/SOCKS proxies must not intercept Tailscale Funnel / MagicDNS or
 * loopback controller surfaces. Bun fetch does not honor `*.ts.net` wildcards;
 * leading-dot forms (`.ts.net`) are required for reliable bypass.
 */
export const DIRECT_NETWORK_NO_PROXY_ENTRIES = [
  '127.0.0.1',
  'localhost',
  '::1',
  '.local',
  '.ts.net',
  '*.ts.net',
  '.tailscale.com',
  '*.tailscale.com',
  '100.64.0.0/10',
] as const;

export function mergeNoProxy(...parts: Array<string | undefined | null>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const entry of part.split(',').map((item) => item.trim()).filter(Boolean)) {
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out.join(',');
}

/**
 * Return a copy of `env` with NO_PROXY/no_proxy extended so local MCP, Tailscale
 * Funnel, and MagicDNS health probes never go through a system HTTP proxy.
 */
export function withDirectNetworkProxyBypass(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = mergeNoProxy(
    env.NO_PROXY,
    env.no_proxy,
    ...DIRECT_NETWORK_NO_PROXY_ENTRIES,
  );
  return {
    ...env,
    NO_PROXY: merged,
    no_proxy: merged,
  };
}

/**
 * Mutate the current process env in place (keepalive/supervisor long-running paths).
 */
export function applyDirectNetworkProxyBypass(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = withDirectNetworkProxyBypass(env);
  env.NO_PROXY = next.NO_PROXY;
  env.no_proxy = next.no_proxy;
  return env;
}
